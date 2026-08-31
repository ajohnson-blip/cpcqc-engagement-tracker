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
import { runNestRedcapSync } from '@/modules/redcap/nest-sync.service.js';
import { runSoarRedcapSync } from '@/modules/redcap/soar-sync.service.js';
import { runTttRedcapSync } from '@/modules/redcap/ttt-sync.service.js';
import { type SyncOverride } from '@/modules/redcap/sync-overrides.js';
import { setPeriodFinalized } from '@/modules/redcap/finalize.service.js';

// PM overrides posted with an apply: per-task disposition + rationale.
const overridesBodySchema = z
  .object({
    overrides: z
      .array(
        z.object({
          taskId: z.string().uuid(),
          disposition: z.enum(['counts', 'late', 'incomplete', 'not_submitted', 'pending']),
          comment: z.string().max(2000).optional().default(''),
        }),
      )
      .optional(),
  })
  .optional();

function parseOverrides(body: unknown): Map<string, SyncOverride> | undefined {
  const parsed = overridesBodySchema.parse(body ?? {});
  if (!parsed?.overrides?.length) return undefined;
  return new Map(
    parsed.overrides.map((o) => [o.taskId, { disposition: o.disposition, comment: o.comment }]),
  );
}

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
    overrides: dryRun ? undefined : parseOverrides(req.body),
  });
  res.json(result);
});

/**
 * POST /staff/imports/redcap/nest?dryRun=true|false
 *
 * Pulls the NEST monthly forms (safe_sleep_audit + chart_reviews) from REDCap
 * and maps them onto each NEST-active hospital's monthly data_submission tasks.
 * Dry-run by default. No request body.
 */
router.post('/redcap/nest', requireAuth, requireStaff, express.json(), async (req, res) => {
  const dryRun = req.query.dryRun !== 'false';
  const result = await runNestRedcapSync({
    dryRun,
    actorUserId: req.auth?.userId ?? null,
    overrides: dryRun ? undefined : parseOverrides(req.body),
  });
  res.json(result);
});

/**
 * POST /staff/imports/redcap/soar?dryRun=true|false
 *
 * Pulls the SOAR forms (ntsv_cesarean_section + no_ntsv_csections) from REDCap
 * and maps them onto each SOAR-active hospital's monthly data_submission tasks.
 * A zero-case No-NTSV attestation counts as a complete submission. Dry-run by
 * default. No request body.
 */
router.post('/redcap/soar', requireAuth, requireStaff, express.json(), async (req, res) => {
  const dryRun = req.query.dryRun !== 'false';
  const result = await runSoarRedcapSync({
    dryRun,
    actorUserId: req.auth?.userId ?? null,
    overrides: dryRun ? undefined : parseOverrides(req.body),
  });
  res.json(result);
});

/**
 * POST /staff/imports/redcap/ttt?dryRun=true|false
 *
 * Turning the Tide spans TWO REDCap projects (monthly hospital + patient-level),
 * joined on CHA_ID via the crosswalk. Completeness = required fields AND the
 * linkage rule (each positive SUD screen should have a patient form; the floor
 * is pass/fail, the one-per-positive ideal is reported but non-blocking).
 * Dry-run by default.
 */
router.post('/redcap/ttt', requireAuth, requireStaff, express.json(), async (req, res) => {
  const dryRun = req.query.dryRun !== 'false';
  const result = await runTttRedcapSync({
    dryRun,
    actorUserId: req.auth?.userId ?? null,
    overrides: dryRun ? undefined : parseOverrides(req.body),
  });
  res.json(result);
});

/**
 * POST /staff/imports/redcap/finalize
 * Lock (or unlock) a program's month so the sync won't touch it again.
 * Body: { program: 'SPARK'|'NEST', period: '2026-06'|'2026-Q2', finalize: bool,
 *         acknowledgeUnresolved?: bool }
 *
 * Finalizing a month with unresolved tasks returns 409 unless acknowledged —
 * locking freezes them, and the sync can no longer correct what it froze.
 */
router.post('/redcap/finalize', requireAuth, requireStaff, express.json(), async (req, res) => {
  const body = z
    .object({
      program: z.enum(['SPARK', 'NEST', 'SOAR', 'TTT']),
      period: z.string().min(1).max(20),
      finalize: z.boolean(),
      // Sent on the retry after the client has shown the operator how many
      // tasks are unsettled; the first call is deliberately refused.
      acknowledgeUnresolved: z.boolean().optional(),
    })
    .parse(req.body);
  const result = await setPeriodFinalized({
    initiativeCode: body.program,
    period: body.period,
    finalize: body.finalize,
    actorUserId: req.auth?.userId ?? null,
    acknowledgeUnresolved: body.acknowledgeUnresolved,
  });
  res.json(result);
});

export default router;
