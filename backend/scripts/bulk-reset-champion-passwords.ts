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
 * left alone. Idempotent in spirit — re-running re-onboards only those still
 * un-activated.
 *
 * Usage (from backend/, prod env):
 *   NODE_ENV=production DATABASE_URL=... SENDGRID_API_KEY=... \
 *     npx tsx scripts/bulk-reset-champion-passwords.ts
 *   ... add --dry-run to list targets without sending anything.
 */
import 'dotenv/config';
import { and, inArray, isNull } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { resetPasswordAndEmail } from '../src/modules/staff/champion-accounts.service.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Onboarding un-activated champions${dryRun ? ' (DRY RUN)' : ''}…\n`);

  const targets = await db
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

  // eslint-disable-next-line no-console
  console.log(`${targets.length} un-activated hospital champion(s) found.\n`);

  if (dryRun) {
    for (const t of targets) console.log(`  ${t.email}`);
    console.log('\n(dry run — no passwords reset, no emails sent)');
    return;
  }

  let emailed = 0;
  const failures: Array<{ email: string; tempPassword: string | null }> = [];
  for (const t of targets) {
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

  // eslint-disable-next-line no-console
  console.log(
    `\nDone. Emailed ${emailed}/${targets.length}. ${failures.length} not delivered.`,
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
