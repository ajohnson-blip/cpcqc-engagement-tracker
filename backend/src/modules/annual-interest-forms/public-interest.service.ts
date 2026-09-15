/**
 * Public (accountless) interest-form submission.
 *
 * Interest forms used to be portal-only, so a submission was provably from
 * someone holding that hospital's login — the form never had to ask which
 * hospital you were. CPCQC needs people without accounts to submit, so identity
 * now rests on a verified email address instead.
 *
 * The safety property that replaces "you were logged in" is the emailed token:
 *   - it confirms the address is real, and
 *   - it is the ONLY way to edit that submission afterwards.
 *
 * That matters because annual_interest_forms is unique on (program_year,
 * hospital_id) and updated in place. Without the token, anyone who guessed a
 * hospital name could silently replace that hospital's real submission. A
 * second person submitting for an already-claimed hospital is therefore
 * refused and pointed at CPCQC, rather than overwriting.
 *
 * The token also authorises EDITING, until the window closes. Holding the link
 * is proof of being the original submitter — the same property that makes it
 * safe to confirm with — so it is the natural key for "change what I sent".
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import { env, frontendBaseUrl } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import type { AuthContext } from '@/middleware/auth.js';
import { canResendConfirmation, interestVerificationEmail } from './interest-emails.js';

export type RankableCode = 'SPARK' | 'SOAR' | 'NEST';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const verifyUrlFor = (token: string) =>
  `${frontendBaseUrl()}/interest/verify?token=${encodeURIComponent(token)}`;

/**
 * Hospitals offered in the public dropdown.
 *
 * The system is included because several facilities don't carry it in their
 * legal name — East Morgan County Hospital, Sterling Regional MedCenter and
 * Wray Community District Hospital are all Banner — so someone looking for
 * "Banner…" would scroll straight past their own hospital.
 */
export async function listHospitalsForPublicForm(): Promise<
  Array<{ id: string; name: string; system: string | null }>
> {
  const rows = await db
    .select({ id: schema.hospitals.id, name: schema.hospitals.name, system: schema.hospitals.system })
    .from(schema.hospitals);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PublicHospitalContext {
  hospitalId: string;
  hospitalName: string;
  /** TTT is a two-year cohort, so a continuing hospital keeps it automatically. */
  currentlyEnrolledInTTT: boolean;
  /** Sustainability is capped at one year, so SOAR drops out of their ranking. */
  currentlyInSoarSustainability: boolean;
  rankable: RankableCode[];
  /** True once someone has claimed this hospital for the year. */
  alreadySubmitted: boolean;
}

/**
 * Everything the form needs to render for a chosen hospital. Signed-in users get
 * this from their auth context; public submitters pick a hospital first and we
 * look it up. The TTT / sustainability flags are programme facts, not private
 * data, so exposing them to whoever selects the hospital is acceptable.
 */
export async function getPublicHospitalContext(
  hospitalId: string,
  programYear: number,
): Promise<PublicHospitalContext> {
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found.');

  const enrollments = await db
    .select({ code: schema.initiatives.code, track: schema.cohorts.track })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
    .where(
      and(
        eq(schema.enrollments.hospitalId, hospitalId),
        eq(schema.enrollments.status, 'enrolled'),
      ),
    );

  const inTTT = enrollments.some((e) => e.code === 'TTT');
  const inSoarSustainability = enrollments.some(
    (e) => e.code === 'SOAR' && e.track === 'sustainability',
  );

  const existing = await db.query.annualInterestForms.findFirst({
    where: and(
      eq(schema.annualInterestForms.programYear, programYear),
      eq(schema.annualInterestForms.hospitalId, hospitalId),
    ),
  });

  const rankable: RankableCode[] = (['SPARK', 'SOAR', 'NEST'] as const).filter(
    (c) => !(c === 'SOAR' && inSoarSustainability),
  );

  return {
    hospitalId,
    hospitalName: hospital.name,
    currentlyEnrolledInTTT: inTTT,
    currentlyInSoarSustainability: inSoarSustainability,
    rankable,
    alreadySubmitted: !!existing,
  };
}

export interface PublicSubmitInput {
  programYear: number;
  hospitalId: string;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  intendedInitiativeCount: number;
  rankedInitiatives: Array<{ code: RankableCode; rank: number }>;
  reasoning: Partial<Record<RankableCode, string>>;
}

/** Mirrors the portal form's rules so a public submission can't be weaker. */
function validate(input: PublicSubmitInput, ctx: PublicHospitalContext): void {
  if (!input.submitterName.trim()) throw new HttpError(400, 'Your name is required.');
  if (!input.submitterRole.trim()) throw new HttpError(400, 'Your role is required.');
  if (!input.submitterEmail.trim()) throw new HttpError(400, 'Email is required.');

  const ranks = input.rankedInitiatives.filter((r) => ctx.rankable.includes(r.code));
  if (ranks.length !== ctx.rankable.length) {
    throw new HttpError(400, `Rank all ${ctx.rankable.length} initiatives.`);
  }
  const distinct = new Set(ranks.map((r) => r.rank));
  if (distinct.size !== ranks.length) {
    throw new HttpError(400, 'Each initiative needs a different rank.');
  }
  const top = ranks.find((r) => r.rank === 1)?.code;
  const second = ranks.find((r) => r.rank === 2)?.code;
  if (top && !input.reasoning[top]?.trim()) {
    throw new HttpError(400, `Tell us why ${top} is your top choice.`);
  }
  if (second && !input.reasoning[second]?.trim()) {
    throw new HttpError(400, `Tell us why ${second} is your second choice.`);
  }
}

export interface PublicSubmitResult {
  formId: string;
  /** Where the verification link was sent — echoed so the UI can say so. */
  sentTo: string;
}

export async function submitPublicInterestForm(
  input: PublicSubmitInput,
): Promise<PublicSubmitResult> {
  const ctx = await getPublicHospitalContext(input.hospitalId, input.programYear);
  validate(input, ctx);

  // Claimed already: refuse rather than overwrite. The unique (year, hospital)
  // index means an update here would replace a real submission, and the person
  // doing it would never know they had.
  if (ctx.alreadySubmitted) {
    throw new HttpError(
      409,
      `An interest form for ${ctx.hospitalName} has already been submitted for ${input.programYear}. ` +
        `If it needs changing, use the link in your confirmation email, or contact qi@cpcqc.org.`,
    );
  }

  const token = randomBytes(32).toString('base64url');
  const id = uuid();
  await db.insert(schema.annualInterestForms).values({
    id,
    programYear: input.programYear,
    hospitalId: input.hospitalId,
    submitterUserId: null,
    submitterName: input.submitterName.trim(),
    submitterRole: input.submitterRole.trim(),
    submitterEmail: input.submitterEmail.trim(),
    intendedInitiativeCount: input.intendedInitiativeCount,
    rankedInitiatives: input.rankedInitiatives,
    reasoning: input.reasoning,
    status: 'submitted',
    verificationTokenHash: hashToken(token),
    verifiedAt: null,
    submittedVia: 'public',
  });

  // One template for this and the staff resend, so the two cannot drift apart
  // in what they promise.
  const email = interestVerificationEmail({
    submitterName: input.submitterName,
    hospitalName: ctx.hospitalName,
    programYear: input.programYear,
    verifyUrl: verifyUrlFor(token),
  });
  await sendEmail({
    toEmail: input.submitterEmail.trim(),
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'annual_interest.public_verify',
    ...email,
  });

  return { formId: id, sentTo: input.submitterEmail.trim() };
}

/** Confirm a submission from the emailed link. Idempotent — a second click on
 *  the same link is a success, not an error. */
export async function verifyPublicInterestForm(token: string) {
  const row = await db.query.annualInterestForms.findFirst({
    where: eq(schema.annualInterestForms.verificationTokenHash, hashToken(token)),
  });
  if (!row) throw new HttpError(404, 'That confirmation link is not valid.');

  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, row.hospitalId),
  });

  const firstConfirmation = !row.verifiedAt;
  if (firstConfirmation) {
    await db
      .update(schema.annualInterestForms)
      .set({ verifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.annualInterestForms.id, row.id));

    // Notify staff on CONFIRMATION, not submission: an unverified row is just
    // someone who typed an address, and telling the team about those would make
    // the notification worth ignoring. Only fired once — a second click on the
    // same link is a no-op.
    const ranked = (row.rankedInitiatives as Array<{ code: string; rank: number }> | null) ?? [];
    const order = [...ranked].sort((a, b) => a.rank - b.rank).map((r) => `${r.rank}. ${r.code}`);
    await sendEmail({
      toEmail: 'qi@cpcqc.org',
      fromEmail: env.EMAIL_FROM_ENROLLMENT,
      kind: 'annual_interest.public_staff_notification',
      subject: `[${row.programYear} Interest] ${hospital?.name ?? 'A hospital'} submitted (public form)`,
      body: [
        `${hospital?.name ?? 'A hospital'} submitted a ${row.programYear} interest form via the public form.`,
        '',
        `Submitted by: ${row.submitterName} (${row.submitterRole})`,
        `Email: ${row.submitterEmail} — confirmed`,
        `Intends to enroll in: ${row.intendedInitiativeCount}`,
        `Ranking: ${order.join(', ') || '(none)'}`,
        '',
        'This came from the public form, so the hospital is asserted by the submitter',
        'and backed only by a confirmed email address — worth a glance during triage.',
        '',
        'Review at /staff/interest-forms',
      ].join('\n'),
    });
  }
  return {
    programYear: row.programYear,
    hospitalName: hospital?.name ?? 'your hospital',
    submitterName: row.submitterName,
    alreadyVerified: !firstConfirmation,
  };
}


/** A submission loaded for editing, plus whether editing is still allowed. */
export interface EditableInterestForm {
  programYear: number;
  hospitalId: string;
  hospitalName: string;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  intendedInitiativeCount: number;
  rankedInitiatives: Array<{ code: RankableCode; rank: number }>;
  reasoning: Partial<Record<RankableCode, string>>;
  verified: boolean;
  /** False once the window has closed — the form then reads as a record. */
  editable: boolean;
  closesAt: string | null;
}

async function findByToken(token: string) {
  const row = await db.query.annualInterestForms.findFirst({
    where: eq(schema.annualInterestForms.verificationTokenHash, hashToken(token)),
  });
  if (!row) throw new HttpError(404, 'That link is not valid.');
  return row;
}

export async function loadInterestFormForEdit(token: string): Promise<EditableInterestForm> {
  const row = await findByToken(token);
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, row.hospitalId),
  });
  const window = await db.query.enrollmentWindows.findFirst({
    where: eq(schema.enrollmentWindows.programYear, row.programYear),
  });
  const today = new Date().toISOString().slice(0, 10);
  return {
    programYear: row.programYear,
    hospitalId: row.hospitalId,
    hospitalName: hospital?.name ?? 'your hospital',
    submitterName: row.submitterName,
    submitterRole: row.submitterRole,
    submitterEmail: row.submitterEmail,
    intendedInitiativeCount: row.intendedInitiativeCount,
    rankedInitiatives: (row.rankedInitiatives as Array<{ code: RankableCode; rank: number }>) ?? [],
    reasoning: (row.reasoning as Partial<Record<RankableCode, string>>) ?? {},
    verified: !!row.verifiedAt,
    editable: !!window && today <= window.closesAt,
    closesAt: window?.closesAt ?? null,
  };
}

/**
 * Update a submission from its emailed link. Refused once the window has
 * closed: after that the form is the record CPCQC planned cohorts from, and a
 * late change would silently disagree with decisions already made.
 */
export async function updateInterestFormByToken(
  token: string,
  input: Omit<PublicSubmitInput, 'programYear' | 'hospitalId'>,
): Promise<{ updated: true }> {
  const row = await findByToken(token);
  const current = await loadInterestFormForEdit(token);
  if (!current.editable) {
    throw new HttpError(
      400,
      `The ${row.programYear} interest window has closed, so this submission can no longer be changed. Contact qi@cpcqc.org if something needs correcting.`,
    );
  }

  const ctx = await getPublicHospitalContext(row.hospitalId, row.programYear);
  validate({ ...input, programYear: row.programYear, hospitalId: row.hospitalId }, ctx);

  await db
    .update(schema.annualInterestForms)
    .set({
      submitterName: input.submitterName.trim(),
      submitterRole: input.submitterRole.trim(),
      submitterEmail: input.submitterEmail.trim(),
      intendedInitiativeCount: input.intendedInitiativeCount,
      rankedInitiatives: input.rankedInitiatives,
      reasoning: input.reasoning,
      updatedAt: new Date(),
    })
    .where(eq(schema.annualInterestForms.id, row.id));

  return { updated: true };
}


export interface ResendConfirmationResult {
  sentTo: string;
  emailChanged: boolean;
}

/**
 * Staff: re-send the confirmation link for a public submission nobody confirmed.
 *
 * The first email can fail to arrive — SendGrid refused every send from
 * Aug 12–19, 2026 when the account ran out of credits, a mistyped address
 * reaches no one, and spam folders swallow the rest. That used to strand the
 * hospital: its submission holds the one slot for the year, a second
 * submission is refused as a duplicate, and without the link nobody can confirm
 * or edit it.
 *
 * Only a hash of the token is stored, so the original link cannot be re-sent.
 * This issues a fresh one and retires the old, and the email says so. The hash
 * is replaced BEFORE sending, so the link that goes out is always the live one.
 *
 * `toEmail` corrects a mistyped address. That hands control of the submission
 * to the new address — which is the point — so the change is audit-logged.
 */
export async function resendInterestConfirmation(
  formId: string,
  opts: { toEmail?: string },
  ctx: AuthContext,
): Promise<ResendConfirmationResult> {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') {
    throw new HttpError(403, 'Staff only.');
  }
  const row = await db.query.annualInterestForms.findFirst({
    where: eq(schema.annualInterestForms.id, formId),
  });
  if (!row) throw new HttpError(404, 'Interest form not found.');

  const eligibility = canResendConfirmation(row);
  if (!eligibility.ok) throw new HttpError(409, eligibility.reason);

  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, row.hospitalId),
  });
  const hospitalName = hospital?.name ?? 'your hospital';
  const previousEmail = row.submitterEmail.trim();
  const toEmail = (opts.toEmail ?? previousEmail).trim();
  const emailChanged = toEmail.toLowerCase() !== previousEmail.toLowerCase();

  const token = randomBytes(32).toString('base64url');
  await db
    .update(schema.annualInterestForms)
    .set({
      verificationTokenHash: hashToken(token),
      ...(emailChanged ? { submitterEmail: toEmail } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.annualInterestForms.id, row.id));

  const result = await sendEmail({
    toEmail,
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'annual_interest.public_verify_resend',
    ...interestVerificationEmail({
      submitterName: row.submitterName,
      hospitalName,
      programYear: row.programYear,
      verifyUrl: verifyUrlFor(token),
      resend: true,
    }),
  });

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: ctx.userId ?? null,
    actorRole: ctx.role,
    action: 'annual_interest.confirmation_resent',
    entityType: 'annual_interest_form',
    entityId: row.id,
    diff: {
      emailChanged,
      ...(emailChanged ? { from: previousEmail, to: toEmail } : {}),
      sent: result.sent,
    },
    note:
      `Confirmation re-sent for ${hospitalName} ${row.programYear}` +
      (emailChanged ? ' to a corrected address' : '') +
      (result.sent ? '.' : ` — the email did not send: ${result.error ?? 'sending not configured'}.`),
  });

  // Report a refused send as a failure, not a success: the old link is already
  // retired, so staff need to know nothing went out and try again.
  if (!result.sent) {
    throw new HttpError(
      502,
      `A new link was created, but the email did not send (${result.error ?? 'email sending is not configured'}). ` +
        'Try again shortly; if it keeps failing, check the SendGrid account.',
    );
  }
  return { sentTo: toEmail, emailChanged };
}
