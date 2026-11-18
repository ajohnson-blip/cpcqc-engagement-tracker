/**
 * Onboarding dates and registration for enrolled hospitals.
 *
 * Each initiative's PM writes its details on the enrollment-forms page. Once
 * they are saved:
 *   - a new submission's receipt carries them, and the champions the form
 *     names get them in their own email (deliverOnboardingOnSubmit);
 *   - hospitals that submitted earlier get them from the page's send, previewed
 *     first and sent in batches like the reminders.
 *
 * Every send is recorded in enrollment_onboarding_sends against the version of
 * the details it carried, so nobody gets the same version twice, and staff can
 * see who got an earlier one. Who gets what is decided in onboarding-plan.ts;
 * the wording is in enrollment-emails.ts.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import type { AuthContext } from '@/middleware/auth.js';
import { env } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import {
  INITIATIVE_SHORT,
  hasOnboarding,
  onboardingEmail,
  type FormInitiativeCode,
  type OnboardingContent,
  type OnboardingSession,
} from './enrollment-emails.js';
import {
  onboardingRecipients,
  planOnboarding,
  type OnboardingForm,
  type OnboardingPlan,
  type PlannedOnboarding,
} from './onboarding-plan.js';
import type { PlanNote } from './welcome-plan.js';
import type { Champion } from './enrollment-forms.service.js';

const CODES: FormInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A day as CPCQC counts it, in Colorado. */
const denverDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

// -------- The details --------

export interface OnboardingDetailsView extends OnboardingContent {
  initiativeCode: FormInitiativeCode;
  /** Null until first saved. */
  version: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** What a hospital team would get, with an example hospital; null until set. */
  sample: { subject: string; html: string } | null;
}

function contentOf(row: typeof schema.enrollmentOnboardingDetails.$inferSelect): OnboardingContent {
  return { sessions: (row.sessions as OnboardingSession[] | null) ?? [], note: row.note };
}

export async function getOnboardingDetails(programYear: number): Promise<OnboardingDetailsView[]> {
  const rows = await db
    .select({ d: schema.enrollmentOnboardingDetails, u: schema.users })
    .from(schema.enrollmentOnboardingDetails)
    .leftJoin(schema.users, eq(schema.users.id, schema.enrollmentOnboardingDetails.updatedByUserId))
    .where(eq(schema.enrollmentOnboardingDetails.programYear, programYear));
  return CODES.map((code) => {
    const r = rows.find((x) => x.d.initiativeCode === code);
    if (!r) {
      return {
        initiativeCode: code,
        sessions: [],
        note: null,
        version: null,
        updatedAt: null,
        updatedBy: null,
        sample: null,
      };
    }
    const content = contentOf(r.d);
    const sample = hasOnboarding(content)
      ? onboardingEmail({
          recipientName: null,
          forTeam: true,
          hospitalName: 'Example Hospital',
          initiativeCode: code,
          programYear,
          onboarding: content,
        })
      : null;
    return {
      initiativeCode: code,
      ...content,
      version: r.d.version,
      updatedAt: r.d.updatedAt.toISOString(),
      updatedBy: r.u ? [r.u.firstName, r.u.lastName].filter(Boolean).join(' ') || r.u.email : null,
      sample: sample ? { subject: sample.subject, html: sample.html } : null,
    };
  });
}

/** Saves an initiative's details. Every save is a new version. */
export async function saveOnboardingDetails(
  programYear: number,
  code: FormInitiativeCode,
  content: OnboardingContent,
  ctx: AuthContext,
): Promise<OnboardingDetailsView> {
  const clean: OnboardingContent = {
    sessions: content.sessions.map((s) => ({
      title: s.title.trim(),
      when: s.when.trim(),
      registrationUrl: s.registrationUrl?.trim() || null,
    })),
    note: content.note?.trim() || null,
  };
  const existing = await db.query.enrollmentOnboardingDetails.findFirst({
    where: and(
      eq(schema.enrollmentOnboardingDetails.programYear, programYear),
      eq(schema.enrollmentOnboardingDetails.initiativeCode, code),
    ),
  });
  const now = new Date();
  if (existing) {
    await db
      .update(schema.enrollmentOnboardingDetails)
      .set({
        sessions: clean.sessions,
        note: clean.note,
        version: existing.version + 1,
        updatedByUserId: ctx.userId ?? null,
        updatedAt: now,
      })
      .where(eq(schema.enrollmentOnboardingDetails.id, existing.id));
  } else {
    await db.insert(schema.enrollmentOnboardingDetails).values({
      id: uuid(),
      programYear,
      initiativeCode: code,
      sessions: clean.sessions,
      note: clean.note,
      version: 1,
      updatedByUserId: ctx.userId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: ctx.userId ?? null,
    actorRole: ctx.role,
    action: 'enrollment_onboarding.details_saved',
    entityType: 'enrollment_onboarding',
    entityId: `${programYear}:${code}`,
    diff: { ...clean, version: (existing?.version ?? 0) + 1 },
    note: `Saved the ${programYear} ${code} onboarding details (version ${(existing?.version ?? 0) + 1}).`,
  });
  return (await getOnboardingDetails(programYear)).find((d) => d.initiativeCode === code)!;
}

/** An initiative's details and their version, or null while there is nothing to send. */
export async function currentOnboarding(
  programYear: number,
  code: FormInitiativeCode,
): Promise<{ content: OnboardingContent; version: number } | null> {
  const row = await db.query.enrollmentOnboardingDetails.findFirst({
    where: and(
      eq(schema.enrollmentOnboardingDetails.programYear, programYear),
      eq(schema.enrollmentOnboardingDetails.initiativeCode, code),
    ),
  });
  if (!row) return null;
  const content = contentOf(row);
  return hasOnboarding(content) ? { content, version: row.version } : null;
}

// -------- Who gets them --------

type FormRow = typeof schema.enrollmentForms.$inferSelect;

function asOnboardingForm(row: FormRow, hospitalName: string): OnboardingForm {
  return {
    formId: row.id,
    hospitalId: row.hospitalId,
    hospitalName,
    code: row.initiativeCode as FormInitiativeCode,
    submitterName: row.submitterName,
    submitterEmail: row.submitterEmail,
    champions: ((row.champions as Champion[] | null) ?? [])
      .filter((c) => c.name?.trim() && c.email?.trim())
      .map((c) => ({ name: c.name, email: c.email })),
  };
}

/** `${hospitalId}:${code}` → the roster, for forms that name no champions. */
async function rosters(hospitalIds: string[]) {
  const map = new Map<string, Array<{ name: string; email: string | null }>>();
  if (hospitalIds.length === 0) return map;
  const rows = await db
    .select({
      hospitalId: schema.hospitalStaffMembers.hospitalId,
      code: schema.initiatives.code,
      name: schema.hospitalStaffMembers.name,
      email: schema.hospitalStaffMembers.email,
    })
    .from(schema.hospitalStaffMembers)
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.hospitalStaffMembers.initiativeId))
    .where(
      and(inArray(schema.hospitalStaffMembers.hospitalId, hospitalIds), isNotNull(schema.hospitalStaffMembers.email)),
    );
  for (const r of rows) {
    const k = `${r.hospitalId}:${r.code}`;
    map.set(k, [...(map.get(k) ?? []), { name: r.name, email: r.email }]);
  }
  return map;
}

async function record(
  rows: Array<{
    form: OnboardingForm;
    programYear: number;
    toEmail: string;
    toName: string;
    version: number;
    via: 'receipt' | 'submit' | 'send';
    emailSent: boolean;
    sentByUserId: string | null;
  }>,
) {
  if (rows.length === 0) return;
  const now = new Date();
  await db.insert(schema.enrollmentOnboardingSends).values(
    rows.map((r) => ({
      id: uuid(),
      programYear: r.programYear,
      enrollmentFormId: r.form.formId,
      hospitalId: r.form.hospitalId,
      initiativeCode: r.form.code,
      toEmail: r.toEmail,
      toName: r.toName || null,
      detailsVersion: r.version,
      via: r.via,
      sentByUserId: r.sentByUserId,
      emailSent: r.emailSent,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/**
 * On submission, once the receipt (which carried the details) has gone to the
 * submitter: records that, then emails the form's other champions.
 */
export async function deliverOnboardingOnSubmit(
  row: FormRow,
  hospitalName: string,
  onboarding: { content: OnboardingContent; version: number },
  receiptSent: boolean,
): Promise<void> {
  const form = asOnboardingForm(row, hospitalName);
  const roster = (await rosters([row.hospitalId])).get(`${row.hospitalId}:${form.code}`) ?? [];
  const [submitter, ...others] = onboardingRecipients(form, roster);
  const base = { form, programYear: row.programYear, version: onboarding.version, sentByUserId: null };
  if (submitter) {
    await record([{ ...base, toEmail: submitter.email, toName: submitter.name, via: 'receipt', emailSent: receiptSent }]);
  }
  if (others.length === 0) return;
  const email = onboardingEmail({
    recipientName: others[0]!.name,
    forTeam: others.length > 1,
    hospitalName,
    initiativeCode: form.code,
    programYear: row.programYear,
    onboarding: onboarding.content,
  });
  const [first, ...rest] = others;
  const outcome = await sendEmail({
    toEmail: first!.email,
    alsoTo: rest.map((r) => r.email),
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'enrollment.onboarding',
    ...email,
  });
  await record(others.map((r) => ({ ...base, toEmail: r.email, toName: r.name, via: 'submit', emailSent: outcome.sent })));
}

// -------- The send from the staff page --------

export interface OnboardingOptions {
  includeUpdated: boolean;
  includeFailed: boolean;
  /** ISO timestamp: forms attempted since then are left out. */
  attemptedSince?: string | null;
  /** One initiative only, as each PM sends their own; null for all. */
  initiative?: FormInitiativeCode | null;
}

export interface OnboardingPreviewEmail extends PlannedOnboarding {
  subject: string;
  body: string;
  html: string;
}

export interface OnboardingPreview {
  programYear: number;
  emails: OnboardingPreviewEmail[];
  held: PlanNote[];
  skipped: PlanNote[];
  updated: PlanNote[];
  failed: PlanNote[];
}

async function plan(programYear: number, opts: OnboardingOptions) {
  const [forms, details, sends] = await Promise.all([
    db
      .select({ f: schema.enrollmentForms, hospitalName: schema.hospitals.name })
      .from(schema.enrollmentForms)
      .innerJoin(schema.hospitals, eq(schema.hospitals.id, schema.enrollmentForms.hospitalId))
      .where(and(eq(schema.enrollmentForms.programYear, programYear), isNotNull(schema.enrollmentForms.verifiedAt))),
    db
      .select()
      .from(schema.enrollmentOnboardingDetails)
      .where(eq(schema.enrollmentOnboardingDetails.programYear, programYear)),
    db
      .select()
      .from(schema.enrollmentOnboardingSends)
      .where(eq(schema.enrollmentOnboardingSends.programYear, programYear)),
  ]);

  const content = new Map<FormInitiativeCode, OnboardingContent>();
  const versions: Partial<Record<FormInitiativeCode, number>> = {};
  for (const d of details) {
    const c = contentOf(d);
    if (!hasOnboarding(c)) continue;
    content.set(d.initiativeCode as FormInitiativeCode, c);
    versions[d.initiativeCode as FormInitiativeCode] = d.version;
  }

  const result: OnboardingPlan = planOnboarding({
    forms: forms.map((r) => asOnboardingForm(r.f, r.hospitalName)),
    roster: await rosters([...new Set(forms.map((r) => r.f.hospitalId))]),
    versions,
    sends: sends.map((s) => ({
      formId: s.enrollmentFormId,
      version: s.detailsVersion,
      emailSent: s.emailSent,
      sentAt: s.createdAt.toISOString(),
      sentDay: denverDay(s.createdAt),
      toEmail: s.toEmail,
    })),
    includeUpdated: opts.includeUpdated,
    includeFailed: opts.includeFailed,
    attemptedSince: opts.attemptedSince ?? null,
    initiative: opts.initiative ?? null,
  });
  return { result, content, forms: new Map(forms.map((r) => [r.f.id, asOnboardingForm(r.f, r.hospitalName)])) };
}

export async function previewOnboarding(programYear: number, opts: OnboardingOptions): Promise<OnboardingPreview> {
  return (await buildPreview(programYear, opts)).preview;
}

async function buildPreview(programYear: number, opts: OnboardingOptions) {
  const { result, content, forms } = await plan(programYear, opts);
  const preview: OnboardingPreview = {
    programYear,
    ...result,
    emails: result.emails.map((e) => ({
      ...e,
      ...onboardingEmail({
        recipientName: e.recipients[0]?.name ?? null,
        forTeam: e.recipients.length > 1,
        hospitalName: e.hospital.name,
        initiativeCode: e.code,
        programYear,
        onboarding: content.get(e.code)!,
        update: e.update,
      }),
    })),
  };
  return { preview, forms };
}

/** One onboarding email, sent to the staff member themselves, so they see what hospitals will. */
export async function sendOnboardingTest(
  programYear: number,
  index: number,
  opts: OnboardingOptions,
  ctx: AuthContext,
): Promise<{ sentTo: string; emailSent: boolean }> {
  const e = (await previewOnboarding(programYear, opts)).emails[index];
  if (!e) throw new HttpError(400, 'There is no onboarding email at that position to test.');
  const me = ctx.userId ? await db.query.users.findFirst({ where: eq(schema.users.id, ctx.userId) }) : undefined;
  if (!me?.email) throw new HttpError(400, 'Your account has no email address to send the test to.');
  const note =
    'Test copy. In the real send this goes to ' +
    `${e.recipients.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(', ')}.`;
  const result = await sendEmail({
    toEmail: me.email,
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'enrollment.onboarding_test',
    subject: `[Test] ${e.subject}`,
    body: `${note}\n\n${e.body}`,
    html: `<p style="font-family:Arial,Helvetica,sans-serif;color:#C1534E;">${escapeHtml(note)}</p>${e.html}`,
  });
  return { sentTo: me.email, emailSent: result.sent };
}

export interface OnboardingSendResult {
  sent: number;
  failed: Array<{ hospital: string; toEmail: string; error: string | null }>;
  /** Still to send; the page calls again until it is 0. */
  remaining: number;
  /** When this run started, by the server's clock: pass it back with the next batch. */
  since: string;
}

/**
 * Sends up to `max` of the planned emails. The first call starts a run; the
 * page calls again with the `since` it returned until none remain. Each call
 * re-plans, and what this run already tried drops out, whether or not it went
 * through, so even retries of failures can't loop.
 */
export async function sendOnboarding(
  programYear: number,
  max: number,
  opts: OnboardingOptions,
  ctx: AuthContext,
): Promise<OnboardingSendResult> {
  const since = opts.attemptedSince ?? new Date().toISOString();
  const { preview, forms } = await buildPreview(programYear, { ...opts, attemptedSince: since });
  const batch = preview.emails.slice(0, max);
  const result: OnboardingSendResult = {
    sent: 0,
    failed: [],
    remaining: preview.emails.length - batch.length,
    since,
  };

  for (const e of batch) {
    const [first, ...rest] = e.recipients;
    const outcome = await sendEmail({
      toEmail: first!.email,
      alsoTo: rest.map((r) => r.email),
      fromEmail: env.EMAIL_FROM_ENROLLMENT,
      kind: 'enrollment.onboarding',
      subject: e.subject,
      body: e.body,
      html: e.html,
    });
    if (outcome.sent || !env.SENDGRID_API_KEY) result.sent += 1;
    else {
      result.failed.push({
        hospital: `${e.hospital.name} (${INITIATIVE_SHORT[e.code]})`,
        toEmail: e.recipients.map((r) => r.email).join(', '),
        error: outcome.error ?? null,
      });
    }
    // Recorded even when refused, so this run doesn't try it again.
    await record(
      e.recipients.map((r) => ({
        form: forms.get(e.formId)!,
        programYear,
        toEmail: r.email,
        toName: r.name,
        version: e.version,
        via: 'send' as const,
        emailSent: outcome.sent,
        sentByUserId: ctx.userId ?? null,
      })),
    );
  }

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: ctx.userId ?? null,
    actorRole: ctx.role,
    action: 'enrollment_onboarding.sent',
    entityType: 'enrollment_window',
    entityId: String(programYear),
    diff: {
      programYear,
      emails: batch.length,
      failed: result.failed.length,
      remaining: result.remaining,
      includeUpdated: opts.includeUpdated,
      includeFailed: opts.includeFailed,
      initiative: opts.initiative ?? null,
    },
    note: `Sent ${batch.length} ${opts.initiative ? `${opts.initiative} ` : ''}onboarding email(s).`,
  });

  return result;
}
