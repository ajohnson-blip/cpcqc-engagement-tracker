/**
 * Bulk-create the CPCQC staff accounts and initiative-role assignments.
 *
 * Staff fall into two buckets:
 *   1. Initiative leads — Program Managers and QI Advisors who run a specific
 *      initiative. They get `cpcqc_staff` role plus one or more rows in
 *      staff_initiative_assignments tagging them as PM/QI Advisor for that
 *      initiative (dual roles get two rows).
 *   2. Cross-org leadership — people like the Deputy Director of QI or the
 *      Data Program Manager who span all four initiatives and aren't a
 *      hospital's named point person for any single one. These get no
 *      initiative assignments; the Deputy Director gets `cpcqc_admin` so she
 *      can manage settings, the data lead gets standard `cpcqc_staff`.
 *
 * Idempotent: existing users are detected by email and updated rather than
 * duplicated; existing assignments are detected by (user, initiative, role).
 *
 * Each new account starts with the same temporary password — they should
 * change it on first login (account-settings page coming next).
 *
 * Usage:
 *   npm run create-cpcqc-staff
 */
import 'dotenv/config';
import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema, pool } from '../src/db/index.js';
import { hashPassword } from '../src/modules/auth/auth.service.js';

const TEMP_PASSWORD = 'Welcome2026!cpcqc';

type AppRole = 'cpcqc_staff' | 'cpcqc_admin';

interface StaffSeed {
  email: string;
  firstName: string;
  lastName: string;
  /** Defaults to `cpcqc_staff`. Use `cpcqc_admin` for org leadership. */
  role?: AppRole;
  /** Free-text job title — shown to admins, useful for cross-org folks. */
  title?: string;
  /** (initiative code, role) pairs. Empty for cross-org leadership. */
  assignments: Array<{ initiativeCode: 'TTT' | 'SPARK' | 'SOAR' | 'NEST'; role: 'program_manager' | 'qi_advisor' }>;
}

const STAFF: StaffSeed[] = [
  // SPARK
  { email: 'agates@cpcqc.org', firstName: 'Ashlie', lastName: 'Gates',
    title: 'QI Advisor, SPARK',
    assignments: [{ initiativeCode: 'SPARK', role: 'qi_advisor' }] },
  { email: 'kricard@cpcqc.org', firstName: 'Kari', lastName: 'Ricard',
    title: 'Program Manager, SPARK',
    assignments: [{ initiativeCode: 'SPARK', role: 'program_manager' }] },
  // NEST (Sonia is dual PM + QI Advisor)
  { email: 'ssubudhiwarwick@cpcqc.org', firstName: 'Sonia', lastName: 'Subudhi Warwick',
    title: 'Program Manager & QI Advisor, NEST',
    assignments: [
      { initiativeCode: 'NEST', role: 'program_manager' },
      { initiativeCode: 'NEST', role: 'qi_advisor' },
    ] },
  // SOAR
  { email: 'scomstock@cpcqc.org', firstName: 'Sydney', lastName: 'Comstock',
    title: 'Program Manager, SOAR',
    assignments: [{ initiativeCode: 'SOAR', role: 'program_manager' }] },
  { email: 'jmckoy@cpcqc.org', firstName: 'Jenna', lastName: 'McKoy',
    title: 'QI Advisor, SOAR',
    assignments: [{ initiativeCode: 'SOAR', role: 'qi_advisor' }] },
  // Turning the Tide
  { email: 'sbriley@cpcqc.org', firstName: 'Sarah', lastName: 'Briley',
    title: 'Program Manager, Turning the Tide',
    assignments: [{ initiativeCode: 'TTT', role: 'program_manager' }] },
  { email: 'turningthetide@cpcqc.org', firstName: 'Abby', lastName: 'Alyesh',
    title: 'QI Advisor, Turning the Tide',
    assignments: [{ initiativeCode: 'TTT', role: 'qi_advisor' }] },
  // Cross-org leadership — no initiative-specific assignments.
  { email: 'ebrooks@cpcqc.org', firstName: 'Liz', lastName: 'Brooks',
    role: 'cpcqc_admin',
    title: 'Deputy Director of QI',
    assignments: [] },
  { email: 'sbanchefsky@cpcqc.org', firstName: 'Sarah', lastName: 'Banchefsky',
    title: 'Data Program Manager',
    assignments: [] },
];

async function findOrCreateUser(rec: StaffSeed, passwordHash: string) {
  const appRole: AppRole = rec.role ?? 'cpcqc_staff';
  const existing = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = lower(${rec.email})`,
  });
  if (existing) {
    // Make sure name + role are current
    await db
      .update(schema.users)
      .set({
        firstName: rec.firstName,
        lastName: rec.lastName,
        role: appRole,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, existing.id));
    return { id: existing.id, created: false, appRole };
  }
  const id = uuid();
  await db.insert(schema.users).values({
    id,
    email: rec.email,
    passwordHash,
    firstName: rec.firstName,
    lastName: rec.lastName,
    role: appRole,
  });
  return { id, created: true, appRole };
}

async function upsertAssignment(userId: string, initiativeId: string, role: 'program_manager' | 'qi_advisor') {
  const existing = await db.query.staffInitiativeAssignments.findFirst({
    where: and(
      eq(schema.staffInitiativeAssignments.userId, userId),
      eq(schema.staffInitiativeAssignments.initiativeId, initiativeId),
      eq(schema.staffInitiativeAssignments.staffRole, role),
    ),
  });
  if (existing) return false;
  await db.insert(schema.staffInitiativeAssignments).values({
    id: uuid(),
    userId,
    initiativeId,
    staffRole: role,
  });
  return true;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`Creating CPCQC staff accounts (temp password = "${TEMP_PASSWORD}")…`);

  const initiatives = await db.select().from(schema.initiatives);
  const byCode = new Map(initiatives.map((i) => [i.code, i.id]));
  if (byCode.size === 0) {
    // eslint-disable-next-line no-console
    console.error('No initiatives in DB. Run db:seed first.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(TEMP_PASSWORD);
  const summary: Array<{
    name: string;
    email: string;
    appRole: AppRole;
    assignments: string;
    created: boolean;
  }> = [];

  for (const rec of STAFF) {
    const user = await findOrCreateUser(rec, passwordHash);
    const labels: string[] = [];
    for (const a of rec.assignments) {
      const initiativeId = byCode.get(a.initiativeCode);
      if (!initiativeId) continue;
      await upsertAssignment(user.id, initiativeId, a.role);
      labels.push(`${a.initiativeCode} (${a.role === 'program_manager' ? 'PM' : 'QI Advisor'})`);
    }
    summary.push({
      name: `${rec.firstName} ${rec.lastName}`,
      email: rec.email,
      appRole: user.appRole,
      assignments: labels.length ? labels.join(', ') : rec.title ?? '(cross-org)',
      created: user.created,
    });
  }

  // eslint-disable-next-line no-console
  console.log('\nResults:');
  // eslint-disable-next-line no-console
  console.log(
    `  ${'Status'.padEnd(8)} ${'Name'.padEnd(28)} ${'Email'.padEnd(32)} ${'Role'.padEnd(12)} Assignments / Title`,
  );
  for (const s of summary) {
    // eslint-disable-next-line no-console
    console.log(
      `  ${(s.created ? 'CREATED' : 'updated').padEnd(8)} ${s.name.padEnd(28)} ${s.email.padEnd(32)} ${s.appRole.padEnd(12)} ${s.assignments}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nAll accounts use the temp password: ${TEMP_PASSWORD}\n` +
      'Have each staff member sign in and change it on first use (account settings page coming next).',
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    pool.end();
    process.exit(1);
  });
