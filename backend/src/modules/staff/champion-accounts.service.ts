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

  // Lead paragraph(s) explaining *why* they're getting this message now, an
  // optional change-password line, and a closing — all by reason.
  let intro: string;
  let changeLine: string;
  let closing: string;

  if (p.reason === 'onboarding') {
    // Copy provided by CPCQC for the one-time onboarding of accounts created
    // before email was available. References SB 24-175 / C.R.S. statute.
    intro =
      `The CPCQC Hospital Engagement Tracker has undergone significant improvements. This tool ` +
      `helps your hospital monitor engagement activities and progress toward meeting the ` +
      `requirements of Senate Bill 24-175, codified at C.R.S. § 25-52-106.5(6)(a)(II), which ` +
      `requires all Colorado hospitals with labor and delivery services to participate ` +
      `annually in at least one CPCQC-led quality improvement initiative.\n\n` +
      `With the updated Engagement Tracker now available, we are sending your sign-in ` +
      `information so you can reset your password and access the platform.`;
    changeLine = '';
    closing = `Please reach out to the CPCQC team if you have any questions or need support.`;
  } else if (p.reason === 'welcome') {
    intro =
      `A CPCQC program manager has set up your account for the Engagement Tracker — ` +
      `the dashboard where ${p.hospitalName} tracks its perinatal QI engagement.`;
    changeLine =
      `Please change your password right after your first sign-in (Account → Change ` +
      `password). The temporary password above is for first-time access only.`;
    closing = `Questions? qi@cpcqc.org`;
  } else {
    // reset
    intro =
      `Your CPCQC Engagement Tracker password has been reset by a CPCQC program manager. ` +
      `Use the temporary password below to sign back in.`;
    changeLine = `Please choose a new password right after you sign in (Account → Change password).`;
    closing = `Questions? qi@cpcqc.org`;
  }

  const parts = [
    `Hi ${p.firstName},`,
    intro,
    `Sign in here: ${p.url}\n  Email:    ${p.email}\n  Password: ${p.tempPassword}`,
  ];
  if (changeLine) parts.push(changeLine);
  parts.push(closing);

  return { subject, body: parts.join('\n\n') };
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
