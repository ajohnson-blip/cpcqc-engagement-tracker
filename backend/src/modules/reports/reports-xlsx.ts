/**
 * XLSX renderer for CDPHE annual reports.
 *
 * Produces a multi-sheet workbook:
 *   - Summary: top-line counts + per-initiative breakdown
 *   - Engagement Metrics: the five funder-facing participation rates, and the
 *     grant-report paragraph itself
 *   - By Hospital: one row per (hospital × enrollment), all requirements
 *   - By Initiative: per-initiative count tables
 *   - Methodology: definitions of statuses and thresholds
 *
 * Branded with CPCQC purple headers + Nunito-style typography (the cell font
 * just gets named; the file viewer falls back to a similar sans-serif).
 */
import ExcelJS from 'exceljs';
import {
  ENGAGEMENT_METRICS,
  engagementNarrative,
  programLabel,
  type EngagementSummary,
} from './engagement-metrics.js';
import type { AnnualReportData, ReportRequirement } from './reports.service.js';

// Brand colors (Excel uses ARGB)
const PURPLE = 'FF6B529B';
const PURPLE_DARK = 'FF6A6587';
const TEAL_DARK = 'FF3D7F72';
const ORANGE_DARK = 'FFD87F03';
const PINK_DARK = 'FFC1534E';
const CREAM_DARK = 'FFF1EAD9';
const WHITE = 'FFFFFFFF';

const STATUS_COLOR: Record<string, string> = {
  met: TEAL_DARK,
  on_track: PURPLE,
  at_risk: ORANGE_DARK,
  not_met: PINK_DARK,
};

const STATUS_LABEL: Record<string, string> = {
  met: 'Met',
  on_track: 'On track',
  at_risk: 'At risk',
  not_met: 'Not met',
};

function styleHeader(ws: ExcelJS.Worksheet, row: number, columnCount: number) {
  const r = ws.getRow(row);
  for (let c = 1; c <= columnCount; c++) {
    const cell = r.getCell(c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PURPLE } };
    cell.font = { name: 'Nunito Sans', bold: true, color: { argb: WHITE }, size: 11 };
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      left: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      right: { style: 'thin', color: { argb: 'FFBFBFBF' } },
      bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } },
    };
  }
  r.height = 32;
}

function statusCell(cell: ExcelJS.Cell, status: string) {
  const color = STATUS_COLOR[status] ?? PURPLE_DARK;
  cell.value = STATUS_LABEL[status] ?? status;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
  cell.font = { name: 'Nunito Sans', bold: true, color: { argb: WHITE }, size: 10 };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function fmtReq(r: ReportRequirement): string {
  return `${r.current} / ${r.required}`;
}

/**
 * The funder-facing sheet: the five engagement metrics as participation rates,
 * with the report paragraph itself at the top so a grant writer can copy it
 * straight out rather than reassembling it from the numbers below.
 */
function addEngagementSheet(wb: ExcelJS.Workbook, engagement: EngagementSummary): void {
  const ws = wb.addWorksheet('Engagement Metrics');
  ws.views = [{ showGridLines: false }];

  ws.mergeCells('A1:F1');
  const title = ws.getCell('A1');
  title.value = `Hospital engagement — Program Year ${engagement.programYear}`;
  title.font = { name: 'Nunito Sans', bold: true, color: { argb: PURPLE }, size: 16 };
  ws.getRow(1).height = 28;

  ws.mergeCells('A2:F2');
  const sub = ws.getCell('A2');
  sub.value = `As of ${engagement.asOf} · ${engagement.overall.hospitals} hospitals`;
  sub.font = { name: 'Nunito Sans', italic: true, color: { argb: PURPLE_DARK }, size: 11 };

  ws.addRow([]);
  ws.mergeCells('A4:F8');
  const narrative = ws.getCell('A4');
  narrative.value = engagementNarrative(engagement);
  narrative.font = { name: 'Nunito Sans', size: 11, color: { argb: PURPLE_DARK } };
  narrative.alignment = { wrapText: true, vertical: 'top' };

  ws.addRow([]);
  const headers = ['Metric', 'Expected', 'Timely & complete', 'Rate', 'Late', 'Incl. late'];
  const headerRow = ws.addRow(headers);
  styleHeader(ws, headerRow.number, headers.length);

  const asPct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);
  for (const m of engagement.overall.metrics) {
    ws.addRow([m.label, m.expected, m.timely, asPct(m.rate), m.late, asPct(m.rateInclLate)]);
  }

  ws.addRow([]);
  const statRow = ws.addRow(['SB24-175 — engagement in at least one initiative']);
  statRow.getCell(1).font = { name: 'Nunito Sans', bold: true, size: 13, color: { argb: PURPLE } };
  const st = engagement.statutory;
  ws.addRow(['Hospitals tracked', st.hospitals]);
  ws.addRow(['Engaged in ≥1 initiative', st.engagedInAtLeastOne]);
  ws.addRow(['Not enrolled in any', st.notEngaged]);
  ws.addRow(['Meeting or on track in ≥1', st.compliantInAtLeastOne]);
  ws.addRow(['Already met ≥1', st.metInAtLeastOne]);
  ws.addRow(['At risk across all their initiatives', st.atRiskInAll]);
  for (const b of st.byInitiativeCount) {
    ws.addRow([`Hospitals enrolled in ${b.initiatives} initiative${b.initiatives === 1 ? '' : 's'}`, b.hospitals]);
  }

  ws.addRow([]);
  const bi = ws.addRow(['By program']);
  bi.getCell(1).font = { name: 'Nunito Sans', bold: true, size: 13, color: { argb: PURPLE } };
  const progHeaders = ['Program', 'Hospitals', ...ENGAGEMENT_METRICS.map((m) => m.label)];
  const progHeaderRow = ws.addRow(progHeaders);
  styleHeader(ws, progHeaderRow.number, progHeaders.length);

  for (const scope of engagement.byInitiative) {
    ws.addRow([
      programLabel(scope.initiativeCode ?? ''),
      scope.hospitals,
      ...ENGAGEMENT_METRICS.map((m) =>
        asPct(scope.metrics.find((x) => x.key === m.key)?.rate ?? null),
      ),
    ]);
  }

  ws.columns.forEach((c, i) => {
    c.width = i === 0 ? 26 : 16;
  });

  ws.addRow([]);
  const note = ws.addRow([
    'Expected counts a task once its deadline has passed or it is already done. The reported rate counts only submissions that were timely AND complete — late arrivals are excluded, as they do not meet the operational definition. Tasks recorded as missed or not submitted never count.',
  ]);
  note.getCell(1).font = { name: 'Nunito Sans', italic: true, size: 9, color: { argb: PURPLE_DARK } };
}

export async function renderAnnualReportXlsx(
  data: AnnualReportData,
  engagement?: EngagementSummary,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CPCQC Engagement Tracker';
  wb.created = data.generatedAt;

  // ---------- Summary sheet ----------
  const summary = wb.addWorksheet('Summary');
  summary.views = [{ showGridLines: false }];

  summary.mergeCells('A1:F1');
  const title = summary.getCell('A1');
  title.value = `CPCQC Hospital Engagement — Program Year ${data.programYear} Annual Report`;
  title.font = { name: 'Nunito Sans', bold: true, color: { argb: PURPLE }, size: 18 };
  title.alignment = { horizontal: 'left', vertical: 'middle' };
  summary.getRow(1).height = 32;

  summary.mergeCells('A2:F2');
  const sub = summary.getCell('A2');
  sub.value = `Generated ${data.generatedAt.toISOString().slice(0, 10)} · As-of ${data.asOf.toISOString().slice(0, 10)}`;
  sub.font = { name: 'Nunito Sans', italic: true, color: { argb: PURPLE_DARK }, size: 11 };

  summary.addRow([]);
  const sectionRow = summary.addRow(['At a glance']);
  sectionRow.getCell(1).font = { name: 'Nunito Sans', bold: true, size: 14, color: { argb: PURPLE } };

  summary.addRow(['Hospitals participating', data.totals.hospitalsParticipating]);
  summary.addRow(['Total enrollments', data.totals.totalEnrollments]);
  summary.addRow(['Met', data.totals.metEnrollments]);
  summary.addRow(['On track', data.totals.onTrackEnrollments]);
  summary.addRow(['At risk', data.totals.atRiskEnrollments]);
  summary.addRow(['Not met', data.totals.notMetEnrollments]);

  summary.addRow([]);
  const breakdownTitle = summary.addRow(['By initiative']);
  breakdownTitle.getCell(1).font = { name: 'Nunito Sans', bold: true, size: 14, color: { argb: PURPLE } };

  const breakdownHeaderRow = summary.addRow(['Initiative', 'Enrolled', 'Met', 'On track', 'At risk', 'Not met']);
  styleHeader(summary, breakdownHeaderRow.number, 6);

  for (const init of data.initiatives) {
    const r = summary.addRow([
      `${init.emoji ? init.emoji + ' ' : ''}${init.code} — ${init.name}`,
      init.totalEnrollments,
      init.met,
      init.onTrack,
      init.atRisk,
      init.notMet,
    ]);
    r.getCell(1).font = { name: 'Nunito Sans', size: 11 };
    for (let c = 1; c <= 6; c++) {
      r.getCell(c).alignment = { horizontal: c === 1 ? 'left' : 'right', vertical: 'middle' };
    }
  }

  summary.columns.forEach((col, idx) => {
    col.width = idx === 0 ? 48 : 14;
  });

  // ---------- By Hospital sheet ----------
  if (engagement) addEngagementSheet(wb, engagement);

  const byHospital = wb.addWorksheet('By Hospital');
  const hospitalHeaders = [
    'Hospital',
    'CHA ID',
    'CDPHE ID',
    'System',
    'County',
    'Initiative',
    'Track',
    'Status',
    'Enrollment',
    'Meetings',
    'QI Advising',
    'Data Submissions',
    'Readiness Assessments',
  ];
  byHospital.addRow(hospitalHeaders);
  styleHeader(byHospital, 1, hospitalHeaders.length);
  byHospital.views = [{ showGridLines: true, state: 'frozen', ySplit: 1 }];
  byHospital.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: hospitalHeaders.length },
  };

  for (const h of data.hospitals) {
    for (const e of h.enrollments) {
      const r = byHospital.addRow([
        h.name,
        h.chaHospitalId ?? '',
        h.cdpheId ?? '',
        h.system ?? '',
        h.county ?? '',
        e.initiativeCode,
        e.track,
        '', // status — filled below with color
        fmtReq(e.requirements.enrollment),
        fmtReq(e.requirements.meetings),
        fmtReq(e.requirements.advising),
        fmtReq(e.requirements.dataSubmissions),
        e.requirements.assessments ? fmtReq(e.requirements.assessments) : 'n/a',
      ]);
      statusCell(r.getCell(8), e.overall);
      for (let c = 9; c <= 13; c++) {
        r.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
      }
    }
  }
  byHospital.columns.forEach((col, idx) => {
    col.width = idx === 0 ? 36 : 16;
  });

  // ---------- By Initiative sheet ----------
  const byInitiative = wb.addWorksheet('By Initiative');
  const initHeaders = ['Initiative', 'Track', 'Enrolled', 'Met', 'On track', 'At risk', 'Not met'];
  byInitiative.addRow(initHeaders);
  styleHeader(byInitiative, 1, initHeaders.length);
  byInitiative.views = [{ showGridLines: true, state: 'frozen', ySplit: 1 }];

  for (const init of data.initiatives) {
    byInitiative.addRow([
      `${init.code} — ${init.name}`,
      'active',
      init.active.total,
      init.active.met,
      init.active.onTrack,
      init.active.atRisk,
      init.active.notMet,
    ]);
    if (init.sustainability) {
      byInitiative.addRow([
        `${init.code} — ${init.name}`,
        'sustainability',
        init.sustainability.total,
        init.sustainability.met,
        init.sustainability.onTrack,
        init.sustainability.atRisk,
        init.sustainability.notMet,
      ]);
    }
  }
  byInitiative.columns.forEach((col, idx) => {
    col.width = idx === 0 ? 40 : 14;
  });

  // ---------- Methodology sheet ----------
  const methodology = wb.addWorksheet('Methodology');
  methodology.views = [{ showGridLines: false }];
  methodology.getColumn(1).width = 100;

  const addLine = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) => {
    const r = methodology.addRow([text]);
    r.getCell(1).font = {
      name: 'Nunito Sans',
      bold: opts.bold ?? false,
      size: opts.size ?? 11,
      color: { argb: opts.color ?? 'FF2A2536' },
    };
    r.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    r.height = Math.max(18, Math.ceil(text.length / 95) * 18);
  };

  addLine('Methodology', { bold: true, size: 18, color: PURPLE });
  addLine('');
  addLine(
    'This report measures hospital engagement against the Colorado state perinatal QI mandate. For each enrollment, four requirements are evaluated for the program year:',
  );
  addLine('  • Annual Enrollment — the hospital submitted the year\'s enrollment form');
  addLine('  • Meeting attendance — number of monthly cohort meetings + annual forum attended');
  addLine('  • QI advising — completed 1:1 advising sessions with CPCQC');
  addLine('  • Data submissions — REDCap survey submissions for the relevant cadence (monthly or quarterly)');
  addLine(
    '  • Readiness Assessments (SOAR sustainability only) — bi-annual HRAs in Q1 and Q4',
  );
  addLine('');
  addLine('Thresholds by (initiative × track)', { bold: true, size: 13, color: PURPLE });
  addLine('  • Active tracks (TTT, SPARK, SOAR, NEST): ≥9 meetings, 4 QI advising, monthly data submissions (TTT/SOAR/NEST all 12 months; SPARK ≥3 of 4 quarters)');
  addLine('  • SOAR Sustainability: ≥4 meetings (1/quarter), 2 QI advising (bi-annual), 1 quarter of data, 2 HRAs (Q1 + Q4)');
  addLine('  • TTT is a 2-year cohort but evaluated annually — Year 1 and Year 2 each carry independent requirements');
  addLine('');
  addLine('Status definitions', { bold: true, size: 13, color: PURPLE });
  addLine('  • Met — the requirement\'s threshold is satisfied');
  addLine('  • Not Met — the program year ended without satisfying the threshold');
  addLine('  • On Track — program year in progress; threshold not yet hit but recovery is mathematically plausible');
  addLine('  • At Risk — program year more than half elapsed and completion is under 30% of required; flagged for proactive outreach');
  addLine('');
  addLine('Annual requirements are judged retrospectively. Mid-year statuses are activity indicators rather than final judgments. End-of-year (after Dec 31) statuses are final.', { color: PURPLE_DARK });
  addLine('');
  addLine(`Generated by CPCQC Engagement Tracker on ${data.generatedAt.toISOString().slice(0, 10)}.`, { color: PURPLE_DARK });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
