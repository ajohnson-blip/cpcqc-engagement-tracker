/**
 * The welcome-to-enroll send, from the uploaded enrollment-decisions sheet.
 *
 * The upload is saved (enrollment_acceptance_sheets), so it survives a page
 * refresh and any staff member can work from it. Then three steps, each
 * re-planning from the saved sheet and today's records so nothing goes out
 * from a stale plan: a preview listing every email and everything held or
 * skipped, a test copy of one email to the staff member sending, then the
 * send itself. Every email sent is recorded in enrollment_form_invitations,
 * which puts the hospital on that initiative's chase list and means nothing
 * is sent twice.
 *
 * Who receives what is decided in welcome-plan.ts; the wording is in
 * enrollment-emails.ts.
 */
import ExcelJS from 'exceljs';
import { and, desc, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import type { AuthContext } from '@/middleware/auth.js';
import { env, frontendBaseUrl } from '@/config/env.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import { csvToRows } from '@/modules/ce/ce-roster.js';
import { getEnrollmentStepWindow, type EnrollmentWindowState } from './enrollment-forms.service.js';
import { enrollmentFormUrl, greetingFor, longDate, welcomeEmail } from './enrollment-emails.js';
import {
  cellValue,
  interestFormAcceptances,
  nameKey,
  notTakingUp,
  parseAcceptanceSheet,
  planWelcomeEmails,
  type PlanNote,
  type PlannedEmail,
} from './welcome-plan.js';
import type { FormInitiativeCode } from './enrollment-emails.js';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * UCHealth Memorial enrolled as one hospital in 2026. From 2027 Central and
 * North each file their own forms, and both go to the champions on the
 * combined roster, which stayed with Central when the record was split.
 */
const SHARED_ROSTER: Record<string, string> = {
  'UCHealth Memorial Hospital North': 'UCHealth Memorial Hospital Central',
};

/** The interest form's acceptances; TtT continues without one. */
const ACCEPTABLE = ['SPARK', 'SOAR', 'NEST'];

export interface WelcomePreviewEmail extends PlannedEmail {
  subject: string;
  body: string;
  /** What most recipients see: the same email with each link named. */
  html: string;
}

/** The saved sheet a preview was made from. */
export interface SavedSheetMeta {
  id: string;
  fileName: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
}

export interface WelcomePreview {
  programYear: number;
  sheet: SavedSheetMeta;
  window: EnrollmentWindowState;
  /** Why sending is refused right now, or null when it can go. */
  blocker: string | null;
  emails: WelcomePreviewEmail[];
  held: PlanNote[];
  skipped: PlanNote[];
}

function assertStaff(ctx: AuthContext) {
  if (ctx.role !== 'cpcqc_staff' && ctx.role !== 'cpcqc_admin') throw new HttpError(403, 'Staff only.');
}

/** The uploaded file as rows of cells: the Board tab of a workbook, or a CSV. */
async function sheetRows(buf: Buffer): Promise<unknown[][]> {
  if (!buf || buf.length === 0) throw new HttpError(400, 'No file received.');
  const isXlsx = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b; // 'PK'
  if (!isXlsx) return csvToRows(buf.toString('utf8'));

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'That file could not be read as a spreadsheet. Upload a .xlsx or .csv.');
  }
  // A download of the whole decisions workbook has several tabs.
  const sheet = wb.worksheets.find((w) => w.name.trim().toLowerCase() === 'board') ?? wb.worksheets[0];
  if (!sheet) throw new HttpError(400, 'The workbook has no sheets.');
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cellValue(cell.value);
    });
    rows[rowNumber - 1] = cells;
  });
  return Array.from(rows, (r) => Array.from(r ?? [], (c) => cellValue(c)));
}

/** The year's sheet in use: the latest upload. */
async function latestSheet(programYear: number) {
  const [row] = await db
    .select({
      sheet: schema.enrollmentAcceptanceSheets,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      email: schema.users.email,
    })
    .from(schema.enrollmentAcceptanceSheets)
    .leftJoin(schema.users, eq(schema.users.id, schema.enrollmentAcceptanceSheets.uploadedByUserId))
    .where(eq(schema.enrollmentAcceptanceSheets.programYear, programYear))
    .orderBy(desc(schema.enrollmentAcceptanceSheets.createdAt))
    .limit(1);
  return row ?? null;
}

/** Saves an uploaded sheet as the year's one in use, refusing a file that can't be read. */
export async function saveWelcomeSheet(
  buf: Buffer,
  fileName: string | null,
  programYear: number,
  ctx: AuthContext,
): Promise<WelcomePreview> {
  assertStaff(ctx);
  const rows = await sheetRows(buf);
  try {
    parseAcceptanceSheet(rows);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'Could not read the sheet.');
  }
  await db.insert(schema.enrollmentAcceptanceSheets).values({
    id: uuid(),
    programYear,
    fileName: fileName?.trim().slice(0, 200) || null,
    rows,
    uploadedByUserId: ctx.userId ?? null,
  });
  return (await previewWelcome(programYear, ctx))!;
}

/** The preview from the saved sheet, or null before anything is uploaded. */
export async function previewWelcome(programYear: number, ctx: AuthContext): Promise<WelcomePreview | null> {
  return (await prepareWelcome(programYear, null, ctx))?.preview ?? null;
}

/**
 * The hospitals (by name key) the saved sheet marks as not taking up an
 * initiative, e.g. withdrawing from Turning the Tide. Empty without a sheet.
 */
export async function sheetNotTakingUp(programYear: number, code: FormInitiativeCode): Promise<Set<string>> {
  const saved = await latestSheet(programYear);
  return saved ? notTakingUp(parseAcceptanceSheet(saved.sheet.rows as unknown[][]), code) : new Set();
}

/**
 * What the saved sheet says about one hospital: everything it was accepted
 * into, and whether it filed an interest form. The single send uses it so a
 * resent email reads like the original. Null without a sheet or a row.
 */
export async function sheetDecisionFor(
  programYear: number,
  hospitalName: string,
): Promise<{ accepted: FormInitiativeCode[]; filedInterestForm: boolean | null } | null> {
  const saved = await latestSheet(programYear);
  if (!saved) return null;
  const row = parseAcceptanceSheet(saved.sheet.rows as unknown[][]).find(
    (r) => nameKey(r.hospital) === nameKey(hospitalName),
  );
  return row ? { accepted: row.send, filedInterestForm: row.filedInterestForm } : null;
}

/**
 * The preview, plus what the interest forms should record once it is sent.
 * Given a sheet id, refuses if a newer sheet has been uploaded since, so a
 * send always goes from the sheet that was previewed.
 */
async function prepareWelcome(
  programYear: number,
  sheetId: string | null,
  ctx: AuthContext,
): Promise<{ preview: WelcomePreview; acceptances: Map<string, string[]> } | null> {
  assertStaff(ctx);
  const saved = await latestSheet(programYear);
  if (!saved) {
    if (sheetId) throw new HttpError(409, 'No sheet has been uploaded for this year.');
    return null;
  }
  if (sheetId && saved.sheet.id !== sheetId) {
    throw new HttpError(409, 'A newer sheet has been uploaded since this preview. Check its preview before sending.');
  }
  const sheet = parseAcceptanceSheet(saved.sheet.rows as unknown[][]);
  const sheetMeta: SavedSheetMeta = {
    id: saved.sheet.id,
    fileName: saved.sheet.fileName,
    uploadedAt: saved.sheet.createdAt.toISOString(),
    uploadedBy: [saved.firstName, saved.lastName].filter(Boolean).join(' ') || saved.email || null,
  };

  const [hospitals, interest, roster, filed, sent, window] = await Promise.all([
    db.select({ id: schema.hospitals.id, name: schema.hospitals.name }).from(schema.hospitals),
    db
      .select({
        hospitalId: schema.annualInterestForms.hospitalId,
        submitterName: schema.annualInterestForms.submitterName,
        submitterEmail: schema.annualInterestForms.submitterEmail,
      })
      .from(schema.annualInterestForms)
      .where(eq(schema.annualInterestForms.programYear, programYear)),
    db
      .select({
        hospitalId: schema.hospitalStaffMembers.hospitalId,
        initiativeCode: schema.initiatives.code,
        name: schema.hospitalStaffMembers.name,
        email: schema.hospitalStaffMembers.email,
      })
      .from(schema.hospitalStaffMembers)
      .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.hospitalStaffMembers.initiativeId)),
    db
      .select({ hospitalId: schema.enrollmentForms.hospitalId, code: schema.enrollmentForms.initiativeCode })
      .from(schema.enrollmentForms)
      .where(eq(schema.enrollmentForms.programYear, programYear)),
    db
      .select({
        hospitalId: schema.enrollmentFormInvitations.hospitalId,
        code: schema.enrollmentFormInvitations.initiativeCode,
        createdAt: schema.enrollmentFormInvitations.createdAt,
      })
      .from(schema.enrollmentFormInvitations)
      .where(eq(schema.enrollmentFormInvitations.programYear, programYear)),
    getEnrollmentStepWindow(programYear),
  ]);

  const firstSent = new Map<string, string>();
  for (const s of [...sent].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const k = `${s.hospitalId}:${s.code}`;
    if (!firstSent.has(k)) firstSent.set(k, s.createdAt.toISOString().slice(0, 10));
  }

  const plan = planWelcomeEmails({
    sheet,
    hospitals,
    interestForms: new Map(interest.map((i) => [i.hospitalId, i])),
    roster,
    filed: new Set(filed.map((f) => `${f.hospitalId}:${f.code}`)),
    sent: firstSent,
    sharedRoster: SHARED_ROSTER,
  });

  const base = frontendBaseUrl();
  const emails = plan.emails.map((e) => ({
    ...e,
    ...welcomeEmail({
      recipientName: greetingFor(e.recipients.map((r) => r.name)),
      programYear,
      accepted: e.accepted,
      forTeam: e.forTeam,
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
      : window.state === 'before'
        ? window.opensAt
          ? `The ${programYear} enrollment forms don't open until ${longDate(window.opensAt)}, so the links wouldn't work yet.`
          : `The ${programYear} enrollment window has no dates yet, so the links wouldn't work.`
        : `The ${programYear} enrollment window closed on ${longDate(window.closesAt!)}.`;

  const withForms = new Set(interest.map((i) => i.hospitalId));
  return {
    preview: { programYear, sheet: sheetMeta, window, blocker, emails, held: plan.held, skipped: plan.skipped },
    acceptances: interestFormAcceptances(sheet, hospitals, (id) => withForms.has(id)),
  };
}

/** One email, sent to the staff member themselves, so they see what hospitals will. */
export async function sendWelcomeTest(
  programYear: number,
  sheetId: string,
  index: number,
  ctx: AuthContext,
): Promise<{ sentTo: string; emailSent: boolean }> {
  const prepared = await prepareWelcome(programYear, sheetId, ctx);
  const e = prepared?.preview.emails[index];
  if (!e) throw new HttpError(400, 'There is no email at that position to test.');
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
    kind: 'enrollment.welcome_test',
    subject: `[Test] ${e.subject}`,
    body: `${note}\n\n${e.body}`,
    html: `<p style="font-family:Arial,Helvetica,sans-serif;color:#C1534E;">${escapeHtml(note)}</p>${e.html}`,
  });
  return { sentTo: me.email, emailSent: result.sent };
}

export interface WelcomeSendResult {
  sent: number;
  /** SendGrid refused these; they are recorded and can be re-sent from the Send button. */
  failed: Array<{ hospital: string; toEmail: string; error: string | null }>;
  /** Still to send; the page calls again until it is 0. */
  remaining: number;
}

/**
 * Sends up to `max` of the planned emails. The page calls again until none
 * remain: each call re-plans and skips what has gone, so a batch cut short by
 * a timeout loses nothing and sends nothing twice. Batches keep each request
 * well inside the frontend proxy's timeout.
 */
export async function sendWelcome(
  programYear: number,
  sheetId: string,
  max: number,
  ctx: AuthContext,
): Promise<WelcomeSendResult> {
  const { preview, acceptances } = (await prepareWelcome(programYear, sheetId, ctx))!;
  if (preview.blocker) throw new HttpError(409, preview.blocker);

  const batch = preview.emails.slice(0, max);
  const result: WelcomeSendResult = { sent: 0, failed: [], remaining: preview.emails.length - batch.length };
  for (const e of batch) {
    const [first, ...rest] = e.recipients;
    const outcome = await sendEmail({
      toEmail: first!.email,
      alsoTo: rest.map((r) => r.email),
      fromEmail: env.EMAIL_FROM_ENROLLMENT,
      kind: 'enrollment.welcome',
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

    // Recorded even when SendGrid refused it, as the Send button does: the
    // decision that the hospital owes the form stands.
    const now = new Date();
    // One row per person per form, so a PM can see who was sent what.
    await db.insert(schema.enrollmentFormInvitations).values(
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

  // The interest forms record the sheet's acceptances, so the interest-form
  // screen and the chase list agree with what hospitals were told. Written
  // directly: the screen's own accept would email them again.
  const now = new Date();
  for (const [hospitalId, codes] of acceptances) {
    const form = await db.query.annualInterestForms.findFirst({
      where: and(
        eq(schema.annualInterestForms.programYear, programYear),
        eq(schema.annualInterestForms.hospitalId, hospitalId),
      ),
    });
    if (!form) continue;
    const decided = ACCEPTABLE.filter((c) => codes.includes(c));
    const before = (form.decidedInitiatives as string[] | null) ?? null;
    if (before && before.length === decided.length && before.every((c) => decided.includes(c))) continue;
    await db
      .update(schema.annualInterestForms)
      .set({
        // Accepted for nothing (a TtT-only hospital) is a decision too, but
        // not an acceptance; its status is left as it was.
        ...(decided.length > 0 ? { status: 'accepted' as const } : {}),
        decidedInitiatives: decided,
        decidedAt: now,
        decidedBy: ctx.userId ?? null,
        updatedAt: now,
      })
      .where(eq(schema.annualInterestForms.id, form.id));
  }

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: ctx.userId ?? null,
    actorRole: ctx.role,
    action: 'enrollment_form.welcome_sent',
    entityType: 'enrollment_window',
    entityId: String(programYear),
    diff: { programYear, emails: batch.length, failed: result.failed.length, remaining: result.remaining },
    note: `Sent ${batch.length} welcome-to-enroll email(s) from the uploaded acceptances.`,
  });

  return result;
}
