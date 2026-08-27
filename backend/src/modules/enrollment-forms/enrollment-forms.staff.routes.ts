/**
 * Staff enrollment-form endpoints, mounted at /staff/enrollment-forms.
 *
 * Read-only. Enrollment is the record that satisfies the statute, so staff
 * review it rather than edit it — corrections go back through the hospital's
 * own emailed edit link.
 */
import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { requireAuth } from '@/middleware/auth.js';
import { CHAMPION_ROLES } from './enrollment-forms.service.js';
import { getStaffEnrollmentOverview } from './enrollment-forms.staff.js';

const router = Router();

const programYearSchema = z.coerce.number().int().min(2026).max(2100);

router.get('/', requireAuth, async (req, res) => {
  const programYear = programYearSchema.parse(req.query.programYear);
  res.json(await getStaffEnrollmentOverview(programYear, req.auth!));
});

/**
 * Two sheets, because there are two jobs.
 *
 * "Enrollments" is one row per submitted form — the roll-up for cohort
 * rosters. "Champions" is one row per person, which is what CPCQC actually
 * works from when granting REDCap and dashboard access and building
 * distribution lists; flattening it by hand from the first sheet was the
 * step most likely to drop someone.
 */
router.get('/export', requireAuth, async (req, res) => {
  const programYear = programYearSchema.parse(req.query.programYear);
  const { forms, coverage } = await getStaffEnrollmentOverview(programYear, req.auth!);

  const roleLabel = new Map(CHAMPION_ROLES.map((r) => [r.key, r.label]));
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('Enrollments');
  ws.columns = [
    { header: 'Hospital', key: 'hospital', width: 38 },
    { header: 'Initiative', key: 'initiative', width: 12 },
    { header: 'Submitter', key: 'submitter', width: 24 },
    { header: 'Submitter role', key: 'submitterRole', width: 24 },
    { header: 'Submitter email', key: 'submitterEmail', width: 30 },
    { header: 'EHR', key: 'ehr', width: 22 },
    { header: 'Champions', key: 'championCount', width: 12 },
    { header: 'TtT continuation attested', key: 'ttt', width: 24 },
    { header: 'Email confirmed', key: 'verified', width: 16 },
    { header: 'Submitted', key: 'submittedAt', width: 14 },
    { header: 'Last updated', key: 'updatedAt', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const f of forms) {
    ws.addRow({
      hospital: f.hospital.name,
      initiative: f.initiativeCode,
      submitter: f.submitterName,
      submitterRole: f.submitterRole,
      submitterEmail: f.submitterEmail,
      // "Other…" alone tells a PM nothing; carry what they typed.
      ehr: f.ehr === 'Other…' && f.ehrOther ? `Other: ${f.ehrOther}` : (f.ehr ?? ''),
      championCount: f.champions.length,
      ttt: f.tttContinuationAttested ? 'Yes' : '',
      verified: f.verifiedAt ? 'Yes' : 'No',
      submittedAt: f.createdAt.slice(0, 10),
      updatedAt: f.updatedAt.slice(0, 10),
    });
  }

  const cs = wb.addWorksheet('Champions');
  cs.columns = [
    { header: 'Hospital', key: 'hospital', width: 38 },
    { header: 'Initiative', key: 'initiative', width: 12 },
    { header: 'Role', key: 'role', width: 20 },
    { header: 'Name', key: 'name', width: 26 },
    { header: 'Title', key: 'title', width: 30 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Primary contact', key: 'primary', width: 16 },
    { header: 'REDCap access requested', key: 'redcap', width: 24 },
    { header: 'Dashboard access requested', key: 'dashboard', width: 26 },
  ];
  cs.getRow(1).font = { bold: true };
  for (const f of forms) {
    for (const c of f.champions) {
      cs.addRow({
        hospital: f.hospital.name,
        initiative: f.initiativeCode,
        role: roleLabel.get(c.role) ?? c.role,
        name: c.name,
        title: c.title,
        email: c.email,
        primary: c.isPrimary ? 'Yes' : '',
        redcap: c.redcapAccess ? 'Yes' : '',
        dashboard: c.dashboardAccess ? 'Yes' : '',
      });
    }
  }

  // The chase list, so it survives being mailed around as a spreadsheet.
  const os = wb.addWorksheet('Outstanding');
  os.columns = [
    { header: 'Initiative', key: 'initiative', width: 12 },
    { header: 'Hospital', key: 'hospital', width: 38 },
  ];
  os.getRow(1).font = { bold: true };
  for (const c of coverage) {
    for (const h of c.outstanding) {
      os.addRow({ initiative: c.initiativeCode, hospital: h.name });
    }
  }

  res
    .status(200)
    .setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    .setHeader(
      'Content-Disposition',
      `attachment; filename="cpcqc-${programYear}-enrollment-forms.xlsx"`,
    );
  await wb.xlsx.write(res);
  res.end();
});

export default router;
