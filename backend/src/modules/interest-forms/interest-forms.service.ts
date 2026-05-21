/**
 * Interest Forms service.
 *
 * Lifecycle:
 *   submitted → reviewed → approved | declined
 *
 * On approval, the system:
 *   1. Finds or creates a Hospital matching the submitted facility name.
 *   2. Looks up the active cohort for the current/next program year for that initiative.
 *   3. Creates an Enrollment in status `eligible_to_enroll` (which generates
 *      ProgramYears and TaskInstances, including the Enrollment Form task).
 *   4. Creates or reuses a User account for the submitter, marked hospital_admin,
 *      and issues a password-setup token that's emailed to them.
 *   5. Emails the submitter with the password-setup link and Enrollment Form CTA.
 *
 * On decline, an email is sent (optionally with staff notes) and no other state changes.
 */
import { v4 as uuid } from 'uuid';
import crypto from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import { env } from '@/config/env.js';
import { findOrCreateHospitalByName } from '@/modules/hospitals/hospitals.service.js';
import { createEnrollment, findActiveCohortForInitiativeYear } from '@/modules/enrollments/enrollments.service.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import {
  interestFormApprovedToHospital,
  interestFormDeclinedToHospital,
  interestFormReceivedToStaff,
} from '@/modules/notifications/templates.js';
import { hashPassword } from '@/modules/auth/auth.service.js';

export interface SubmitInterestFormInput {
  initiativeCode: 'TTT' | 'SPARK' | 'SOAR' | 'NEST';
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  facilityName: string;
}

export async function submitInterestForm(input: SubmitInterestFormInput) {
  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.code, input.initiativeCode),
  });
  if (!initiative) throw new HttpError(404, `Unknown initiative code: ${input.initiativeCode}`);

  const id = uuid();
  await db.insert(schema.interestForms).values({
    id,
    initiativeId: initiative.id,
    hospitalId: null,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    role: input.role,
    facilityName: input.facilityName,
    status: 'submitted',
  });

  // Notify staff. We use a generic staff inbox via EMAIL_FROM; in production you'd
  // look up staff users with the relevant initiative assignment.
  const tmpl = interestFormReceivedToStaff({
    initiativeName: initiative.name,
    facilityName: input.facilityName,
    submitterName: `${input.firstName} ${input.lastName}`.trim(),
    submitterEmail: input.email,
    submitterRole: input.role,
    interestFormId: id,
  });
  await sendEmail({
    toEmail: env.EMAIL_FROM,
    subject: tmpl.subject,
    body: tmpl.body,
    kind: 'interest_form.submitted_staff',
  });

  return { id, status: 'submitted' as const };
}

export interface ListInterestFormsParams {
  status?: 'submitted' | 'reviewed' | 'approved' | 'declined';
  initiativeId?: string;
  limit?: number;
  offset?: number;
}

export async function listInterestForms(params: ListInterestFormsParams = {}) {
  const { limit = 50, offset = 0 } = params;
  const whereClauses = [];
  if (params.status) whereClauses.push(eq(schema.interestForms.status, params.status));
  if (params.initiativeId) whereClauses.push(eq(schema.interestForms.initiativeId, params.initiativeId));
  const where = whereClauses.length ? and(...whereClauses) : undefined;

  const rows = await db
    .select()
    .from(schema.interestForms)
    .where(where)
    .orderBy(desc(schema.interestForms.createdAt))
    .limit(limit)
    .offset(offset);

  const totalRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.interestForms)
    .where(where);

  return { interestForms: rows, total: totalRow[0]?.count ?? 0, limit, offset };
}

export async function getInterestForm(id: string) {
  const form = await db.query.interestForms.findFirst({
    where: eq(schema.interestForms.id, id),
  });
  if (!form) throw new HttpError(404, 'Interest form not found');
  return form;
}

export interface ApproveInterestFormInput {
  reviewerUserId: string;
  programYear: number;
  staffNotes?: string;
}

export interface ApproveInterestFormResult {
  hospitalId: string;
  enrollmentId: string;
  userId: string;
  passwordSetupToken: string;
}

function newOpaqueToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(40).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

export async function approveInterestForm(
  id: string,
  input: ApproveInterestFormInput,
): Promise<ApproveInterestFormResult> {
  const form = await getInterestForm(id);
  if (form.status === 'approved') throw new HttpError(409, 'Already approved');
  if (form.status === 'declined') throw new HttpError(409, 'Already declined');

  const cohort = await findActiveCohortForInitiativeYear(form.initiativeId, input.programYear);
  if (!cohort) {
    throw new HttpError(
      400,
      `No active cohort found for this initiative covering program year ${input.programYear}. ` +
        'Create the cohort first.',
    );
  }

  const hospital = await findOrCreateHospitalByName(form.facilityName, {
    defaultContactName: `${form.firstName} ${form.lastName}`.trim(),
    defaultContactEmail: form.email,
  });

  const { enrollmentId } = await createEnrollment({
    hospitalId: hospital.id,
    cohortId: cohort.id,
  });

  // Find or create the user. If a user with this email already exists for this
  // hospital we reuse it; otherwise create a hospital_admin.
  let user = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = lower(${form.email})`,
  });
  if (!user) {
    const tempPasswordHash = await hashPassword(crypto.randomBytes(24).toString('base64url'));
    const userId = uuid();
    await db.insert(schema.users).values({
      id: userId,
      email: form.email,
      passwordHash: tempPasswordHash,
      firstName: form.firstName,
      lastName: form.lastName,
      role: 'hospital_admin',
      hospitalId: hospital.id,
    });
    user = (await db.query.users.findFirst({ where: eq(schema.users.id, userId) }))!;
  } else if (!user.hospitalId) {
    // Attach an existing orphan user to this hospital
    await db
      .update(schema.users)
      .set({ hospitalId: hospital.id, updatedAt: new Date() })
      .where(eq(schema.users.id, user.id));
    user = (await db.query.users.findFirst({ where: eq(schema.users.id, user.id) }))!;
  }

  // Issue a password-setup token (7 day expiry) reusing the password_resets table
  const { token, hash } = newOpaqueToken();
  await db.insert(schema.passwordResets).values({
    id: uuid(),
    userId: user.id,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  // Mark the form approved
  await db
    .update(schema.interestForms)
    .set({
      status: 'approved',
      reviewedBy: input.reviewerUserId,
      reviewedAt: new Date(),
      hospitalId: hospital.id,
      staffNotes: input.staffNotes ?? form.staffNotes,
      updatedAt: new Date(),
    })
    .where(eq(schema.interestForms.id, id));

  // Email the submitter with the password-setup link
  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.id, form.initiativeId),
  });
  const passwordSetupUrl = `${env.APP_BASE_URL}/auth/set-password?token=${encodeURIComponent(token)}`;
  const tmpl = interestFormApprovedToHospital({
    recipientName: form.firstName,
    initiativeName: initiative?.name ?? form.initiativeId,
    facilityName: form.facilityName,
    passwordSetupUrl,
  });
  await sendEmail({
    toEmail: form.email,
    subject: tmpl.subject,
    body: tmpl.body,
    kind: 'interest_form.approved_hospital',
    userId: user.id,
  });

  return {
    hospitalId: hospital.id,
    enrollmentId,
    userId: user.id,
    passwordSetupToken: token,
  };
}

export interface DeclineInterestFormInput {
  reviewerUserId: string;
  staffNotes?: string;
}

export async function declineInterestForm(id: string, input: DeclineInterestFormInput) {
  const form = await getInterestForm(id);
  if (form.status === 'approved') throw new HttpError(409, 'Already approved');
  if (form.status === 'declined') throw new HttpError(409, 'Already declined');

  await db
    .update(schema.interestForms)
    .set({
      status: 'declined',
      reviewedBy: input.reviewerUserId,
      reviewedAt: new Date(),
      staffNotes: input.staffNotes ?? form.staffNotes,
      updatedAt: new Date(),
    })
    .where(eq(schema.interestForms.id, id));

  const initiative = await db.query.initiatives.findFirst({
    where: eq(schema.initiatives.id, form.initiativeId),
  });
  const tmpl = interestFormDeclinedToHospital({
    recipientName: form.firstName,
    initiativeName: initiative?.name ?? form.initiativeId,
    staffNotes: input.staffNotes,
  });
  await sendEmail({
    toEmail: form.email,
    subject: tmpl.subject,
    body: tmpl.body,
    kind: 'interest_form.declined_hospital',
  });

  return { id, status: 'declined' as const };
}
