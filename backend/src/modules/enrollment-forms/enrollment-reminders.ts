/**
 * Reminders to hospitals that still owe an enrollment form: a preview of who
 * would get what, a test copy to the staff member sending, then the send, in
 * batches like the welcome emails.
 *
 * Who still owes a form comes from the chase list; who to remind, from who
 * each form was sent to (reminder-plan.ts); the wording, from
 * enrollment-emails.ts. Every reminder is recorded in
 * enrollment_form_reminders, which shows when a hospital was last reminded
 * and keeps a day's reminders from going twice.
 */
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import type { AuthContext } from '@/middleware/auth.js';
import { env, frontendBaseUrl } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import { getEnrollmentStepWindow, type EnrollmentWindowState } from './enrollment-forms.service.js';
import { getStaffEnrollmentOverview } from './enrollment-forms.staff.js';
import { SHARED_ROSTER, savedSheetRows } from './enrollment-welcome.js';
import { enrollmentFormUrl, greetingFor, longDate, reminderEmail } from './enrollment-emails.js';
import { planReminders, type PlannedReminder } from './reminder-plan.js';
import { nameKey, type PlanNote } from './welcome-plan.js';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A day as CPCQC counts it, in Colorado. */
const denverDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Denver' });

export interface ReminderPreviewEmail extends PlannedReminder {
  subject: string;
  body: string;
  /** What recipients see: the email with each link named. */
  html: string;
}

export interface ReminderPreview {
  programYear: number;
  window: EnrollmentWindowState;
  /** Why sending is refused right now, or null when it can go. */
  blocker: string | null;
  emails: ReminderPreviewEmail[];
  held: PlanNote[];
  skipped: PlanNote[];
}

export async function previewReminders(programYear: number, ctx: AuthContext): Promise<ReminderPreview> {
  const overview = await getStaffEnrollmentOverview(programYear, ctx);
  const [reminded, hospitals, sheet, window] = await Promise.all([
    db
      .select({
        hospitalId: schema.enrollmentFormReminders.hospitalId,
        code: schema.enrollmentFormReminders.initiativeCode,
        createdAt: schema.enrollmentFormReminders.createdAt,
      })
      .from(schema.enrollmentFormReminders)
      .where(eq(schema.enrollmentFormReminders.programYear, programYear)),
    db.select({ id: schema.hospitals.id, name: schema.hospitals.name }).from(schema.hospitals),
    savedSheetRows(programYear),
    getEnrollmentStepWindow(programYear),
  ]);

  const plan = planReminders({
    outstanding: overview.coverage.flatMap((c) =>
      c.outstanding.map((h) => ({ hospitalId: h.id, hospitalName: h.name, code: c.initiativeCode })),
    ),
    sent: overview.sent.map((s) => ({
      hospitalId: s.hospital.id,
      code: s.initiativeCode,
      toEmail: s.toEmail,
      toName: s.toName,
      emailSent: s.emailSent,
      sentAt: s.sentAt,
    })),
    reminded: reminded.map((r) => ({ hospitalId: r.hospitalId, code: r.code, sentAt: denverDay(r.createdAt) })),
    hospitals,
    sharedRoster: SHARED_ROSTER,
    today: denverDay(new Date()),
  });

  // A hospital with no interest form is reminded as a team, as it was welcomed.
  const noForm = new Set((sheet ?? []).filter((r) => r.filedInterestForm === false).map((r) => nameKey(r.hospital)));
  const base = frontendBaseUrl();
  const emails = plan.emails.map((e) => ({
    ...e,
    ...reminderEmail({
      recipientName: greetingFor(e.recipients.map((r) => r.name)),
      programYear,
      forTeam: noForm.has(nameKey(e.hospitals[0]!.name)),
      links: e.links.map((l) => ({
        code: l.code,
        hospitalName: l.hospitalName,
        url: enrollmentFormUrl(base, programYear, l.hospitalId, l.code),
      })),
      closesAt: window.closesAt,
    }),
  }));

  const blocker =
    window.state === 'open'
      ? null
      : window.state === 'after'
        ? `The ${programYear} enrollment window closed on ${longDate(window.closesAt!)}.`
        : `The ${programYear} enrollment forms aren't open yet, so the links wouldn't work.`;

  return { programYear, window, blocker, emails, held: plan.held, skipped: plan.skipped };
}

/** One reminder, sent to the staff member themselves, so they see what hospitals will. */
export async function sendReminderTest(
  programYear: number,
  index: number,
  ctx: AuthContext,
): Promise<{ sentTo: string; emailSent: boolean }> {
  const e = (await previewReminders(programYear, ctx)).emails[index];
  if (!e) throw new HttpError(400, 'There is no reminder at that position to test.');
  const me = ctx.userId
    ? await db.query.users.findFirst({ where: eq(schema.users.id, ctx.userId) })
    : undefined;
  if (!me?.email) throw new HttpError(400, 'Your account has no email address to send the test to.');
  const note =
    'Test copy. In the real send this goes to ' +
    `${e.recipients.map((r) => `${r.name} <${r.email}>`).join(', ')}.`;
  const result = await sendEmail({
    toEmail: me.email,
    fromEmail: env.EMAIL_FROM_ENROLLMENT,
    kind: 'enrollment.reminder_test',
    subject: `[Test] ${e.subject}`,
    body: `${note}\n\n${e.body}`,
    html: `<p style="font-family:Arial,Helvetica,sans-serif;color:#C1534E;">${escapeHtml(note)}</p>${e.html}`,
  });
  return { sentTo: me.email, emailSent: result.sent };
}

export interface ReminderSendResult {
  sent: number;
  failed: Array<{ hospital: string; toEmail: string; error: string | null }>;
  /** Still to send; the page calls again until it is 0. */
  remaining: number;
}

/**
 * Sends up to `max` of the planned reminders. The page calls again until none
 * remain: each call re-plans, and what has been reminded today drops out.
 */
export async function sendReminders(
  programYear: number,
  max: number,
  ctx: AuthContext,
): Promise<ReminderSendResult> {
  const preview = await previewReminders(programYear, ctx);
  if (preview.blocker) throw new HttpError(409, preview.blocker);

  const batch = preview.emails.slice(0, max);
  const result: ReminderSendResult = { sent: 0, failed: [], remaining: preview.emails.length - batch.length };
  for (const e of batch) {
    const [first, ...rest] = e.recipients;
    const outcome = await sendEmail({
      toEmail: first!.email,
      alsoTo: rest.map((r) => r.email),
      fromEmail: env.EMAIL_FROM_ENROLLMENT,
      kind: 'enrollment.reminder',
      subject: e.subject,
      body: e.body,
      html: e.html,
    });
    if (outcome.sent || !env.SENDGRID_API_KEY) result.sent += 1;
    else {
      result.failed.push({
        hospital: e.hospitals[0]!.name,
        toEmail: e.recipients.map((r) => r.email).join(', '),
        error: outcome.error ?? null,
      });
    }
    // Recorded even when SendGrid refused it, so the same day's next batch
    // doesn't try it again; the Sent list's Resend reaches a fixed address.
    const now = new Date();
    await db.insert(schema.enrollmentFormReminders).values(
      e.links.flatMap((l) =>
        e.recipients.map((r) => ({
          id: uuid(),
          programYear,
          hospitalId: l.hospitalId,
          initiativeCode: l.code,
          toEmail: r.email,
          toName: r.name,
          sentByUserId: ctx.userId ?? null,
          emailSent: outcome.sent,
          createdAt: now,
          updatedAt: now,
        })),
      ),
    );
  }

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: ctx.userId ?? null,
    actorRole: ctx.role,
    action: 'enrollment_form.reminders_sent',
    entityType: 'enrollment_window',
    entityId: String(programYear),
    diff: { programYear, emails: batch.length, failed: result.failed.length, remaining: result.remaining },
    note: `Sent ${batch.length} enrollment reminder(s).`,
  });

  return result;
}
