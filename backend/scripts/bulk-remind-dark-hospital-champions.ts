/**
 * Reminder campaign: re-send login credentials to champions at hospitals where
 * NOBODY has signed in yet ("dark" hospitals).
 *
 * Context: the one-time onboarding emails went out, but ~2 weeks later many
 * hospitals still have zero champions signed in. This nudges the teams at those
 * fully-dark hospitals — a hospital is included only if NONE of its champions
 * has ever logged in, so we don't pester teams that already have access.
 *
 * Each recipient is reset to a fresh temp password and emailed (reason
 * 'reminder') — these champions never signed in, so they're still on their
 * unused original credential and have likely lost the first email.
 *
 * BATCHED for the SendGrid free-tier 100/day cap: sends at most --limit
 * (default 90) per run, and SKIPS champions who already received a
 * successfully-sent reminder (tracked via notifications.kind='champion.reminder'),
 * so re-runs resume cleanly and never double-send. A champion's password is only
 * reset when we're about to email them.
 *
 * IMPORTANT: run where SENDGRID_API_KEY is set (Render Shell). Run locally only
 * with --dry-run — without the API key, a real run would reset passwords without
 * actually emailing them.
 *
 * Usage (from backend/):
 *   npx tsx scripts/bulk-remind-dark-hospital-champions.ts --dry-run   # preview
 *   npx tsx scripts/bulk-remind-dark-hospital-champions.ts             # send up to 90
 *   npx tsx scripts/bulk-remind-dark-hospital-champions.ts --limit=50  # custom cap
 */
import 'dotenv/config';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { resetPasswordAndEmail } from '../src/modules/staff/champion-accounts.service.js';

const dryRun = process.argv.includes('--dry-run');

const DEFAULT_LIMIT = 90;
function parseLimit(): number {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  if (!arg) return DEFAULT_LIMIT;
  const n = parseInt(arg.slice('--limit='.length), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT;
}

async function main() {
  const limit = parseLimit();
  // eslint-disable-next-line no-console
  console.log(`Reminder to dark-hospital champions${dryRun ? ' (DRY RUN)' : ''} — batch limit ${limit}…\n`);

  // All active hospital champions with a primary hospital.
  const champs = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      hospitalId: schema.users.hospitalId,
      lastLoginAt: schema.users.lastLoginAt,
    })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.role, ['hospital_user', 'hospital_admin'] as const),
        isNotNull(schema.users.hospitalId),
        isNull(schema.users.deactivatedAt),
      ),
    );

  const active = champs.filter((c): c is typeof c & { hospitalId: string } => c.hospitalId != null);

  // A hospital is "dark" if NONE of its champions has ever logged in.
  const anyLoginByHospital = new Map<string, boolean>();
  for (const c of active) {
    const prev = anyLoginByHospital.get(c.hospitalId!) ?? false;
    anyLoginByHospital.set(c.hospitalId!, prev || c.lastLoginAt != null);
  }
  const darkHospitals = new Set(
    [...anyLoginByHospital.entries()].filter(([, anyLogin]) => !anyLogin).map(([h]) => h),
  );

  // Recipients: champions at dark hospitals who haven't logged in (= all of them).
  const candidates = active
    .filter((c) => darkHospitals.has(c.hospitalId!) && c.lastLoginAt == null)
    .sort((a, b) => a.email.localeCompare(b.email));

  // Skip anyone already sent a reminder, so re-runs resume across days.
  const alreadyRows = await db
    .select({ userId: schema.notifications.userId })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.kind, 'champion.reminder'),
        isNotNull(schema.notifications.sentAt),
      ),
    );
  const already = new Set(alreadyRows.map((r) => r.userId).filter(Boolean) as string[]);

  const pending = candidates.filter((c) => !already.has(c.id));
  const batch = pending.slice(0, limit);

  // eslint-disable-next-line no-console
  console.log(
    `${darkHospitals.size} dark hospitals · ${candidates.length} champions to remind · ` +
      `${already.size} already reminded · ${pending.length} pending · sending ${batch.length} this run.\n`,
  );

  if (dryRun) {
    for (const t of batch) console.log(`  ${t.email}`);
    const remaining = pending.length - batch.length;
    console.log(`\n(dry run — nothing sent. ${remaining} would remain for the next run.)`);
    return;
  }

  let emailed = 0;
  const failures: Array<{ email: string; tempPassword: string | null }> = [];
  for (const t of batch) {
    try {
      const r = await resetPasswordAndEmail(t.id, 'reminder');
      if (r.emailed) emailed += 1;
      else failures.push({ email: t.email, tempPassword: r.tempPassword });
    } catch (err) {
      failures.push({ email: t.email, tempPassword: null });
      // eslint-disable-next-line no-console
      console.error(`  ! ${t.email}:`, err instanceof Error ? err.message : err);
    }
  }

  const remaining = pending.length - batch.length;
  // eslint-disable-next-line no-console
  console.log(
    `\nDone. Emailed ${emailed}/${batch.length} this run. ${failures.length} not delivered. ` +
      `${remaining} still pending — ${remaining > 0 ? 'run again (e.g. tomorrow) for the next batch.' : 'all dark-hospital champions reminded. 🎉'}`,
  );
  if (failures.length) {
    // eslint-disable-next-line no-console
    console.log('\nNot delivered (relay manually — temp passwords were still set):');
    for (const f of failures) console.log(`  ${f.email}  ${f.tempPassword ?? '(reset failed — re-run)'}`);
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
