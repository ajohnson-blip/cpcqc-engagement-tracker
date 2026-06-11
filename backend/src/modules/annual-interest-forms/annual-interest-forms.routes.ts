/**
 * Routes for the annual interest form (step 1 of CPCQC's 2-step enrollment).
 *
 * Hospital portal:
 *   GET    /portal/annual-interest-forms              latest submission for current year
 *   GET    /portal/annual-interest-forms/window       acceptance window for current year
 *   POST   /portal/annual-interest-forms              submit / update (upsert by year+hospital)
 *
 * Staff:
 *   GET    /staff/annual-interest-forms               list with filters
 *   GET    /staff/annual-interest-forms/aggregate     Cohort Planning view
 *   GET    /staff/annual-interest-forms/export        XLSX download
 *   PATCH  /staff/annual-interest-forms/:id           update staff_note / status / decided
 *
 * Window dates and the rankable-initiative pool are read from the database
 * (enrollment_windows config row) rather than env vars so PMs can edit them
 * without a redeploy.
 */
import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { requireAuth } from '@/middleware/auth.js';
import { HttpError } from '@/middleware/errors.js';
import {
  RANKABLE_INITIATIVE_CODES,
  bulkAcceptInterestForms,
  getCohortPlanningAggregate,
  getEnrollmentWindow,
  getInterestFormForHospital,
  isWindowOpen,
  listInterestFormsForStaff,
  staffUpdateInterestForm,
  submitAnnualInterestForm,
  windowStateFor,
} from './annual-interest-forms.service.js';

// ---------- Portal-side router ----------

export const portalAnnualInterestRouter = Router();

portalAnnualInterestRouter.get('/window', requireAuth, async (req, res) => {
  const programYear = z.coerce
    .number()
    .int()
    .min(2026)
    .max(2100)
    .parse(req.query.programYear);
  const window = await getEnrollmentWindow(programYear);
  if (!window) throw new HttpError(404, `No window configured for ${programYear}.`);
  res.json({
    window,
    isOpen: isWindowOpen(window),
    windowState: windowStateFor(window),
    rankableInitiativeCodes: RANKABLE_INITIATIVE_CODES,
  });
});

portalAnnualInterestRouter.get('/', requireAuth, async (req, res) => {
  const programYear = z.coerce
    .number()
    .int()
    .min(2026)
    .max(2100)
    .parse(req.query.programYear);
  const form = await getInterestFormForHospital(programYear, req.auth!);
  res.json({ form });
});

portalAnnualInterestRouter.post('/', requireAuth, async (req, res) => {
  const result = await submitAnnualInterestForm(req.body, req.auth!);
  res.status(result.wasUpdate ? 200 : 201).json(result);
});

// ---------- Staff-side router ----------

export const staffAnnualInterestRouter = Router();

const listQuerySchema = z.object({
  programYear: z.coerce.number().int().min(2026).max(2100).optional(),
  status: z
    .enum(['submitted', 'under_review', 'accepted', 'declined'])
    .optional(),
});

staffAnnualInterestRouter.get('/', requireAuth, async (req, res) => {
  const filters = listQuerySchema.parse(req.query);
  const forms = await listInterestFormsForStaff(filters, req.auth!);
  res.json({ forms });
});

staffAnnualInterestRouter.get('/aggregate', requireAuth, async (req, res) => {
  const programYear = z.coerce
    .number()
    .int()
    .min(2026)
    .max(2100)
    .parse(req.query.programYear);
  const aggregate = await getCohortPlanningAggregate(programYear, req.auth!);
  res.json({ aggregate });
});

staffAnnualInterestRouter.patch('/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const updated = await staffUpdateInterestForm(id, req.body, req.auth!);
  res.json({ form: updated });
});

// Bulk accept — assign a set of cohorts to many submissions in one action,
// emailing each newly-accepted hospital. Body: { ids: string[],
// decidedInitiatives: string[] }.
staffAnnualInterestRouter.post('/bulk-accept', requireAuth, async (req, res) => {
  const result = await bulkAcceptInterestForms(req.body, req.auth!);
  res.json(result);
});

staffAnnualInterestRouter.get('/export', requireAuth, async (req, res) => {
  const programYear = z.coerce
    .number()
    .int()
    .min(2026)
    .max(2100)
    .parse(req.query.programYear);
  const forms = await listInterestFormsForStaff({ programYear }, req.auth!);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CPCQC Engagement Tracker';
  wb.created = new Date();
  const ws = wb.addWorksheet('Interest Forms');
  ws.columns = [
    { header: 'Hospital', key: 'hospital', width: 38 },
    { header: 'Submitter', key: 'submitter', width: 24 },
    { header: 'Role', key: 'role', width: 22 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Intent (#)', key: 'intent', width: 10 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Decided cohorts', key: 'decided', width: 22 },
    { header: 'Currently in TTT', key: 'tttFlag', width: 16 },
    { header: 'SOAR sustain (review)', key: 'soarSustainFlag', width: 20 },
    ...RANKABLE_INITIATIVE_CODES.map((code) => ({
      header: `${code} rank`,
      key: `rank_${code}`,
      width: 10,
    })),
    ...RANKABLE_INITIATIVE_CODES.map((code) => ({
      header: `Why ${code}`,
      key: `why_${code}`,
      width: 50,
    })),
    { header: 'PM notes', key: 'staffNote', width: 40 },
    { header: 'Submitted', key: 'submittedAt', width: 20 },
    { header: 'Last updated', key: 'updatedAt', width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const f of forms) {
    const rankByCode = new Map<string, number>();
    for (const r of f.rankedInitiatives) rankByCode.set(r.code, r.rank);
    ws.addRow({
      hospital: f.hospital.name,
      submitter: f.submitterName,
      role: f.submitterRole,
      email: f.submitterEmail,
      intent: f.intendedInitiativeCount,
      status: f.status,
      decided: (f.decidedInitiatives ?? []).join(', '),
      tttFlag: f.flags.currentlyEnrolledInTTT ? 'Yes' : 'No',
      soarSustainFlag: f.flags.currentlyInSoarSustainability ? 'Yes' : 'No',
      ...Object.fromEntries(
        RANKABLE_INITIATIVE_CODES.map((code) => [
          `rank_${code}`,
          rankByCode.get(code) ?? '',
        ]),
      ),
      ...Object.fromEntries(
        RANKABLE_INITIATIVE_CODES.map((code) => [
          `why_${code}`,
          f.reasoning[code] ?? '',
        ]),
      ),
      staffNote: f.staffNote ?? '',
      submittedAt: f.createdAt.slice(0, 10),
      updatedAt: f.updatedAt.slice(0, 10),
    });
  }

  res
    .status(200)
    .setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    .setHeader(
      'Content-Disposition',
      `attachment; filename="cpcqc-${programYear}-interest-forms.xlsx"`,
    );
  await wb.xlsx.write(res);
  res.end();
});
