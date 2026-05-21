import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireStaff } from '@/middleware/auth.js';
import {
  assembleAnnualReport,
  assembleHospitalReport,
  assembleInitiativeReport,
} from './reports.service.js';
import { renderAnnualReportXlsx } from './reports-xlsx.js';
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

router.get('/annual', requireAuth, requireStaff, async (req, res) => {
  const programYear = YearSchema.parse(req.query.programYear ?? new Date().getUTCFullYear());
  const format = FormatSchema.parse(req.query.format ?? 'xlsx');
  const data = await assembleAnnualReport(programYear);
  if (format === 'xlsx') {
    const buffer = await renderAnnualReportXlsx(data);
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

export default router;
