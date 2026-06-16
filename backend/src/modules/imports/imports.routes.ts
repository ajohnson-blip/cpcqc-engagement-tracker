/**
 * Admin import endpoints.
 *
 * Currently a single endpoint: POST /staff/imports/pm-workbook accepts an
 * uploaded PM-engagement-data .xlsx workbook (raw body, no multipart), runs it
 * through the same importer that scripts/import-pm-engagement-data.ts drives,
 * and returns a structured summary. Lets CPCQC staff update engagement data
 * from the dashboard without dropping into a terminal.
 *
 * Auth: requireAuth + requireStaff — same gate as every other /staff route.
 */
import { Router, type RequestHandler } from 'express';
import express from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import { HttpError } from '@/middleware/errors.js';
import { importPmWorkbook } from './pm-workbook.service.js';
import { runSparkRedcapSync } from '@/modules/redcap/spark-sync.service.js';

const router = Router();

// Raw body parser scoped to this route only — accepts any content type so the
// browser can POST the file as application/octet-stream or as the xlsx mime.
// 25 MB ceiling is well above any real PM workbook (~125 KB–300 KB observed).
const rawXlsxBody: RequestHandler = express.raw({
  type: () => true,
  limit: '25mb',
});

const querySchema = z.object({
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

router.post(
  '/pm-workbook',
  requireAuth,
  requireStaff,
  rawXlsxBody,
  async (req, res) => {
    const query = querySchema.parse(req.query);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError(400, 'Upload the .xlsx as the raw request body.');
    }

    const wb = new ExcelJS.Workbook();
    try {
      // ExcelJS's older Buffer typing is incompatible with Node 20+ generic
      // Buffer<ArrayBufferLike>; hand it the underlying ArrayBuffer instead
      // (also a supported input shape for xlsx.load).
      const buf = req.body as Buffer;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      await wb.xlsx.load(ab as ArrayBuffer);
    } catch (err) {
      throw new HttpError(
        400,
        `Failed to parse .xlsx: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = await importPmWorkbook(wb, { dryRun: query.dryRun });
    res.json(result);
  },
);

/**
 * POST /staff/imports/redcap/spark?dryRun=true|false
 *
 * Pulls the SPARK quarterly_measures form from REDCap and maps it onto each
 * SPARK-active hospital's quarterly data_submission tasks. Dry-run returns the
 * preview without writing. No request body.
 */
router.post('/redcap/spark', requireAuth, requireStaff, express.json(), async (req, res) => {
  // Default to a dry-run unless the caller explicitly passes dryRun=false. These
  // are official compliance records, so "apply" must be a deliberate choice.
  const dryRun = req.query.dryRun !== 'false';
  const result = await runSparkRedcapSync({
    dryRun,
    actorUserId: req.auth?.userId ?? null,
  });
  res.json(result);
});

export default router;
