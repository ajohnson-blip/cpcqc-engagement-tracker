/**
 * Remove a CPCQC staff member's access.
 *
 * The staff UI deliberately refuses this (`POST /staff/users/:id/deactivate` is
 * champions-only), so departures are done here until self-service user
 * management is built after enrollment.
 *
 * This is a soft delete, matching that route: the row stays, `deactivated_at`
 * is set, and live sessions are revoked. Staff accounts are referenced by
 * `audit_log.actor_user_id` and `task_instances.updated_by`, so deleting the
 * row would orphan the record of what that person did.
 *
 * Initiative assignments are dropped too — those drive the "your CPCQC contacts"
 * block hospitals see on their enrollment card, so leaving them would keep
 * showing a departed advisor to hospitals.
 *
 *   NODE_ENV=production DATABASE_URL=… npx tsx scripts/deactivate-staff-account.ts <email> [--apply]
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '../src/db/index.js';

const apply = process.argv.includes('--apply');
const email = process.argv.slice(2).find((a) => !a.startsWith('--'));

async function main() {
  if (!email) {
    console.error('usage: deactivate-staff-account.ts <email> [--apply]');
    process.exit(1);
  }
  console.log(apply ? '== APPLYING ==' : '== DRY RUN — pass --apply to write ==');

  const user = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = lower(${email})`,
  });
  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  if (user.role !== 'cpcqc_staff' && user.role !== 'cpcqc_admin') {
    console.error(
      `${user.email} is ${user.role}, not CPCQC staff. Hospital champions are removed ` +
        'through the staff UI, which keeps their hospital grants consistent.',
    );
    process.exit(1);
  }

  const assignments = await db
    .select({
      id: schema.staffInitiativeAssignments.id,
      code: schema.initiatives.code,
      staffRole: schema.staffInitiativeAssignments.staffRole,
    })
    .from(schema.staffInitiativeAssignments)
    .innerJoin(
      schema.initiatives,
      eq(schema.initiatives.id, schema.staffInitiativeAssignments.initiativeId),
    )
    .where(eq(schema.staffInitiativeAssignments.userId, user.id));

  const [{ sessions }] = await db
    .select({ sessions: sql<number>`count(*)::int` })
    .from(schema.refreshTokens)
    .where(and(eq(schema.refreshTokens.userId, user.id), isNull(schema.refreshTokens.revokedAt)));

  console.log(`\n${user.firstName} ${user.lastName} <${user.email}> (${user.role})`);
  console.log(`  already deactivated: ${user.deactivatedAt ? user.deactivatedAt.toISOString() : 'no'}`);
  console.log(`  assignments to remove: ${assignments.map((a) => `${a.code}/${a.staffRole}`).join(', ') || 'none'}`);
  console.log(`  live sessions to revoke: ${sessions}`);

  if (!apply) {
    process.exit(0);
  }

  const now = new Date();

  for (const a of assignments) {
    await db
      .delete(schema.staffInitiativeAssignments)
      .where(eq(schema.staffInitiativeAssignments.id, a.id));
    await db.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId: null,
      actorRole: 'cpcqc_admin',
      action: 'staff_assignment.remove',
      entityType: 'user',
      entityId: user.id,
      diff: { initiative: a.code, staffRole: a.staffRole },
      note: `${user.email} removed as ${a.staffRole} for ${a.code} (left CPCQC).`,
    });
  }

  if (!user.deactivatedAt) {
    await db
      .update(schema.users)
      .set({ deactivatedAt: now, updatedAt: now })
      .where(eq(schema.users.id, user.id));
    await db.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId: null,
      actorRole: 'cpcqc_admin',
      action: 'user.deactivate',
      entityType: 'user',
      entityId: user.id,
      diff: { deactivatedAt: { from: null, to: now.toISOString() } },
      note: `CPCQC staff account ${user.email} deactivated. History retained.`,
    });
  }

  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(schema.refreshTokens.userId, user.id), isNull(schema.refreshTokens.revokedAt)));

  const after = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
  const [{ live }] = await db
    .select({ live: sql<number>`count(*)::int` })
    .from(schema.refreshTokens)
    .where(and(eq(schema.refreshTokens.userId, user.id), isNull(schema.refreshTokens.revokedAt)));
  const [{ left }] = await db
    .select({ left: sql<number>`count(*)::int` })
    .from(schema.staffInitiativeAssignments)
    .where(eq(schema.staffInitiativeAssignments.userId, user.id));

  console.log('\napplied. verification:', {
    deactivatedAt: after?.deactivatedAt?.toISOString() ?? null,
    liveSessions: live,
    assignmentsLeft: left,
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
