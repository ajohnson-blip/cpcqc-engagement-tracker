/**
 * Step 2 of annual enrollment — the legally mandated enrollment form.
 *
 * Public, like the interest form: hospitals must be able to complete this
 * without a portal account. A submission counts at once, and its emailed
 * receipt carries a token that is the only route to editing afterwards.
 *
 * That guard matters more here than on the interest form. This is the record
 * that satisfies the statute, and the table is unique on (year, hospital,
 * initiative) — so an unguarded public write would let a stranger silently
 * replace a hospital's real enrollment. A second submission for a claimed
 * (hospital, initiative) is refused and pointed at CPCQC.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import { env, frontendBaseUrl } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import { receiptEmail } from './enrollment-emails.js';

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export const ENROLLABLE = ['SPARK', 'SOAR', 'NEST', 'TTT'] as const;
export type InitiativeCode = (typeof ENROLLABLE)[number];

export const EHR_OPTIONS = ['Epic', 'Oracle Health (Cerner)', 'MEDITECH', 'Other…'] as const;

/**
 * Who hears of each enrollment: the initiative's program manager, as CPCQC
 * named them on 2026-11-05. Change an address here when a PM changes.
 */
const ENROLLMENT_NOTICE_TO: Record<InitiativeCode, string> = {
  SPARK: 'kricard@cpcqc.org',
  SOAR: 'rbryan@cpcqc.org',
  NEST: 'ssubudhiwarwick@cpcqc.org',
  TTT: 'sbriley@cpcqc.org',
};

/**
 * Hospitals whose TtT form always asks for champions. UCHealth Memorial
 * Hospital North enrolls on its own from 2027 (it was part of Memorial in
 * 2026), and its TtT team comes from this form, whatever is on file.
 */
const TTT_ROSTER_FROM_FORM = new Set(['uchealth memorial hospital north']);

/** Roles CPCQC requires, with the descriptions the team signed off. */
export const CHAMPION_ROLES = [
  {
    key: 'nurse',
    label: 'Nurse champion',
    required: true,
    description: 'This person is responsible for leading QI implementation using nursing perspective.',
  },
  {
    key: 'provider',
    label: 'Provider champion',
    required: true,
    description: 'This person is responsible for leading QI implementation using provider perspective.',
  },
  {
    key: 'data',
    label: 'Data champion',
    required: true,
    description: 'This person is responsible for collecting and submitting required data for this initiative.',
  },
  {
    key: 'csuite',
    label: 'C-suite sponsor',
    required: true,
    description: 'This person provides executive-level support for meeting CPCQC engagement requirements.',
  },
  { key: 'other', label: 'Other champion', required: false, description: '' },
] as const;

export type ChampionRoleKey = (typeof CHAMPION_ROLES)[number]['key'];

export interface Champion {
  role: ChampionRoleKey;
  name: string;
  email: string;
  title: string;
  isPrimary: boolean;
  /** Requests only — CPCQC grants access separately. */
  redcapAccess: boolean;
  dashboardAccess: boolean;
}

export interface EnrollmentWindowState {
  opensAt: string | null;
  closesAt: string | null;
  state: 'before' | 'open' | 'after';
}

export async function getEnrollmentStepWindow(programYear: number): Promise<EnrollmentWindowState> {
  const row = await db.query.enrollmentWindows.findFirst({
    where: eq(schema.enrollmentWindows.programYear, programYear),
  });
  const opensAt = row?.enrollmentOpensAt ?? null;
  const closesAt = row?.enrollmentClosesAt ?? null;
  // Unset dates mean the step isn't open yet, not that it's open forever.
  if (!opensAt || !closesAt) return { opensAt, closesAt, state: 'before' };
  const today = new Date().toISOString().slice(0, 10);
  const state = today < opensAt ? 'before' : today > closesAt ? 'after' : 'open';
  return { opensAt, closesAt, state };
}

export interface EnrollmentContext {
  hospitalId: string;
  hospitalName: string;
  initiativeCode: InitiativeCode;
  /** TtT hospitals attest to continuing rather than filing a full enrollment. */
  isTttContinuation: boolean;
  alreadySubmitted: boolean;
  /**
   * What this hospital is doing right now. The interest form knew this and the
   * enrollment form did not, so a hospital was offered TtT it was never in, and
   * SOAR it had just graduated from — with nothing on screen to say so.
   */
  currentlyEnrolled: string[];
  /** Set when this pairing looks wrong, e.g. TtT for a hospital not in it. */
  caution: string | null;
  /**
   * TtT only: the continuation form asks for champions as well as the
   * attestation, because CPCQC has none on file for this hospital, or it is
   * UCHealth Memorial North, new for 2027.
   */
  needsTttRoster: boolean;
  /** Other initiatives this hospital has already enrolled in this year — the
   *  source for "copy champions from…". */
  copyableFrom: Array<{ initiativeCode: string; championCount: number }>;
}

export async function getEnrollmentContext(
  hospitalId: string,
  initiativeCode: InitiativeCode,
  programYear: number,
): Promise<EnrollmentContext> {
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, hospitalId),
  });
  if (!hospital) throw new HttpError(404, 'Hospital not found.');

  const existing = await db.query.enrollmentForms.findFirst({
    where: and(
      eq(schema.enrollmentForms.programYear, programYear),
      eq(schema.enrollmentForms.hospitalId, hospitalId),
      eq(schema.enrollmentForms.initiativeCode, initiativeCode),
    ),
  });

  const enrollments = await db
    .select({ code: schema.initiatives.code })
    .from(schema.enrollments)
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
    .where(and(eq(schema.enrollments.hospitalId, hospitalId), eq(schema.enrollments.status, 'enrolled')));
  // SOAR enrollment is one form whatever the track: CPCQC assigns active or
  // sustainability after enrollment, so the form never mentions either.
  const currentlyEnrolled = enrollments.map((e) => e.code);

  // What CPCQC decided on this hospital's interest form, if anything yet.
  // Null decidedInitiatives means undecided — a very different thing from an
  // empty list, and not something to warn anyone about.
  const interest = await db.query.annualInterestForms.findFirst({
    where: and(
      eq(schema.annualInterestForms.programYear, programYear),
      eq(schema.annualInterestForms.hospitalId, hospitalId),
    ),
  });
  const decided = (interest?.decidedInitiatives ?? null) as string[] | null;

  // Advisory, never blocking: CPCQC decides who enrols, and a hospital may have
  // been accepted into something the tracker doesn't know about yet. But an
  // obviously odd pairing should say so rather than sail through.
  let caution: string | null = null;
  if (initiativeCode === 'TTT' && !currentlyEnrolled.includes('TTT')) {
    caution =
      `Our records don't show ${hospital.name} in Turning the Tide. TtT is a two-year cohort and ` +
      `CPCQC isn't enrolling new hospitals — if you believe this is wrong, contact qi@cpcqc.org before submitting.`;
  } else if (initiativeCode !== 'TTT' && decided && !decided.includes(initiativeCode)) {
    // Enrollment forms are sent per acceptance, so reaching this page for an
    // initiative CPCQC didn't accept usually means a wrong link or a shared
    // one. Said, not enforced: acceptances happen after the interest deadline
    // too, and a hospital turned away by the tracker would simply not enroll.
    caution =
      `CPCQC's records show ${hospital.name} accepted for ` +
      `${decided.length ? decided.join(', ') : 'no initiatives'} in ${programYear}, not ${initiativeCode}. ` +
      `If you were told otherwise, email qi@cpcqc.org before submitting — enrollment forms are sent per initiative, ` +
      `so this may be the wrong link.`;
  }

  const tttRoster =
    initiativeCode === 'TTT'
      ? await db
          .select({ id: schema.hospitalStaffMembers.id })
          .from(schema.hospitalStaffMembers)
          .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.hospitalStaffMembers.initiativeId))
          .where(and(eq(schema.hospitalStaffMembers.hospitalId, hospitalId), eq(schema.initiatives.code, 'TTT')))
          .limit(1)
      : [];

  const others = await db
    .select()
    .from(schema.enrollmentForms)
    .where(
      and(
        eq(schema.enrollmentForms.programYear, programYear),
        eq(schema.enrollmentForms.hospitalId, hospitalId),
      ),
    );

  return {
    hospitalId,
    hospitalName: hospital.name,
    initiativeCode,
    isTttContinuation: initiativeCode === 'TTT',
    alreadySubmitted: !!existing,
    currentlyEnrolled,
    caution,
    needsTttRoster:
      initiativeCode === 'TTT' &&
      (tttRoster.length === 0 || TTT_ROSTER_FROM_FORM.has(hospital.name.trim().toLowerCase())),
    copyableFrom: others
      .filter((o) => o.initiativeCode !== initiativeCode && o.initiativeCode !== 'TTT')
      .map((o) => ({
        initiativeCode: o.initiativeCode,
        championCount: ((o.champions as Champion[] | null) ?? []).filter((c) => c.name?.trim()).length,
      }))
      .filter((o) => o.championCount > 0),
  };
}

/** Champions from another initiative, for the explicit "copy from" action.
 *  Never applied automatically — rosters legitimately differ per initiative. */
export async function getChampionsToCopy(
  hospitalId: string,
  fromInitiative: string,
  programYear: number,
): Promise<Champion[]> {
  const row = await db.query.enrollmentForms.findFirst({
    where: and(
      eq(schema.enrollmentForms.programYear, programYear),
      eq(schema.enrollmentForms.hospitalId, hospitalId),
      eq(schema.enrollmentForms.initiativeCode, fromInitiative),
    ),
  });
  if (!row) throw new HttpError(404, 'No enrollment form to copy from.');
  return (row.champions as Champion[] | null) ?? [];
}

export interface EnrollmentSubmitInput {
  programYear: number;
  hospitalId: string;
  initiativeCode: InitiativeCode;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  ehr?: string;
  ehrOther?: string;
  champions?: Champion[];
  tttContinuationAttested?: boolean;
}

/**
 * `tttRoster`: a TtT form that must also list champions, because CPCQC has
 * none on file for the hospital.
 */
function validate(input: EnrollmentSubmitInput, tttRoster: boolean): void {
  if (!input.submitterName.trim()) throw new HttpError(400, 'Your name is required.');
  if (!input.submitterRole.trim()) throw new HttpError(400, 'Your role is required.');
  if (!input.submitterEmail.trim()) throw new HttpError(400, 'Email is required.');

  // TtT is a continuation: the attestation IS the submission, so no EHR is
  // collected, and a roster only when CPCQC has none for the hospital.
  if (input.initiativeCode === 'TTT') {
    if (!input.tttContinuationAttested) {
      throw new HttpError(400, 'Confirm the continuation attestation to submit.');
    }
    if (tttRoster) validateChampions(input.champions ?? []);
    return;
  }

  if (!input.ehr) throw new HttpError(400, 'Select your hospital EHR.');
  if (input.ehr === 'Other…' && !input.ehrOther?.trim()) {
    throw new HttpError(400, 'Tell us which EHR your hospital uses.');
  }
  validateChampions(input.champions ?? []);
}

function validateChampions(champions: Champion[]): void {
  for (const role of CHAMPION_ROLES) {
    if (!role.required) continue;
    const c = champions.find((x) => x.role === role.key);
    if (!c?.name.trim() || !c?.email.trim() || !c?.title.trim()) {
      throw new HttpError(400, `${role.label}: name, email and hospital title are all required.`);
    }
  }
  const primaries = champions.filter((c) => c.isPrimary && c.name.trim());
  if (primaries.length !== 1) {
    throw new HttpError(400, 'Mark exactly one champion as the primary contact.');
  }
}

export async function submitEnrollmentForm(input: EnrollmentSubmitInput) {
  const ctx = await getEnrollmentContext(input.hospitalId, input.initiativeCode, input.programYear);
  validate(input, ctx.needsTttRoster);

  if (ctx.alreadySubmitted) {
    throw new HttpError(
      409,
      `${ctx.hospitalName} has already submitted a ${input.programYear} enrollment form for ` +
        `${input.initiativeCode}. To change it, use the link in your receipt email, or contact qi@cpcqc.org.`,
    );
  }

  const token = randomBytes(32).toString('base64url');
  const id = uuid();
  const isTtt = input.initiativeCode === 'TTT';

  await db.insert(schema.enrollmentForms).values({
    id,
    programYear: input.programYear,
    hospitalId: input.hospitalId,
    initiativeCode: input.initiativeCode,
    ehr: isTtt ? null : (input.ehr ?? null),
    ehrOther: isTtt ? null : (input.ehrOther?.trim() || null),
    champions: isTtt && !ctx.needsTttRoster ? null : (input.champions ?? []),
    tttContinuationAttested: isTtt ? !!input.tttContinuationAttested : false,
    submitterName: input.submitterName.trim(),
    submitterRole: input.submitterRole.trim(),
    submitterEmail: input.submitterEmail.trim(),
    submitterUserId: null,
    verificationTokenHash: hashToken(token),
    // A submission counts at once: the links go to people CPCQC chose, staff
    // see every form, and an extra confirm click only left enrollments
    // half-done.
    verifiedAt: new Date(),
    submittedVia: 'public',
  });

  const row = (await db.query.enrollmentForms.findFirst({ where: eq(schema.enrollmentForms.id, id) }))!;
  await sendReceiptAndNotice(row, token);

  return { formId: id, sentTo: input.submitterEmail.trim() };
}

/**
 * The hospital's receipt, with its edit link, and CPCQC's notice of the
 * enrollment. Sent once, when the form starts to count.
 */
async function sendReceiptAndNotice(row: typeof schema.enrollmentForms.$inferSelect, token: string) {
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, row.hospitalId),
  });
  const window = await getEnrollmentStepWindow(row.programYear);
  const editUrl = `${frontendBaseUrl()}/enrollment/${row.programYear}?token=${encodeURIComponent(token)}`;
  const receipt = receiptEmail({
    submitterName: row.submitterName,
    hospitalName: hospital?.name ?? 'your hospital',
    initiativeCode: row.initiativeCode as InitiativeCode,
    programYear: row.programYear,
    editUrl,
    closesAt: window.closesAt,
  });
  await sendEmail({
    toEmail: row.submitterEmail,
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'enrollment.confirmation',
    ...receipt,
    // The edit link works like a password for this submission.
    redact: [editUrl],
  });

  const champions = (row.champions as Champion[] | null) ?? [];
  const named = champions.filter((c) => c.name?.trim());
  const accessRequests = named.filter((c) => c.redcapAccess || c.dashboardAccess);
  await sendEmail({
    toEmail: ENROLLMENT_NOTICE_TO[row.initiativeCode as InitiativeCode] ?? 'qi@cpcqc.org',
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'enrollment.staff_notification',
    subject: `[${row.programYear} Enrollment] ${hospital?.name ?? 'A hospital'} — ${row.initiativeCode}`,
    body: [
      `${hospital?.name ?? 'A hospital'} enrolled in ${row.initiativeCode} for ${row.programYear}.`,
      '',
      `Submitted by: ${row.submitterName} (${row.submitterRole}) — ${row.submitterEmail}`,
      row.initiativeCode === 'TTT'
        ? 'Turning the Tide continuation attestation.'
        : `EHR: ${row.ehrOther || row.ehr || '—'}`,
      '',
      named.length
        ? `Champions:\n${named
            .map((c) => `  ${c.role}: ${c.name} <${c.email}> — ${c.title}${c.isPrimary ? ' [PRIMARY]' : ''}`)
            .join('\n')}`
        : '',
      accessRequests.length
        ? `\nAccess requested (grant separately):\n${accessRequests
            .map(
              (c) =>
                `  ${c.name}: ${[c.redcapAccess ? 'REDCap' : null, c.dashboardAccess ? 'QI dashboard' : null]
                  .filter(Boolean)
                  .join(' + ')}`,
            )
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

/**
 * Confirm from an emailed link. Forms no longer need confirming, since they
 * count from submission, but links sent before that change still arrive here
 * and finish the job. Idempotent; notifies staff once.
 */
export async function verifyEnrollmentForm(token: string) {
  const row = await db.query.enrollmentForms.findFirst({
    where: eq(schema.enrollmentForms.verificationTokenHash, hashToken(token)),
  });
  if (!row) throw new HttpError(404, 'That confirmation link is not valid.');

  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, row.hospitalId),
  });
  const firstConfirmation = !row.verifiedAt;

  if (firstConfirmation) {
    await db
      .update(schema.enrollmentForms)
      .set({ verifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.enrollmentForms.id, row.id));
    await sendReceiptAndNotice(row, token);
  }

  return {
    programYear: row.programYear,
    hospitalName: hospital?.name ?? 'your hospital',
    initiativeCode: row.initiativeCode,
    submitterName: row.submitterName,
    alreadyVerified: !firstConfirmation,
  };
}

/** A submission loaded for editing, plus whether editing is still allowed. */
export interface EditableEnrollmentForm {
  programYear: number;
  hospitalId: string;
  hospitalName: string;
  initiativeCode: InitiativeCode;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  ehr: string | null;
  ehrOther: string | null;
  champions: Champion[];
  tttContinuationAttested: boolean;
  verified: boolean;
  /** False once the window has closed — enrollment is then the legal record. */
  editable: boolean;
  closesAt: string | null;
}

async function findByToken(token: string) {
  const row = await db.query.enrollmentForms.findFirst({
    where: eq(schema.enrollmentForms.verificationTokenHash, hashToken(token)),
  });
  if (!row) throw new HttpError(404, 'That link is not valid.');
  return row;
}

export async function loadEnrollmentFormForEdit(token: string): Promise<EditableEnrollmentForm> {
  const row = await findByToken(token);
  const hospital = await db.query.hospitals.findFirst({
    where: eq(schema.hospitals.id, row.hospitalId),
  });
  const window = await getEnrollmentStepWindow(row.programYear);
  const today = new Date().toISOString().slice(0, 10);
  return {
    programYear: row.programYear,
    hospitalId: row.hospitalId,
    hospitalName: hospital?.name ?? 'your hospital',
    initiativeCode: row.initiativeCode as InitiativeCode,
    submitterName: row.submitterName,
    submitterRole: row.submitterRole,
    submitterEmail: row.submitterEmail,
    ehr: row.ehr,
    ehrOther: row.ehrOther,
    champions: (row.champions as Champion[] | null) ?? [],
    tttContinuationAttested: row.tttContinuationAttested,
    verified: !!row.verifiedAt,
    editable: !!window.closesAt && today <= window.closesAt,
    closesAt: window.closesAt,
  };
}

/**
 * Update an enrollment from its emailed link. Refused after the deadline: this
 * is the record that satisfies the statute, so what it said on Dec 1 is what
 * counts, and a later edit would quietly disagree with it.
 */
export async function updateEnrollmentFormByToken(
  token: string,
  input: Omit<EnrollmentSubmitInput, 'programYear' | 'hospitalId' | 'initiativeCode'>,
): Promise<{ updated: true }> {
  const row = await findByToken(token);
  const current = await loadEnrollmentFormForEdit(token);
  if (!current.editable) {
    throw new HttpError(
      400,
      `The ${row.programYear} enrollment deadline has passed, so this form can no longer be changed. Contact qi@cpcqc.org if something needs correcting.`,
    );
  }

  const full: EnrollmentSubmitInput = {
    ...input,
    programYear: row.programYear,
    hospitalId: row.hospitalId,
    initiativeCode: row.initiativeCode as InitiativeCode,
  };
  const isTtt = row.initiativeCode === 'TTT';
  // A TtT form that listed champions keeps needing them when edited.
  const tttRoster =
    isTtt &&
    ((((row.champions as Champion[] | null) ?? []).length > 0) ||
      (await getEnrollmentContext(row.hospitalId, 'TTT', row.programYear)).needsTttRoster);
  validate(full, tttRoster);

  await db
    .update(schema.enrollmentForms)
    .set({
      submitterName: input.submitterName.trim(),
      submitterRole: input.submitterRole.trim(),
      submitterEmail: input.submitterEmail.trim(),
      ehr: isTtt ? null : (input.ehr ?? null),
      ehrOther: isTtt ? null : (input.ehrOther?.trim() || null),
      champions: isTtt && !tttRoster ? null : (input.champions ?? []),
      tttContinuationAttested: isTtt ? !!input.tttContinuationAttested : false,
      updatedAt: new Date(),
    })
    .where(eq(schema.enrollmentForms.id, row.id));

  return { updated: true };
}
