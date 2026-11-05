/**
 * Staff-side read model for enrollment forms.
 *
 * The public service (enrollment-forms.service.ts) is about one hospital
 * filing one form. This is about the question CPCQC actually asks between
 * Nov 15 and Dec 1: who was supposed to enroll, who has, and who hasn't yet.
 *
 * "Supposed to" is derived (enrollment-coverage.ts). For SPARK/SOAR/NEST it is
 * the set of hospitals accepted for that initiative on their interest form; for
 * TTT it is the hospitals already in a TtT cohort, since continuation is
 * statutory and nobody accepts them into it. Either way, a hospital staff sent
 * the form to from this screen owes it too — the route for one CPCQC enrolls
 * without an interest form. That derivation is the whole point of the screen —
 * an outstanding list assembled by hand from two other tabs is how hospitals
 * get missed in the last week of the window.
 *
 * Staff send forms but never edit them. A hospital's enrollment is the record
 * that satisfies the statute, and editing it on the hospital's behalf would
 * erase the distinction between what CPCQC was told and what CPCQC decided.
 * Corrections go back through the hospital's own edit link.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import type { AuthContext } from '@/middleware/auth.js';
import { env, frontendBaseUrl } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import {
  ENROLLABLE,
  getEnrollmentStepWindow,
  type Champion,
  type InitiativeCode,
} from './enrollment-forms.service.js';
import { computeCoverage } from './enrollment-coverage.js';
import { enrollmentFormEmail, enrollmentFormUrl } from './enrollment-emails.js';

function assertStaff(ctx: AuthContext): void {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }
}

export interface StaffEnrollmentForm {
  id: string;
  programYear: number;
  hospital: { id: string; name: string };
  initiativeCode: InitiativeCode;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  ehr: string | null;
  ehrOther: string | null;
  champions: Champion[];
  tttContinuationAttested: boolean;
  submittedVia: 'portal' | 'public';
  /** Null until the submitter clicks the emailed link. */
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One initiative's picture: who owes a form, who has filed one. */
export interface EnrollmentCoverage {
  initiativeCode: InitiativeCode;
  /** Hospitals accepted for this initiative (TTT: hospitals continuing it). */
  expected: Array<{ id: string; name: string }>;
  /** Expected hospitals with a submitted form, verified or not. */
  submittedCount: number;
  /** Expected hospitals with nothing filed — the chase list. */
  outstanding: Array<{ id: string; name: string }>;
  /**
   * Forms from hospitals not on the expected list. Not an error: a hospital
   * can be accepted after the interest deadline, or a PM can wave one through.
   * Surfaced so the count never silently disagrees with the table below it.
   */
  unexpectedCount: number;
}

/** One initiative's form, sent by staff from this screen. */
export interface StaffEnrollmentFormSent {
  hospital: { id: string; name: string };
  initiativeCode: InitiativeCode;
  toEmail: string;
  toName: string | null;
  /** False when SendGrid refused it, or in dev with no SendGrid key. */
  emailSent: boolean;
  sentAt: string;
  sentBy: string | null;
}

export interface StaffEnrollmentOverview {
  programYear: number;
  window: { opensAt: string | null; closesAt: string | null };
  forms: StaffEnrollmentForm[];
  coverage: EnrollmentCoverage[];
  /** Newest first. */
  sent: StaffEnrollmentFormSent[];
}

function shape(
  row: typeof schema.enrollmentForms.$inferSelect,
  hospitalName: string,
): StaffEnrollmentForm {
  return {
    id: row.id,
    programYear: row.programYear,
    hospital: { id: row.hospitalId, name: hospitalName },
    initiativeCode: row.initiativeCode as InitiativeCode,
    submitterName: row.submitterName,
    submitterRole: row.submitterRole,
    submitterEmail: row.submitterEmail,
    ehr: row.ehr,
    ehrOther: row.ehrOther,
    champions: (row.champions ?? []) as Champion[],
    tttContinuationAttested: row.tttContinuationAttested,
    submittedVia: row.submittedVia === 'portal' ? 'portal' : 'public',
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Hospitals in a TtT cohort during the program year being enrolled for.
 *
 * Asked of programYear itself, not the prior year. UCHealth Memorial North
 * joined TtT year 2 in 2027 as its own record, with no 2026 year, so a
 * prior-year check would leave its continuation form off the expected list —
 * and would count a cohort that had just ended as still continuing.
 *
 * TtT runs two-year cohorts, so its enrollment form is an attestation of
 * continuation rather than a request to join. Those hospitals owe a form
 * without ever having been "accepted" for one.
 */
async function tttContinuingHospitalIds(programYear: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ hospitalId: schema.enrollments.hospitalId })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
    .innerJoin(schema.programYears, eq(schema.programYears.enrollmentId, schema.enrollments.id))
    .where(
      and(
        eq(schema.initiatives.code, 'TTT'),
        eq(schema.enrollments.status, 'enrolled'),
        eq(schema.programYears.year, programYear),
      ),
    );
  return rows.map((r) => r.hospitalId);
}

export async function getStaffEnrollmentOverview(
  programYear: number,
  ctx: AuthContext,
): Promise<StaffEnrollmentOverview> {
  assertStaff(ctx);

  const [formRows, interestRows, window, tttIds, sentRows] = await Promise.all([
    db
      .select()
      .from(schema.enrollmentForms)
      .where(eq(schema.enrollmentForms.programYear, programYear)),
    db
      .select({
        hospitalId: schema.annualInterestForms.hospitalId,
        decidedInitiatives: schema.annualInterestForms.decidedInitiatives,
      })
      .from(schema.annualInterestForms)
      .where(eq(schema.annualInterestForms.programYear, programYear)),
    db.query.enrollmentWindows.findFirst({
      where: eq(schema.enrollmentWindows.programYear, programYear),
    }),
    tttContinuingHospitalIds(programYear),
    db
      .select({
        row: schema.enrollmentFormInvitations,
        firstName: schema.users.firstName,
        lastName: schema.users.lastName,
        email: schema.users.email,
      })
      .from(schema.enrollmentFormInvitations)
      .leftJoin(schema.users, eq(schema.users.id, schema.enrollmentFormInvitations.sentByUserId))
      .where(eq(schema.enrollmentFormInvitations.programYear, programYear))
      .orderBy(desc(schema.enrollmentFormInvitations.createdAt)),
  ]);

  // One lookup for every hospital either side of the comparison, so an
  // outstanding hospital that has filed nothing still has a name to show.
  const hospitalIds = Array.from(
    new Set([
      ...formRows.map((f) => f.hospitalId),
      ...interestRows.map((r) => r.hospitalId),
      ...tttIds,
      ...sentRows.map((s) => s.row.hospitalId),
    ]),
  );
  const hospitals = hospitalIds.length
    ? await db
        .select({ id: schema.hospitals.id, name: schema.hospitals.name })
        .from(schema.hospitals)
        .where(inArray(schema.hospitals.id, hospitalIds))
    : [];
  const nameById = new Map(hospitals.map((h) => [h.id, h.name]));
  const nameOf = (id: string) => nameById.get(id) ?? 'Unknown hospital';

  const forms = formRows
    .map((r) => shape(r, nameById.get(r.hospitalId) ?? 'Unknown hospital'))
    .sort(
      (a, b) =>
        a.hospital.name.localeCompare(b.hospital.name) ||
        a.initiativeCode.localeCompare(b.initiativeCode),
    );

  const coverage: EnrollmentCoverage[] = computeCoverage({
    codes: ENROLLABLE,
    filed: formRows,
    accepted: interestRows.map((r) => ({
      hospitalId: r.hospitalId,
      decidedInitiatives: (r.decidedInitiatives ?? null) as string[] | null,
    })),
    tttContinuing: tttIds,
    sent: sentRows.map((s) => s.row),
    nameOf,
  });

  const sent: StaffEnrollmentFormSent[] = sentRows.map(({ row, firstName, lastName, email }) => ({
    hospital: { id: row.hospitalId, name: nameOf(row.hospitalId) },
    initiativeCode: row.initiativeCode as InitiativeCode,
    toEmail: row.toEmail,
    toName: row.toName,
    emailSent: row.emailSent,
    sentAt: row.createdAt.toISOString(),
    sentBy: [firstName, lastName].filter(Boolean).join(' ') || email || null,
  }));

  return {
    programYear,
    window: {
      opensAt: window?.enrollmentOpensAt ?? null,
      closesAt: window?.enrollmentClosesAt ?? null,
    },
    forms,
    coverage,
    sent,
  };
}

export interface SendEnrollmentFormsInput {
  programYear: number;
  hospitalId: string;
  initiatives: InitiativeCode[];
  toEmail: string;
  toName?: string | null;
}

export interface SendEnrollmentFormsResult {
  sentTo: string;
  initiatives: InitiativeCode[];
  /** False when SendGrid refused it, or in dev with no SendGrid key. */
  emailSent: boolean;
  error: string | null;
}

/**
 * Email a hospital its enrollment form(s), one link per initiative, and record
 * the send so the hospital joins each initiative's chase list.
 *
 * Works for any hospital, accepted or not. Its main use is a hospital CPCQC
 * enrolls without an interest form, which has no acceptance email to carry the
 * links, but it is equally how a PM re-sends a link that went astray.
 */
export async function sendEnrollmentForms(
  input: SendEnrollmentFormsInput,
  ctx: AuthContext,
): Promise<SendEnrollmentFormsResult> {
  assertStaff(ctx);
  // ENROLLABLE order, deduplicated, so the email lists initiatives the same
  // way every time.
  const codes = ENROLLABLE.filter((c) => input.initiatives.includes(c));
  if (codes.length === 0) throw new HttpError(400, 'Choose at least one initiative.');

  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, input.hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found.');

  const window = await getEnrollmentStepWindow(input.programYear);
  if (window.state === 'after' && window.closesAt) {
    throw new HttpError(
      409,
      `The ${input.programYear} enrollment window closed on ${window.closesAt}, so the form no longer accepts submissions.`,
    );
  }

  // The public form refuses a second submission for the same initiative, so a
  // link to one already filed would only lead the hospital to that refusal.
  const filed = await db
    .select({ code: schema.enrollmentForms.initiativeCode })
    .from(schema.enrollmentForms)
    .where(
      and(
        eq(schema.enrollmentForms.programYear, input.programYear),
        eq(schema.enrollmentForms.hospitalId, hospital.id),
        inArray(schema.enrollmentForms.initiativeCode, codes),
      ),
    );
  if (filed.length > 0) {
    throw new HttpError(
      409,
      `${hospital.name} has already submitted its ${input.programYear} ` +
        `${filed.map((f) => f.code).join(' and ')} enrollment form. Untick ` +
        `${filed.length === 1 ? 'it' : 'them'} and send the rest.`,
    );
  }

  const toEmail = input.toEmail.trim();
  const toName = input.toName?.trim() || null;
  const { subject, body, html } = enrollmentFormEmail({
    recipientName: toName,
    hospitalName: hospital.name,
    programYear: input.programYear,
    links: codes.map((code) => ({
      code,
      url: enrollmentFormUrl(frontendBaseUrl(), input.programYear, hospital.id, code),
    })),
    dates: window,
  });
  const result = await sendEmail({
    toEmail,
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'enrollment.form_sent',
    subject,
    body,
    html,
  });

  // Recorded even when SendGrid refused it: the decision that this hospital
  // owes the form stands, and the chase list should show it until it is filed.
  const now = new Date();
  await db.insert(schema.enrollmentFormInvitations).values(
    codes.map((code) => ({
      id: uuid(),
      programYear: input.programYear,
      hospitalId: hospital.id,
      initiativeCode: code,
      toEmail,
      toName,
      sentByUserId: ctx.userId ?? null,
      emailSent: result.sent,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: ctx.userId ?? null,
    actorRole: ctx.role,
    action: 'enrollment_form.sent',
    entityType: 'hospital',
    entityId: hospital.id,
    diff: { programYear: input.programYear, initiatives: codes, toEmail },
    note: `Sent ${codes.join(', ')} enrollment form(s) to ${toEmail}.`,
  });

  return { sentTo: toEmail, initiatives: codes, emailSent: result.sent, error: result.error ?? null };
}

export interface RecipientSuggestion {
  name: string | null;
  email: string;
  /** Where the address came from, shown beside it. */
  source: string;
}

/**
 * Addresses a PM is likely to want for a hospital's enrollment form: its
 * default contact, whoever filed its interest form, the people on its roster,
 * and anyone it was sent to before. Suggestions only — the PM can type any
 * address.
 */
export async function getRecipientSuggestions(
  hospitalId: string,
  programYear: number,
  ctx: AuthContext,
): Promise<{ suggestions: RecipientSuggestion[] }> {
  assertStaff(ctx);
  const [hospital, interest, roster, previous] = await Promise.all([
    db.query.hospitals.findFirst({ where: eq(schema.hospitals.id, hospitalId) }),
    db.query.annualInterestForms.findFirst({
      where: and(
        eq(schema.annualInterestForms.programYear, programYear),
        eq(schema.annualInterestForms.hospitalId, hospitalId),
      ),
    }),
    db
      .select({
        name: schema.hospitalStaffMembers.name,
        role: schema.hospitalStaffMembers.role,
        email: schema.hospitalStaffMembers.email,
      })
      .from(schema.hospitalStaffMembers)
      .where(eq(schema.hospitalStaffMembers.hospitalId, hospitalId)),
    db
      .select({
        name: schema.enrollmentFormInvitations.toName,
        email: schema.enrollmentFormInvitations.toEmail,
      })
      .from(schema.enrollmentFormInvitations)
      .where(
        and(
          eq(schema.enrollmentFormInvitations.programYear, programYear),
          eq(schema.enrollmentFormInvitations.hospitalId, hospitalId),
        ),
      )
      .orderBy(desc(schema.enrollmentFormInvitations.createdAt)),
  ]);
  if (!hospital) throw new HttpError(404, 'Hospital not found.');

  const candidates: RecipientSuggestion[] = [
    ...previous.map((p) => ({ name: p.name, email: p.email, source: 'Sent before' })),
    ...(hospital.defaultContactEmail
      ? [{ name: hospital.defaultContactName, email: hospital.defaultContactEmail, source: 'Default contact' }]
      : []),
    ...(interest
      ? [{ name: interest.submitterName, email: interest.submitterEmail, source: 'Interest form' }]
      : []),
    ...roster
      .filter((r) => r.email)
      .map((r) => ({ name: r.name, email: r.email!, source: r.role || 'Roster' })),
  ];
  const seen = new Set<string>();
  const suggestions = candidates.filter((c) => {
    const key = c.email.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { suggestions };
}
