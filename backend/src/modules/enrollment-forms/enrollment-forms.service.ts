/**
 * Step 2 of annual enrollment — the legally mandated enrollment form.
 *
 * Public, like the interest form: hospitals must be able to complete this
 * without a portal account. Identity rests on an emailed token that confirms
 * the address and is the only route to editing afterwards.
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

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export const ENROLLABLE = ['SPARK', 'SOAR', 'NEST', 'TTT'] as const;
export type InitiativeCode = (typeof ENROLLABLE)[number];

export const EHR_OPTIONS = ['Epic', 'Oracle Health (Cerner)', 'MEDITECH', 'Other…'] as const;

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

function validate(input: EnrollmentSubmitInput): void {
  if (!input.submitterName.trim()) throw new HttpError(400, 'Your name is required.');
  if (!input.submitterRole.trim()) throw new HttpError(400, 'Your role is required.');
  if (!input.submitterEmail.trim()) throw new HttpError(400, 'Email is required.');

  // TtT is a continuation: the attestation IS the submission, so no EHR or
  // roster is collected and requiring them would be nonsense.
  if (input.initiativeCode === 'TTT') {
    if (!input.tttContinuationAttested) {
      throw new HttpError(400, 'Confirm the continuation attestation to submit.');
    }
    return;
  }

  if (!input.ehr) throw new HttpError(400, 'Select your hospital EHR.');
  if (input.ehr === 'Other…' && !input.ehrOther?.trim()) {
    throw new HttpError(400, 'Tell us which EHR your hospital uses.');
  }

  const champions = input.champions ?? [];
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
  validate(input);

  if (ctx.alreadySubmitted) {
    throw new HttpError(
      409,
      `${ctx.hospitalName} has already submitted a ${input.programYear} enrollment form for ` +
        `${input.initiativeCode}. To change it, use the link in your confirmation email, or contact qi@cpcqc.org.`,
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
    champions: isTtt ? null : (input.champions ?? []),
    tttContinuationAttested: isTtt ? !!input.tttContinuationAttested : false,
    submitterName: input.submitterName.trim(),
    submitterRole: input.submitterRole.trim(),
    submitterEmail: input.submitterEmail.trim(),
    submitterUserId: null,
    verificationTokenHash: hashToken(token),
    verifiedAt: null,
    submittedVia: 'public',
  });

  const verifyUrl = `${frontendBaseUrl()}/enrollment/verify?token=${encodeURIComponent(token)}`;
  await sendEmail({
    toEmail: input.submitterEmail.trim(),
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'enrollment.verify',
    subject: `Confirm ${ctx.hospitalName}'s ${input.programYear} ${input.initiativeCode} enrollment`,
    body: [
      `Hi ${input.submitterName.trim()},`,
      '',
      `We've received a ${input.programYear} enrollment form for ${ctx.hospitalName} — ${input.initiativeCode}.`,
      '',
      'Please confirm it by opening this link:',
      verifyUrl,
      '',
      'Enrollment is not complete until you do. Keep this link — it is also how you',
      'edit your submission while the window is open.',
      '',
      "If you didn't fill in this form, you can ignore this email and nothing will be recorded.",
      '',
      'Colorado Perinatal Care Quality Collaborative',
    ].join('\n'),
  });

  return { formId: id, sentTo: input.submitterEmail.trim() };
}

/** Confirm from the emailed link. Idempotent; notifies staff once. */
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

    // Confirmation to the hospital, in CPCQC's words.
    await sendEmail({
      toEmail: row.submitterEmail,
      fromEmail: env.EMAIL_FROM_ENROLLMENT,
      kind: 'enrollment.confirmation',
      subject: `${row.initiativeCode} enrollment received — ${hospital?.name ?? 'your hospital'}`,
      body: [
        `Hi ${row.submitterName},`,
        '',
        'Your enrollment form has been received and the program manager will be in contact',
        'with next steps. If you need support, please contact qi@cpcqc.org',
        '',
        `Hospital: ${hospital?.name ?? '—'}`,
        `Initiative: ${row.initiativeCode}`,
        `Program year: ${row.programYear}`,
        '',
        'Colorado Perinatal Care Quality Collaborative',
      ].join('\n'),
    });

    const champions = (row.champions as Champion[] | null) ?? [];
    const named = champions.filter((c) => c.name?.trim());
    const accessRequests = named.filter((c) => c.redcapAccess || c.dashboardAccess);
    await sendEmail({
      toEmail: 'qi@cpcqc.org',
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

  return {
    programYear: row.programYear,
    hospitalName: hospital?.name ?? 'your hospital',
    initiativeCode: row.initiativeCode,
    submitterName: row.submitterName,
    alreadyVerified: !firstConfirmation,
  };
}
