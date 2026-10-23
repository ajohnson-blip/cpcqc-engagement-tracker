/**
 * CPCQC staff accounts — the admin-only "Add staff member" flow that replaces
 * running scripts/create-cpcqc-staff.ts by hand.
 *
 * Removing someone is a soft delete — see deactivateStaffAccount.
 *
 * Unlike champion accounts, staff never receive a password. A new account is
 * created with a random one nobody knows, and the person chooses their own
 * through a one-time setup link: the password-reset mechanism with a longer
 * expiry. The admin handles a credential only if the email cannot be sent,
 * when the link is returned once so they can pass it on.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { frontendBaseUrl } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { hashPassword, issuePasswordResetToken } from '@/modules/auth/auth.service.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import { loginUrl } from './champion-accounts.service.js';
import {
  staffSetupEmail,
  type AssignmentRole,
  type InitiativeCode,
} from './staff-setup-email.js';

/** A new starter may not open the email the day it is sent. */
export const STAFF_SETUP_TTL_DAYS = 7;

export const STAFF_APP_ROLES = ['cpcqc_staff', 'cpcqc_admin'] as const;
export type StaffAppRole = (typeof STAFF_APP_ROLES)[number];

export interface StaffAssignment {
  initiativeCode: InitiativeCode;
  role: AssignmentRole;
}

export interface StaffAccount {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  role: StaffAppRole;
  active: boolean;
  assignments: StaffAssignment[];
  createdAt: string;
}

export interface SetupLinkResult {
  emailed: boolean;
  /** Returned only when the email could not be sent, for the admin to pass on. */
  setupUrl: string | null;
  expiresInDays: number;
}

export async function listStaffAccounts(): Promise<StaffAccount[]> {
  const users = await db
    .select()
    .from(schema.users)
    .where(inArray(schema.users.role, [...STAFF_APP_ROLES]));
  if (users.length === 0) return [];

  const rows = await db
    .select({
      userId: schema.staffInitiativeAssignments.userId,
      code: schema.initiatives.code,
      role: schema.staffInitiativeAssignments.staffRole,
    })
    .from(schema.staffInitiativeAssignments)
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.staffInitiativeAssignments.initiativeId))
    .where(inArray(schema.staffInitiativeAssignments.userId, users.map((u) => u.id)));
  const byUser = new Map<string, StaffAssignment[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ initiativeCode: r.code as InitiativeCode, role: r.role as AssignmentRole });
    byUser.set(r.userId, list);
  }

  return users
    .map((u) => ({
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: u.email,
      role: u.role as StaffAppRole,
      active: u.deactivatedAt == null,
      assignments: (byUser.get(u.id) ?? []).sort(
        (a, b) => a.initiativeCode.localeCompare(b.initiativeCode) || a.role.localeCompare(b.role),
      ),
      createdAt: u.createdAt.toISOString(),
    }))
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        `${a.lastName ?? ''} ${a.firstName ?? ''}`.localeCompare(`${b.lastName ?? ''} ${b.firstName ?? ''}`),
    );
}

async function displayName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!u) return null;
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email;
}

export async function createStaffAccount(
  input: {
    firstName: string;
    lastName?: string;
    email: string;
    role: StaffAppRole;
    assignments: StaffAssignment[];
  },
  actorUserId: string | null,
): Promise<{ account: StaffAccount } & SetupLinkResult> {
  const email = input.email.trim().toLowerCase();

  // Friendly pre-check; the unique index on lower(email) is the backstop.
  const existing = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = ${email}`,
  });
  if (existing) {
    throw new HttpError(
      409,
      existing.role.startsWith('cpcqc')
        ? 'A staff account with that email already exists. Send them a setup link from the list instead.'
        : 'That email belongs to a hospital account. Staff need their own CPCQC address.',
    );
  }

  // One row per (initiative, role), however the form was filled in.
  const assignments = [
    ...new Map(input.assignments.map((a) => [`${a.initiativeCode}:${a.role}`, a])).values(),
  ];
  const initiatives = await db.select().from(schema.initiatives);
  const initiativeId = new Map(initiatives.map((i) => [i.code, i.id]));
  for (const a of assignments) {
    if (!initiativeId.has(a.initiativeCode)) throw new HttpError(400, `Unknown initiative ${a.initiativeCode}.`);
  }

  const id = uuid();
  // A password nobody knows, including the admin; the setup link is the way in.
  const passwordHash = await hashPassword(randomBytes(18).toString('base64url'));
  await db.transaction(async (tx) => {
    await tx.insert(schema.users).values({
      id,
      email,
      passwordHash,
      firstName: input.firstName.trim(),
      lastName: input.lastName?.trim() || null,
      role: input.role,
    });
    if (assignments.length) {
      await tx.insert(schema.staffInitiativeAssignments).values(
        assignments.map((a) => ({
          id: uuid(),
          userId: id,
          initiativeId: initiativeId.get(a.initiativeCode)!,
          staffRole: a.role,
        })),
      );
    }
    await tx.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId,
      actorRole: 'cpcqc_admin',
      action: 'staff.account_created',
      entityType: 'user',
      entityId: id,
      diff: { email, role: input.role, assignments },
      note: `Created staff account for ${email} (${input.role}).`,
    });
  });

  const link = await sendStaffSetupLink(id, actorUserId, 'welcome');
  const account = (await listStaffAccounts()).find((a) => a.id === id)!;
  return { account, ...link };
}

/**
 * Email a staff member a link to choose their password — on creation, or later
 * if the first link expired or went astray. Earlier links stay valid until they
 * expire or are used; a password can only be set once per link.
 */
export async function sendStaffSetupLink(
  userId: string,
  actorUserId: string | null,
  reason: 'welcome' | 'resend' = 'resend',
): Promise<SetupLinkResult> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'Staff member not found.');
  if (!user.role.startsWith('cpcqc')) {
    throw new HttpError(400, 'Only CPCQC staff accounts get setup links here.');
  }
  if (user.deactivatedAt) throw new HttpError(400, 'That account is deactivated.');

  const assignmentRows = await db
    .select({ code: schema.initiatives.code, role: schema.staffInitiativeAssignments.staffRole })
    .from(schema.staffInitiativeAssignments)
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.staffInitiativeAssignments.initiativeId))
    .where(eq(schema.staffInitiativeAssignments.userId, userId));

  const token = await issuePasswordResetToken(userId, STAFF_SETUP_TTL_DAYS * 24 * 60);
  const setupUrl = `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(token)}&setup=1`;
  const { subject, body } = staffSetupEmail({
    firstName: user.firstName ?? 'there',
    email: user.email,
    setupUrl,
    loginUrl: loginUrl(),
    expiresInDays: STAFF_SETUP_TTL_DAYS,
    addedBy: await displayName(actorUserId),
    admin: user.role === 'cpcqc_admin',
    assignments: assignmentRows.map((r) => ({
      initiativeCode: r.code as InitiativeCode,
      role: r.role as AssignmentRole,
    })),
    reason,
  });
  const result = await sendEmail({
    toEmail: user.email,
    subject,
    body,
    kind: 'staff.setup',
    userId,
    // The link is as good as a password until it is used or expires.
    redact: [setupUrl],
  });

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId,
    actorRole: 'cpcqc_admin',
    action: 'staff.setup_link_sent',
    entityType: 'user',
    entityId: userId,
    diff: { emailed: result.sent, expiresInDays: STAFF_SETUP_TTL_DAYS },
    note: result.sent
      ? `Emailed a password setup link to ${user.email}.`
      : `Setup link for ${user.email} could not be emailed; shown to the admin to pass on.`,
  });

  return { emailed: result.sent, setupUrl: result.sent ? null : setupUrl, expiresInDays: STAFF_SETUP_TTL_DAYS };
}

/**
 * Remove a staff member's access: the admin-facing version of
 * scripts/deactivate-staff-account.ts, with the same effects.
 *
 * A soft delete. The row stays and `deactivated_at` is set, because staff are
 * referenced by the audit log and by task history, and deleting them would
 * orphan the record of what they did. Their initiative roles are removed, since
 * those drive the "your CPCQC contacts" block hospitals see, and their saved
 * sign-ins are revoked. An access token already issued keeps working until it
 * expires (at most JWT_ACCESS_TTL_SECONDS), as for any sign-out.
 *
 * Refuses to remove the acting admin, and the last active admin — either would
 * leave nobody able to manage staff.
 */
export async function deactivateStaffAccount(
  userId: string,
  actorUserId: string | null,
): Promise<{ removedRoles: StaffAssignment[]; sessionsRevoked: number }> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'Staff member not found.');
  if (!user.role.startsWith('cpcqc')) {
    throw new HttpError(400, 'Only CPCQC staff accounts are removed here. Hospital champions are removed under Access.');
  }
  if (user.deactivatedAt) throw new HttpError(409, 'That account is already deactivated.');
  if (userId === actorUserId) throw new HttpError(400, "You can't remove your own account. Ask another admin.");
  if (user.role === 'cpcqc_admin') {
    const [{ admins }] = await db
      .select({ admins: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'cpcqc_admin'), isNull(schema.users.deactivatedAt)));
    if (admins <= 1) throw new HttpError(400, "That is the only active admin, so they can't be removed.");
  }

  const assignments = await db
    .select({
      id: schema.staffInitiativeAssignments.id,
      code: schema.initiatives.code,
      role: schema.staffInitiativeAssignments.staffRole,
    })
    .from(schema.staffInitiativeAssignments)
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.staffInitiativeAssignments.initiativeId))
    .where(eq(schema.staffInitiativeAssignments.userId, userId));

  const now = new Date();
  let sessionsRevoked = 0;
  await db.transaction(async (tx) => {
    for (const a of assignments) {
      await tx.delete(schema.staffInitiativeAssignments).where(eq(schema.staffInitiativeAssignments.id, a.id));
      await tx.insert(schema.auditLog).values({
        id: uuid(),
        actorUserId,
        actorRole: 'cpcqc_admin',
        action: 'staff_assignment.remove',
        entityType: 'user',
        entityId: userId,
        diff: { initiative: a.code, staffRole: a.role },
        note: `${user.email} removed as ${a.role} for ${a.code} (account removed).`,
      });
    }
    await tx.update(schema.users).set({ deactivatedAt: now, updatedAt: now }).where(eq(schema.users.id, userId));
    const revoked = await tx
      .update(schema.refreshTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt)))
      .returning({ id: schema.refreshTokens.id });
    sessionsRevoked = revoked.length;
    await tx.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId,
      actorRole: 'cpcqc_admin',
      action: 'user.deactivate',
      entityType: 'user',
      entityId: userId,
      diff: { deactivatedAt: { from: null, to: now.toISOString() }, sessionsRevoked },
      note: `CPCQC staff account ${user.email} removed by an admin. History retained.`,
    });
  });

  return {
    removedRoles: assignments.map((a) => ({
      initiativeCode: a.code as InitiativeCode,
      role: a.role as AssignmentRole,
    })),
    sessionsRevoked,
  };
}
