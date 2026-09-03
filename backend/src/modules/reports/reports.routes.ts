import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import {
  assembleAnnualReport,
  assembleHospitalReport,
  assembleInitiativeReport,
  getChampionContacts,
} from './reports.service.js';
import { renderAnnualReportXlsx } from './reports-xlsx.js';
import { computeEngagementMetrics } from './engagement-metrics.service.js';
import { engagementNarrative } from './engagement-metrics.js';
import { renderAnnualReportPdf } from './reports-pdf.js';

const router = Router();

const FormatSchema = z.enum(['pdf', 'xlsx']).default('xlsx');
const YearSchema = z.coerce.number().int().min(2025).max(2100);

function setDownloadHeaders(
  res: Parameters<Router['use']>[0] extends never ? never : import('express').Response,
  format: 'pdf' | 'xlsx',
  filename: string,
) {
  const safeName = filename.replace(/[^A-Za-z0-9_.-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.${format}"`);
  res.setHeader(
    'Content-Type',
    format === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
}

/**
 * The five funder-facing engagement metrics, plus the paragraph itself.
 *
 * `narrative` is returned ready to paste into a grant report — the numbers go
 * stale every month, and retyping them by hand is how they drift from what the
 * tracker actually holds.
 */
router.get('/engagement', requireAuth, requireStaff, async (req, res) => {
  const programYear = YearSchema.parse(req.query.programYear ?? new Date().getUTCFullYear());
  // Optional cohort tag — scopes every figure, including the statutory
  // denominator, to that group of hospitals.
  const cohort = z.string().min(1).max(80).optional().parse(req.query.cohort || undefined);
  const summary = await computeEngagementMetrics(programYear, cohort ?? null);
  res.json({ summary, narrative: engagementNarrative(summary) });
});

router.get('/annual', requireAuth, requireStaff, async (req, res) => {
  const programYear = YearSchema.parse(req.query.programYear ?? new Date().getUTCFullYear());
  const format = FormatSchema.parse(req.query.format ?? 'xlsx');
  const data = await assembleAnnualReport(programYear);
  if (format === 'xlsx') {
    // Bundled into the annual export so the grant numbers travel with the
    // compliance detail they are derived from.
    const engagement = await computeEngagementMetrics(programYear);
    const buffer = await renderAnnualReportXlsx(data, engagement);
    setDownloadHeaders(res, 'xlsx', `cpcqc-annual-report-${programYear}`);
    res.send(buffer);
  } else {
    const buffer = await renderAnnualReportPdf(data);
    setDownloadHeaders(res, 'pdf', `cpcqc-annual-report-${programYear}`);
    res.send(buffer);
  }
});

router.get('/hospital/:id', requireAuth, requireStaff, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const programYear = YearSchema.parse(req.query.programYear ?? new Date().getUTCFullYear());
  const format = FormatSchema.parse(req.query.format ?? 'xlsx');
  const data = await assembleHospitalReport(id, programYear);
  const hospitalName = data.hospitals[0]?.name ?? 'hospital';
  const subtitle = `${hospitalName}`;
  if (format === 'xlsx') {
    const buffer = await renderAnnualReportXlsx(data);
    setDownloadHeaders(res, 'xlsx', `cpcqc-${hospitalName}-${programYear}`);
    res.send(buffer);
  } else {
    const buffer = await renderAnnualReportPdf(data, {
      title: `Hospital Engagement — ${hospitalName} — ${programYear}`,
      subtitle,
    });
    setDownloadHeaders(res, 'pdf', `cpcqc-${hospitalName}-${programYear}`);
    res.send(buffer);
  }
});

router.get('/initiative/:code', requireAuth, requireStaff, async (req, res) => {
  const code = z.enum(['TTT', 'SPARK', 'SOAR', 'NEST']).parse(req.params.code);
  const programYear = YearSchema.parse(req.query.programYear ?? new Date().getUTCFullYear());
  const format = FormatSchema.parse(req.query.format ?? 'xlsx');
  const data = await assembleInitiativeReport(code, programYear);
  if (format === 'xlsx') {
    const buffer = await renderAnnualReportXlsx(data);
    setDownloadHeaders(res, 'xlsx', `cpcqc-${code}-${programYear}`);
    res.send(buffer);
  } else {
    const buffer = await renderAnnualReportPdf(data, {
      title: `${code} Engagement — Program Year ${programYear}`,
    });
    setDownloadHeaders(res, 'pdf', `cpcqc-${code}-${programYear}`);
    res.send(buffer);
  }
});

// Champion contact list (roster) for emailing/outreach. JSON; the UI builds CSV
// + a copy-emails list client-side. Optional ?initiative=TTT|SPARK|SOAR|NEST.
router.get('/champion-contacts', requireAuth, requireStaff, async (req, res) => {
  const initiative = z
    .enum(['TTT', 'SPARK', 'SOAR', 'NEST'])
    .optional()
    .parse(req.query.initiative || undefined);
  const contacts = await getChampionContacts(initiative);
  res.json({ initiative: initiative ?? null, contacts });
});

export default router;
