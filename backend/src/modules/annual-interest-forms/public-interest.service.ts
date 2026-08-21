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
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import { env, frontendBaseUrl } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';

export type RankableCode = 'SPARK' | 'SOAR' | 'NEST';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

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

  const verifyUrl = `${frontendBaseUrl()}/interest/verify?token=${encodeURIComponent(token)}`;
  await sendEmail({
    toEmail: input.submitterEmail.trim(),
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'annual_interest.public_verify',
    subject: `Confirm your CPCQC ${input.programYear} interest form`,
    body: [
      `Hi ${input.submitterName.trim()},`,
      '',
      `We've received an interest form for ${ctx.hospitalName} for ${input.programYear}.`,
      '',
      'Please confirm it by opening this link:',
      verifyUrl,
      '',
      'Your form is not final until you confirm by clicking the link.',
      '',
      'Need to change something afterwards? Email qi@cpcqc.org and we will update it',
      'for you — the window is open until CPCQC closes it.',
      '',
      "If you didn't fill in this form, you can ignore this email and nothing will be recorded.",
      '',
      'Colorado Perinatal Care Quality Collaborative',
    ].join('\n'),
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
