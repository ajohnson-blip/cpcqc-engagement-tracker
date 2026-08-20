/**
 * Open, move, or close an interest-form window.
 *
 * Windows live in `enrollment_windows` and there is no staff UI for them, so
 * this is the supported way to open one — including the real 2027 window in
 * September, not just test years.
 *
 * A window is what makes the public form accept submissions, so treat this as
 * an outward-facing change: while open, anyone with the link can submit.
 *
 * Usage:
 *   npm run set-window -- --year=2028 --opens=2026-08-01 --closes=2026-12-31
 *   npm run set-window -- --year=2028 --delete
 *
 * Against production, prefix NODE_ENV=production and DATABASE_URL — the pool
 * only enables TLS in production, and Render's external endpoint requires it.
 */
import 'dotenv/config';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';

function arg(name: string): string | undefined {
  const m = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return m?.split('=').slice(1).join('=');
}
const has = (name: string) => process.argv.slice(2).includes(`--${name}`);

const ISO = /^\d{4}-\d{2}-\d{2}$/;

async function main() {
  const year = Number(arg('year'));
  if (!Number.isInteger(year)) {
    throw new Error('Usage: --year=2028 --opens=YYYY-MM-DD --closes=YYYY-MM-DD  (or --delete)');
  }

  const existing = await db.query.enrollmentWindows.findFirst({
    where: eq(schema.enrollmentWindows.programYear, year),
  });

  if (has('delete')) {
    if (!existing) {
      console.log(`No window for ${year}; nothing to delete.`);
      return;
    }
    await db.delete(schema.enrollmentWindows).where(eq(schema.enrollmentWindows.programYear, year));
    console.log(`Deleted the ${year} window (was ${existing.opensAt} → ${existing.closesAt}).`);
    return;
  }

  const opens = arg('opens');
  const closes = arg('closes');
  if (!opens || !ISO.test(opens) || !closes || !ISO.test(closes)) {
    throw new Error('--opens and --closes must both be YYYY-MM-DD.');
  }
  if (closes < opens) throw new Error('--closes cannot be before --opens.');

  if (existing) {
    await db
      .update(schema.enrollmentWindows)
      .set({ opensAt: opens, closesAt: closes, updatedAt: new Date() })
      .where(eq(schema.enrollmentWindows.programYear, year));
    console.log(`Updated ${year}: ${existing.opensAt} → ${existing.closesAt}  becomes  ${opens} → ${closes}`);
  } else {
    await db.insert(schema.enrollmentWindows).values({
      id: uuid(),
      programYear: year,
      opensAt: opens,
      closesAt: closes,
    });
    console.log(`Created ${year}: ${opens} → ${closes}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const state = today < opens ? 'not open yet' : today > closes ? 'closed' : 'OPEN NOW';
  console.log(`As of ${today} this window is: ${state}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
