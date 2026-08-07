/**
 * CE certificate service — create a training, import its roster, issue and send
 * certificates, and re-send later.
 *
 * Design notes:
 *  - The PDF is never stored. It's a pure function of (training, recipient), so
 *    it's regenerated on demand — the DB stays small and a template fix reaches
 *    reissues automatically.
 *  - Sending is per-recipient and failure-isolated: one bad address must not
 *    abort a 100-person run. Each certificate carries its own sentAt/sendError.
 *  - Sends are throttled in small concurrent batches. SendGrid needs one API
 *    call per recipient (each attachment differs), and firing 100 at once risks
 *    rate-limiting.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { randomBytes } from 'node:crypto';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import {
  renderCertificatePdf,
  formatTrainingDate,
  formatContactHours,
  certificateFilename,
} from './ce-certificate-pdf.js';
import { ceProgramLabel, isCeProgramCode, loadLogo, CPCQC_LOGO_CODE } from './ce-programs.js';
import { tidyName, isPlausibleEmail, type RosterRow } from './ce-roster.js';

/** How many SendGrid calls are in flight at once. */
const SEND_CONCURRENCY = 4;

export interface TrainingInput {
  programCode: string;
  title: string;
  trainingDate: string;
  contactHours: number;
  activityId: string;
}

function assertValidTraining(input: TrainingInput) {
  if (!isCeProgramCode(input.programCode)) {
    throw new HttpError(400, `Unknown CE program "${input.programCode}".`);
  }
  if (!input.title.trim()) throw new HttpError(400, 'Training title is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.trainingDate)) {
    throw new HttpError(400, 'Training date must be YYYY-MM-DD.');
  }
  if (!(input.contactHours > 0)) throw new HttpError(400, 'Contact hours must be greater than zero.');
  if (!input.activityId.trim()) throw new HttpError(400, 'Activity ID is required.');
}

export async function createTraining(input: TrainingInput, actorUserId: string | null) {
  assertValidTraining(input);
  const id = uuid();
  await db.insert(schema.ceTrainings).values({
    id,
    programCode: input.programCode,
    title: input.title.trim(),
    trainingDate: input.trainingDate,
    contactHours: String(input.contactHours),
    activityId: input.activityId.trim(),
    createdBy: actorUserId,
  });
  return getTraining(id);
}

export async function updateTraining(
  trainingId: string,
  input: TrainingInput,
  actorUserId: string | null,
) {
  assertValidTraining(input);
  const existing = await db.query.ceTrainings.findFirst({
    where: eq(schema.ceTrainings.id, trainingId),
  });
  if (!existing) throw new HttpError(404, 'Training not found.');

  // Editing content after certificates have gone out would make the issued PDFs
  // disagree with any reissue. Allowed, but recorded loudly.
  const sent = await countSent(trainingId);
  await db
    .update(schema.ceTrainings)
    .set({
      programCode: input.programCode,
      title: input.title.trim(),
      trainingDate: input.trainingDate,
      contactHours: String(input.contactHours),
      activityId: input.activityId.trim(),
      updatedAt: new Date(),
    })
    .where(eq(schema.ceTrainings.id, trainingId));

  if (sent > 0) {
    await db.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId,
      actorRole: 'cpcqc_staff',
      action: 'ce.training_edited_after_send',
      entityType: 'ce_training',
      entityId: trainingId,
      diff: {
        from: {
          title: existing.title,
          trainingDate: existing.trainingDate,
          contactHours: existing.contactHours,
          activityId: existing.activityId,
          programCode: existing.programCode,
        },
        to: input,
      },
      note: `Training content changed after ${sent} certificate(s) were already sent. Reissues will differ from what those recipients received.`,
    });
  }
  return getTraining(trainingId);
}

async function countSent(trainingId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.ceCertificates)
    .where(
      and(eq(schema.ceCertificates.trainingId, trainingId), sql`${schema.ceCertificates.sentAt} is not null`),
    );
  return rows[0]?.n ?? 0;
}

export async function listTrainings() {
  const trainings = await db
    .select()
    .from(schema.ceTrainings)
    .orderBy(desc(schema.ceTrainings.trainingDate));

  const counts = await db
    .select({
      trainingId: schema.ceCertificates.trainingId,
      total: sql<number>`count(*)::int`,
      sent: sql<number>`count(${schema.ceCertificates.sentAt})::int`,
      failed: sql<number>`count(*) filter (where ${schema.ceCertificates.sendError} is not null and ${schema.ceCertificates.sentAt} is null)::int`,
    })
    .from(schema.ceCertificates)
    .groupBy(schema.ceCertificates.trainingId);
  const byId = new Map(counts.map((c) => [c.trainingId, c]));

  return trainings.map((t) => ({
    ...toTrainingDto(t),
    participants: byId.get(t.id)?.total ?? 0,
    sent: byId.get(t.id)?.sent ?? 0,
    failed: byId.get(t.id)?.failed ?? 0,
  }));
}

export async function getTraining(trainingId: string) {
  const t = await db.query.ceTrainings.findFirst({ where: eq(schema.ceTrainings.id, trainingId) });
  if (!t) throw new HttpError(404, 'Training not found.');
  const certs = await db
    .select()
    .from(schema.ceCertificates)
    .where(eq(schema.ceCertificates.trainingId, trainingId))
    .orderBy(schema.ceCertificates.recipientName);

  return {
    ...toTrainingDto(t),
    /** Warn before sending, not after: a missing logo yields a text fallback. */
    logoMissing: (await loadLogo(t.programCode)) === null,
    certificates: certs.map((c) => ({
      id: c.id,
      certificateCode: c.certificateCode,
      recipientName: c.recipientName,
      recipientEmail: c.recipientEmail,
      sentAt: c.sentAt ? c.sentAt.toISOString() : null,
      sendError: c.sendError,
      sendCount: c.sendCount,
    })),
  };
}

function toTrainingDto(t: typeof schema.ceTrainings.$inferSelect) {
  return {
    id: t.id,
    programCode: t.programCode,
    programLabel: ceProgramLabel(t.programCode),
    title: t.title,
    trainingDate: t.trainingDate,
    trainingDateDisplay: formatTrainingDate(t.trainingDate),
    contactHours: formatContactHours(t.contactHours),
    activityId: t.activityId,
    createdAt: t.createdAt.toISOString(),
  };
}

/** CPCQC-2026-4F3A21 — short, unambiguous, printed on the PDF for audit. */
function newCertificateCode(year: string): string {
  return `CPCQC-${year}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

export interface ImportRosterResult {
  added: number;
  alreadyPresent: number;
  total: number;
}

/**
 * Add roster rows to a training. Idempotent per (training, email): re-uploading
 * a corrected roster adds the new people and leaves existing certificates — and
 * their delivery history — untouched.
 */
export async function importRoster(
  trainingId: string,
  rows: RosterRow[],
  actorUserId: string | null,
): Promise<ImportRosterResult> {
  const t = await db.query.ceTrainings.findFirst({ where: eq(schema.ceTrainings.id, trainingId) });
  if (!t) throw new HttpError(404, 'Training not found.');

  const existing = await db
    .select({ email: schema.ceCertificates.recipientEmail })
    .from(schema.ceCertificates)
    .where(eq(schema.ceCertificates.trainingId, trainingId));
  const have = new Set(existing.map((e) => e.email.toLowerCase()));

  const year = t.trainingDate.slice(0, 4);
  const toInsert = rows
    .filter((r) => !have.has(r.email.toLowerCase()))
    .map((r) => ({
      id: uuid(),
      trainingId,
      certificateCode: newCertificateCode(year),
      recipientName: r.name,
      recipientEmail: r.email,
    }));

  if (toInsert.length > 0) {
    // onConflictDoNothing guards the (training, lower(email)) unique index in
    // case two PMs upload the same roster at the same moment.
    await db.insert(schema.ceCertificates).values(toInsert).onConflictDoNothing();
    await db.insert(schema.auditLog).values({
      id: uuid(),
      actorUserId,
      actorRole: 'cpcqc_staff',
      action: 'ce.roster_imported',
      entityType: 'ce_training',
      entityId: trainingId,
      diff: { added: toInsert.length },
      note: `Imported ${toInsert.length} participant(s) for "${t.title}".`,
    });
  }

  return {
    added: toInsert.length,
    alreadyPresent: rows.length - toInsert.length,
    total: have.size + toInsert.length,
  };
}

/**
 * Delete a training and its roster.
 *
 * Refused once ANY certificate has been sent: that's an issued CE record and
 * ANCC retention applies — the same rule removeCertificate() enforces per
 * person, applied to the whole training. Unsent rosters cascade away with it,
 * which is what makes a mistyped or test training disposable.
 */
export async function deleteTraining(trainingId: string, actorUserId: string | null): Promise<void> {
  const t = await db.query.ceTrainings.findFirst({ where: eq(schema.ceTrainings.id, trainingId) });
  if (!t) throw new HttpError(404, 'Training not found.');

  const sent = await countSent(trainingId);
  if (sent > 0) {
    throw new HttpError(
      400,
      `"${t.title}" has ${sent} certificate(s) already sent. Issued CE certificates are records that must be retained, so this training can't be deleted.`,
    );
  }

  const roster = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.ceCertificates)
    .where(eq(schema.ceCertificates.trainingId, trainingId));
  const removed = roster[0]?.n ?? 0;

  // ce_certificates cascades on the FK, so the unsent roster goes with it.
  await db.delete(schema.ceTrainings).where(eq(schema.ceTrainings.id, trainingId));

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId,
    actorRole: 'cpcqc_staff',
    action: 'ce.training_deleted',
    entityType: 'ce_training',
    entityId: trainingId,
    diff: {
      title: t.title,
      programCode: t.programCode,
      trainingDate: t.trainingDate,
      activityId: t.activityId,
      rosterRemoved: removed,
    },
    note: `Deleted training "${t.title}" and ${removed} unsent roster entr${removed === 1 ? 'y' : 'ies'}. No certificates had been sent.`,
  });
}

export async function removeCertificate(certificateId: string) {
  const c = await db.query.ceCertificates.findFirst({
    where: eq(schema.ceCertificates.id, certificateId),
  });
  if (!c) throw new HttpError(404, 'Certificate not found.');
  if (c.sentAt) {
    throw new HttpError(
      400,
      'That certificate has already been sent, so it cannot be removed — the CE record must be retained.',
    );
  }
  await db.delete(schema.ceCertificates).where(eq(schema.ceCertificates.id, certificateId));
}

/**
 * Build one certificate PDF. Exported so the routes can stream a preview.
 * Logos are loaded here (uploads live in the DB) and handed to the renderer,
 * which stays free of DB access.
 */
export async function buildCertificatePdf(
  training: typeof schema.ceTrainings.$inferSelect,
  cert: { recipientName: string; certificateCode: string },
): Promise<Buffer> {
  const [program, cpcqc] = await Promise.all([
    loadLogo(training.programCode),
    loadLogo(CPCQC_LOGO_CODE),
  ]);
  return renderCertificatePdf({
    programCode: training.programCode,
    programLabel: ceProgramLabel(training.programCode),
    trainingTitle: training.title,
    trainingDate: training.trainingDate,
    contactHours: training.contactHours,
    activityId: training.activityId,
    recipientName: cert.recipientName,
    certificateCode: cert.certificateCode,
    logos: { program, cpcqc },
  });
}

/**
 * Add a single participant by hand — for the late arrival, the walk-in, or the
 * one address that was mistyped in the roster file. Goes through the same
 * importRoster path so it inherits duplicate handling and code generation.
 */
export async function addParticipant(
  trainingId: string,
  input: { name: string; email: string },
  actorUserId: string | null,
): Promise<{ added: number; alreadyPresent: number }> {
  const name = tidyName(String(input.name ?? ''));
  const email = String(input.email ?? '').trim();
  if (!name) throw new HttpError(400, 'A name is required.');
  if (!isPlausibleEmail(email)) throw new HttpError(400, 'That email address does not look valid.');

  const result = await importRoster(trainingId, [{ name, email, sourceRow: 0 }], actorUserId);
  return { added: result.added, alreadyPresent: result.alreadyPresent };
}

export interface SendResult {
  attempted: number;
  sent: number;
  failed: number;
  failures: Array<{ recipientEmail: string; error: string }>;
}

export interface SendOptions {
  /** Limit to specific certificates (a retry, or a single reissue). */
  certificateIds?: string[];
  /** When true, skip anyone already sent. The default for a first run. */
  onlyUnsent: boolean;
  actorUserId: string | null;
}

/**
 * Generate and email certificates. Failure-isolated per recipient and throttled;
 * every outcome is written back to the certificate row so the UI can show who
 * still needs a retry.
 */
export async function sendCertificates(
  trainingId: string,
  opts: SendOptions,
): Promise<SendResult> {
  const training = await db.query.ceTrainings.findFirst({
    where: eq(schema.ceTrainings.id, trainingId),
  });
  if (!training) throw new HttpError(404, 'Training not found.');

  const conditions = [eq(schema.ceCertificates.trainingId, trainingId)];
  if (opts.certificateIds?.length) {
    conditions.push(inArray(schema.ceCertificates.id, opts.certificateIds));
  }
  if (opts.onlyUnsent) conditions.push(sql`${schema.ceCertificates.sentAt} is null`);

  const targets = await db
    .select()
    .from(schema.ceCertificates)
    .where(and(...conditions));

  if (targets.length === 0) {
    return { attempted: 0, sent: 0, failed: 0, failures: [] };
  }

  const result: SendResult = { attempted: targets.length, sent: 0, failed: 0, failures: [] };

  for (let i = 0; i < targets.length; i += SEND_CONCURRENCY) {
    const batch = targets.slice(i, i + SEND_CONCURRENCY);
    await Promise.all(
      batch.map(async (cert) => {
        try {
          const pdf = await buildCertificatePdf(training, cert);
          const outcome = await sendEmail({
            toEmail: cert.recipientEmail,
            subject: `Your CE certificate — ${training.title}`,
            body: certificateEmailBody(training, cert.recipientName),
            kind: 'ce_certificate',
            attachments: [
              {
                filename: certificateFilename(training.title, cert.recipientName),
                content: pdf,
                type: 'application/pdf',
              },
            ],
          });

          if (outcome.sent) {
            await db
              .update(schema.ceCertificates)
              .set({
                sentAt: new Date(),
                sendError: null,
                sendCount: cert.sendCount + 1,
                lastSentBy: opts.actorUserId,
                updatedAt: new Date(),
              })
              .where(eq(schema.ceCertificates.id, cert.id));
            result.sent += 1;
          } else {
            // In dev with no SENDGRID_API_KEY, sendEmail logs instead of sending
            // and reports sent:false with no error — not a failure to surface.
            const error = outcome.error ?? 'Email not sent (SendGrid not configured in this environment).';
            await db
              .update(schema.ceCertificates)
              .set({ sendError: error, updatedAt: new Date() })
              .where(eq(schema.ceCertificates.id, cert.id));
            result.failed += 1;
            result.failures.push({ recipientEmail: cert.recipientEmail, error });
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await db
            .update(schema.ceCertificates)
            .set({ sendError: error.slice(0, 500), updatedAt: new Date() })
            .where(eq(schema.ceCertificates.id, cert.id));
          result.failed += 1;
          result.failures.push({ recipientEmail: cert.recipientEmail, error });
        }
      }),
    );
  }

  await db.insert(schema.auditLog).values({
    id: uuid(),
    actorUserId: opts.actorUserId,
    actorRole: 'cpcqc_staff',
    action: 'ce.certificates_sent',
    entityType: 'ce_training',
    entityId: trainingId,
    diff: { attempted: result.attempted, sent: result.sent, failed: result.failed },
    note: `Sent ${result.sent}/${result.attempted} CE certificate(s) for "${training.title}".`,
  });

  logger.info(
    { trainingId, ...result, failures: result.failures.length },
    'CE certificates send complete',
  );
  return result;
}

function certificateEmailBody(
  training: typeof schema.ceTrainings.$inferSelect,
  recipientName: string,
): string {
  return [
    `Hello ${recipientName},`,
    '',
    `Thank you for attending "${training.title}" on ${formatTrainingDate(training.trainingDate)}.`,
    '',
    `Your certificate of completion is attached, for ${formatContactHours(training.contactHours)} nursing contact hours (Activity ID ${training.activityId}).`,
    '',
    'This nursing continuing professional development activity was approved by Colorado Nurses Association, an accredited approver by the American Nurses Credentialing Center’s Commission on Accreditation.',
    '',
    'Please keep a copy for your records. If you need another, reply to this message and we can re-send it.',
    '',
    'Colorado Perinatal Care Quality Collaborative',
    'www.cpcqc.org',
  ].join('\n');
}
