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
 *   npm run set-window -- --year=2028 --enrollment-opens=2026-08-01 --enrollment-closes=2026-12-31
 *   npm run set-window -- --year=2028 --delete
 *
 * The two steps have separate dates (interest Sep-Oct, enrollment Nov-Dec), so
 * either pair can be set independently; omitting a pair leaves it untouched.
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
  const eOpens = arg('enrollment-opens');
  const eCloses = arg('enrollment-closes');

  const pair = (a?: string, b?: string, label = '') => {
    if (!a && !b) return null;
    if (!a || !ISO.test(a) || !b || !ISO.test(b)) {
      throw new Error(`${label} dates must both be YYYY-MM-DD.`);
    }
    if (b < a) throw new Error(`${label} close cannot be before open.`);
    return { a, b };
  };
  const interest = pair(opens, closes, '--opens/--closes');
  const enrollment = pair(eOpens, eCloses, '--enrollment-opens/--enrollment-closes');
  if (!interest && !enrollment) {
    throw new Error('Give --opens/--closes and/or --enrollment-opens/--enrollment-closes.');
  }

  if (existing) {
    await db
      .update(schema.enrollmentWindows)
      .set({
        ...(interest ? { opensAt: interest.a, closesAt: interest.b } : {}),
        ...(enrollment ? { enrollmentOpensAt: enrollment.a, enrollmentClosesAt: enrollment.b } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.enrollmentWindows.programYear, year));
    console.log(`Updated ${year}.`);
  } else {
    if (!interest) throw new Error('A new year needs --opens and --closes for the interest step.');
    await db.insert(schema.enrollmentWindows).values({
      id: uuid(),
      programYear: year,
      opensAt: interest.a,
      closesAt: interest.b,
      enrollmentOpensAt: enrollment?.a ?? null,
      enrollmentClosesAt: enrollment?.b ?? null,
    });
    console.log(`Created ${year}.`);
  }

  const row = await db.query.enrollmentWindows.findFirst({
    where: eq(schema.enrollmentWindows.programYear, year),
  });
  const today = new Date().toISOString().slice(0, 10);
  const describe = (o?: string | null, c?: string | null) =>
    !o || !c ? 'not configured' : `${o} → ${c} (${today < o ? 'not open yet' : today > c ? 'closed' : 'OPEN NOW'})`;
  console.log(`  Interest:   ${describe(row?.opensAt, row?.closesAt)}`);
  console.log(`  Enrollment: ${describe(row?.enrollmentOpensAt, row?.enrollmentClosesAt)}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
