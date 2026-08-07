/**
 * CE certificate endpoints, mounted at /staff/ce.
 *
 * Roster uploads use a route-scoped raw body parser (same approach as
 * /staff/imports — no multipart). The file may be .xlsx or .csv; we detect which
 * from the bytes rather than trusting a content type the browser may not set.
 *
 * Auth: requireAuth + requireStaff on every route — CE issuance is CPCQC-only.
 */
import { Router, type RequestHandler } from 'express';
import express from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import { HttpError } from '@/middleware/errors.js';
import { db, schema } from '@/db/index.js';
import { sendEmail } from '@/modules/notifications/notifications.service.js';
import {
  createTraining,
  updateTraining,
  listTrainings,
  getTraining,
  importRoster,
  removeCertificate,
  sendCertificates,
  buildCertificatePdf,
} from './ce.service.js';
import { parseRoster, csvToRows } from './ce-roster.js';
import { CE_PROGRAMS, missingProgramLogos } from './ce-programs.js';
import { renderCertificatePdf, certificateFilename } from './ce-certificate-pdf.js';

const router = Router();
router.use(requireAuth, requireStaff);

const rawUploadBody: RequestHandler = express.raw({ type: () => true, limit: '10mb' });

const trainingSchema = z.object({
  programCode: z.string().min(1),
  title: z.string().min(1).max(300),
  trainingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  contactHours: z.coerce.number().positive().max(999),
  activityId: z.string().min(1).max(100),
});

/** Turn an uploaded file into rows of cells. XLSX files begin with the ZIP magic
 *  bytes 'PK'; anything else is treated as CSV text. */
async function rowsFromUpload(buf: Buffer): Promise<unknown[][]> {
  if (!buf || buf.length === 0) throw new HttpError(400, 'No file received.');

  const isXlsx = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b; // 'PK'
  if (!isXlsx) return csvToRows(buf.toString('utf8'));

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, 'That file could not be read as a spreadsheet. Upload a .xlsx or .csv.');
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw new HttpError(400, 'The workbook has no sheets.');

  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      if (v && typeof v === 'object') {
        // Hyperlinked emails and rich text arrive as objects.
        if ('text' in v && typeof v.text === 'string') cells.push(v.text);
        else if ('result' in v) cells.push((v as { result: unknown }).result);
        else if ('richText' in v) {
          cells.push((v as { richText: Array<{ text: string }> }).richText.map((r) => r.text).join(''));
        } else cells.push(String(v));
      } else cells.push(v);
    });
    rows.push(cells);
  });
  return rows;
}

// ---------- Programs ----------

router.get('/programs', (_req, res) => {
  res.json({ programs: CE_PROGRAMS, missingLogos: missingProgramLogos() });
});

// ---------- Trainings ----------

router.get('/trainings', async (_req, res) => {
  res.json({ trainings: await listTrainings() });
});

router.post('/trainings', async (req, res) => {
  const input = trainingSchema.parse(req.body);
  res.status(201).json(await createTraining(input, req.auth?.userId ?? null));
});

router.get('/trainings/:id', async (req, res) => {
  res.json(await getTraining(req.params.id));
});

router.patch('/trainings/:id', async (req, res) => {
  const input = trainingSchema.parse(req.body);
  res.json(await updateTraining(req.params.id, input, req.auth?.userId ?? null));
});

// ---------- Roster ----------

/** Parse and report only — nothing is written. Lets the PM confirm the column
 *  mapping and see problem rows before committing. */
router.post('/trainings/:id/roster/preview', rawUploadBody, async (req, res) => {
  await getTraining(req.params.id); // 404s if the training doesn't exist
  const parsed = parseRoster(await rowsFromUpload(req.body as Buffer));
  if (parsed.rows.length === 0 && parsed.problems.length === 0) {
    throw new HttpError(
      400,
      'No name/email columns found. The file needs a header row with a name column (or First/Last) and an email column.',
    );
  }
  res.json(parsed);
});

router.post('/trainings/:id/roster', rawUploadBody, async (req, res) => {
  const parsed = parseRoster(await rowsFromUpload(req.body as Buffer));
  if (parsed.rows.length === 0) {
    throw new HttpError(400, 'No usable participant rows found in that file.');
  }
  const result = await importRoster(req.params.id, parsed.rows, req.auth?.userId ?? null);
  res.json({ ...result, problems: parsed.problems, detected: parsed.detected });
});

router.delete('/certificates/:id', async (req, res) => {
  await removeCertificate(req.params.id);
  res.status(204).end();
});

// ---------- Preview / download ----------

/** A sample certificate for layout checking — no DB row, no send. */
router.get('/trainings/:id/preview.pdf', async (req, res) => {
  const t = await db.query.ceTrainings.findFirst({ where: eq(schema.ceTrainings.id, req.params.id) });
  if (!t) throw new HttpError(404, 'Training not found.');
  const name = String(req.query.name ?? '').trim() || 'Sample Participant';
  const pdf = await renderCertificatePdf({
    programCode: t.programCode,
    trainingTitle: t.title,
    trainingDate: t.trainingDate,
    contactHours: t.contactHours,
    activityId: t.activityId,
    recipientName: name,
    certificateCode: 'PREVIEW',
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="certificate-preview.pdf"');
  res.send(pdf);
});

/** Download one participant's real certificate (for a PM who'd rather hand it
 *  over directly than email it). */
router.get('/certificates/:id/pdf', async (req, res) => {
  const cert = await db.query.ceCertificates.findFirst({
    where: eq(schema.ceCertificates.id, req.params.id),
  });
  if (!cert) throw new HttpError(404, 'Certificate not found.');
  const t = await db.query.ceTrainings.findFirst({
    where: eq(schema.ceTrainings.id, cert.trainingId),
  });
  if (!t) throw new HttpError(404, 'Training not found.');

  const pdf = await buildCertificatePdf(t, cert);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${certificateFilename(t.title, cert.recipientName)}"`,
  );
  res.send(pdf);
});

// ---------- Sending ----------

/**
 * Send a sample certificate to one address — normally the PM's own — so
 * deliverability and appearance can be checked before a 100-person run. Creates
 * no certificate record.
 */
router.post('/trainings/:id/test-send', async (req, res) => {
  const to = z.string().email().parse((req.body as { toEmail?: string })?.toEmail);
  const t = await db.query.ceTrainings.findFirst({ where: eq(schema.ceTrainings.id, req.params.id) });
  if (!t) throw new HttpError(404, 'Training not found.');

  const pdf = await renderCertificatePdf({
    programCode: t.programCode,
    trainingTitle: t.title,
    trainingDate: t.trainingDate,
    contactHours: t.contactHours,
    activityId: t.activityId,
    recipientName: 'Sample Participant',
    certificateCode: 'TEST-SEND',
  });
  const outcome = await sendEmail({
    toEmail: to,
    subject: `[TEST] Your CE certificate — ${t.title}`,
    body: `This is a test send of the CE certificate for "${t.title}". The attached certificate uses a sample name and is not a real record.`,
    kind: 'ce_certificate_test',
    userId: req.auth?.userId ?? null,
    attachments: [{ filename: 'CE-Certificate_TEST.pdf', content: pdf, type: 'application/pdf' }],
  });
  res.json({ sent: outcome.sent, error: outcome.error ?? null });
});

const sendSchema = z
  .object({
    certificateIds: z.array(z.string().uuid()).optional(),
    /** Default true so an accidental second click can't re-mail everyone. */
    onlyUnsent: z.boolean().optional().default(true),
  })
  .optional();

router.post('/trainings/:id/send', async (req, res) => {
  const body = sendSchema.parse(req.body ?? {});
  const result = await sendCertificates(req.params.id, {
    certificateIds: body?.certificateIds,
    onlyUnsent: body?.onlyUnsent ?? true,
    actorUserId: req.auth?.userId ?? null,
  });
  res.json(result);
});

export default router;
