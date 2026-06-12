/**
 * Champion account credentials — shared email + password-reset logic used by:
 *   - new-champion creation (reason 'welcome')
 *   - the one-time onboarding of accounts created before email worked
 *     (reason 'onboarding')
 *   - per-user password reset / recovery (reason 'reset')
 *
 * Keeps the credentials email body in one place so the three flows stay
 * consistent, and centralizes the "generate temp password, rehash, revoke
 * old sessions, email it" sequence.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { generateTempPassword, hashPassword } from '@/modules/auth/auth.service.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';

export type CredentialsReason = 'welcome' | 'onboarding' | 'reset';

/** Frontend sign-in URL — CORS_ORIGIN is the frontend base (first if a list). */
export function loginUrl(): string {
  const base = env.CORS_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '');
  return `${base}/login`;
}

interface CredentialsEmailParams {
  firstName: string;
  hospitalName: string;
  email: string;
  tempPassword: string;
  url: string;
  reason: CredentialsReason;
}

export function credentialsEmail(p: CredentialsEmailParams): {
  subject: string;
  body: string;
} {
  const subject =
    p.reason === 'reset'
      ? 'Your CPCQC Engagement Tracker password was reset'
      : 'Your CPCQC Engagement Tracker account';

  // Lead paragraph explains *why* they're getting this message now.
  const intro =
    p.reason === 'welcome'
      ? `A CPCQC program manager has set up your account for the Engagement Tracker — ` +
        `the dashboard where ${p.hospitalName} tracks its perinatal QI engagement.`
      : p.reason === 'onboarding'
        ? `The CPCQC Engagement Tracker is now live — the dashboard where ${p.hospitalName} ` +
          `tracks its perinatal QI engagement. Your account was created earlier; now that the ` +
          `platform is ready, we're sending the sign-in details you'll need to get started. ` +
          `(If you've been expecting this, this is it — there's nothing you missed.)`
        : `Your CPCQC Engagement Tracker password has been reset by a CPCQC program manager. ` +
          `Use the temporary password below to sign back in.`;

  const changeLine =
    p.reason === 'reset'
      ? `Please choose a new password right after you sign in (Account → Change password).`
      : `Please change your password right after your first sign-in (Account → Change ` +
        `password). The temporary password above is for first-time access only.`;

  const body =
    `Hi ${p.firstName},\n\n` +
    `${intro}\n\n` +
    `Sign in here: ${p.url}\n` +
    `  Email:    ${p.email}\n` +
    `  Password: ${p.tempPassword}\n\n` +
    `${changeLine}\n\n` +
    `Questions? qi@cpcqc.org`;

  return { subject, body };
}

/**
 * Reset a hospital user's password to a fresh temp value, revoke their old
 * sessions, and email them the new credentials. Returns whether the email
 * sent; when it didn't (dev / delivery failure) the plaintext is returned so
 * the caller can surface it for manual relay.
 */
export async function resetPasswordAndEmail(
  userId: string,
  reason: CredentialsReason,
): Promise<{ emailed: boolean; tempPassword: string | null; email: string; url: string }> {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new HttpError(404, 'User not found');
  if (user.role !== 'hospital_user' && user.role !== 'hospital_admin') {
    throw new HttpError(400, 'Only hospital user accounts can be reset here.');
  }
  const hospital = user.hospitalId
    ? await db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, user.hospitalId) })
    : null;

  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const now = new Date();
  await db
    .update(schema.users)
    .set({ passwordHash, updatedAt: now })
    .where(eq(schema.users.id, userId));
  // Revoke any live sessions so an old password / token can't linger.
  await db
    .update(schema.refreshTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(eq(schema.refreshTokens.userId, userId), isNull(schema.refreshTokens.revokedAt)),
    );

  const url = loginUrl();
  const { subject, body } = credentialsEmail({
    firstName: user.firstName ?? 'there',
    hospitalName: hospital?.name ?? 'your hospital',
    email: user.email,
    tempPassword,
    url,
    reason,
  });
  const result = await sendEmail({
    toEmail: user.email,
    subject,
    kind: `champion.${reason}`,
    userId: user.id,
    body,
  });

  return {
    emailed: result.sent,
    tempPassword: result.sent ? null : tempPassword,
    email: user.email,
    url,
  };
}
