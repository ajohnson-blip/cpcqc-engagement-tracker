/**
 * One-time onboarding: reset + email login credentials to hospital champions
 * who have never signed in.
 *
 * Why: the initial ~196 accounts were bulk-created before the email provider
 * existed, so their credentials were only ever written to a CSV — those
 * champions never received an email. Now that outbound email works, this
 * emails each un-activated champion a fresh temp password with copy
 * explaining why they're getting it now (reason = 'onboarding').
 *
 * Targets hospital_user / hospital_admin accounts with last_login_at IS NULL,
 * so anyone who has already signed in (and likely set their own password) is
 * left alone.
 *
 * BATCHED for daily email quotas (SendGrid free tier = 100/day): each run
 * sends at most --limit (default 90) emails, and SKIPS champions who already
 * received a successfully-sent onboarding email (tracked via the notifications
 * table). So you run it once per day until everyone's onboarded — re-runs
 * resume where you left off and never double-send. Crucially, a champion's
 * password is only reset when we're about to email them, so un-batched
 * champions keep their existing (CSV) credentials until their turn.
 *
 * Usage (from backend/, prod env — Render Shell has the vars already):
 *   npx tsx scripts/bulk-reset-champion-passwords.ts --dry-run     # preview batch
 *   npx tsx scripts/bulk-reset-champion-passwords.ts               # send up to 90
 *   npx tsx scripts/bulk-reset-champion-passwords.ts --limit=50    # custom cap
 */
import 'dotenv/config';
import { and, eq, inArray, isNull, isNotNull } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { resetPasswordAndEmail } from '../src/modules/staff/champion-accounts.service.js';

const dryRun = process.argv.includes('--dry-run');

// Per-run cap so we don't blow past the email provider's daily quota
// (SendGrid free tier = 100/day). Default leaves headroom for test sends and
// other app email. Override with --limit=N. Run again the next day to send the
// next batch — already-onboarded champions are skipped, so it resumes cleanly.
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
  console.log(
    `Onboarding un-activated champions${dryRun ? ' (DRY RUN)' : ''} — batch limit ${limit}…\n`,
  );

  // Un-activated hospital champions (never signed in).
  const candidates = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(
      and(
        inArray(schema.users.role, ['hospital_user', 'hospital_admin'] as const),
        isNull(schema.users.lastLoginAt),
        isNull(schema.users.deactivatedAt),
      ),
    )
    .orderBy(schema.users.email);

  // Exclude anyone who already got a successfully-sent onboarding email, so
  // re-runs across days don't re-email (or re-reset) the same people.
  const alreadyRows = await db
    .select({ userId: schema.notifications.userId })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.kind, 'champion.onboarding'),
        isNotNull(schema.notifications.sentAt),
      ),
    );
  const already = new Set(alreadyRows.map((r) => r.userId).filter(Boolean) as string[]);

  const pending = candidates.filter((c) => !already.has(c.id));
  const batch = pending.slice(0, limit);

  // eslint-disable-next-line no-console
  console.log(
    `${candidates.length} un-activated · ${already.size} already onboarded · ` +
      `${pending.length} still pending · sending ${batch.length} this run.\n`,
  );

  if (dryRun) {
    for (const t of batch) console.log(`  ${t.email}`);
    const remaining = pending.length - batch.length;
    console.log(
      `\n(dry run — nothing sent. ${remaining} would remain for the next run.)`,
    );
    return;
  }

  let emailed = 0;
  const failures: Array<{ email: string; tempPassword: string | null }> = [];
  for (const t of batch) {
    try {
      const r = await resetPasswordAndEmail(t.id, 'onboarding');
      if (r.emailed) {
        emailed += 1;
      } else {
        // Email didn't go out — capture the temp password so it can be
        // relayed manually instead of locking the champion out.
        failures.push({ email: t.email, tempPassword: r.tempPassword });
      }
    } catch (err) {
      failures.push({ email: t.email, tempPassword: null });
      // eslint-disable-next-line no-console
      console.error(`  ! ${t.email}:`, err instanceof Error ? err.message : err);
    }
  }

  const remaining = pending.length - batch.length;
  // eslint-disable-next-line no-console
  console.log(
    `\nDone. Emailed ${emailed}/${batch.length} this run. ` +
      `${failures.length} not delivered. ${remaining} still pending — ` +
      `${remaining > 0 ? 'run again (e.g. tomorrow) to send the next batch.' : 'all champions onboarded. 🎉'}`,
  );
  if (failures.length) {
    // eslint-disable-next-line no-console
    console.log(
      '\nNot delivered (relay these manually — temp passwords were still set):',
    );
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.log(`  ${f.email}  ${f.tempPassword ?? '(reset failed — re-run)'}`);
    }
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
