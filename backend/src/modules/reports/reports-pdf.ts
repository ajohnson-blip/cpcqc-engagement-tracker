/**
 * PDF renderer for CDPHE annual reports.
 *
 * Uses pdfkit (no Chromium dependency). Produces a multi-page document:
 *   - Cover page
 *   - Executive summary (totals + per-initiative table)
 *   - Per-hospital detail (one section per hospital, all enrollments)
 *   - Methodology appendix
 *
 * Brand colors and Nunito-style typography. pdfkit ships with Helvetica by
 * default; we use it as the substitute for Nunito Sans for portability — the
 * report's visual identity comes from layout + color, not the typeface.
 */
import PDFDocument from 'pdfkit';
import type { AnnualReportData, ReportRequirement } from './reports.service.js';

const PURPLE = '#6B529B';
const PURPLE_DARK = '#6A6587';
const TEAL_DARK = '#3D7F72';
const ORANGE_DARK = '#D87F03';
const PINK_DARK = '#C1534E';
const CREAM_DARK = '#F1EAD9';
const TEXT = '#2A2536';

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

function fmtReq(r: ReportRequirement): string {
  return `${r.current}/${r.required}`;
}

interface RenderOptions {
  /** Title to put on the cover. Defaults to "CPCQC Annual Report". */
  title?: string;
  /** Subtitle shown beneath the title on the cover. */
  subtitle?: string;
}

export function renderAnnualReportPdf(
  data: AnnualReportData,
  opts: RenderOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `CPCQC Engagement Annual Report ${data.programYear}`,
        Author: 'CPCQC Engagement Tracker',
        Subject: `Program Year ${data.programYear}`,
      },
    });

    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawCover(doc, data, opts);
    doc.addPage();
    drawExecutiveSummary(doc, data);
    doc.addPage();
    drawPerHospital(doc, data);
    doc.addPage();
    drawMethodology(doc, data);

    doc.end();
  });
}

// ---------- Sections ----------

function drawCover(
  doc: PDFKit.PDFDocument,
  data: AnnualReportData,
  opts: RenderOptions,
) {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Top coral accent strip
  doc.rect(0, 0, doc.page.width, 8).fill('#CE7672');

  // Logo / wordmark (CSS recreation — small)
  doc
    .fillColor(PURPLE)
    .font('Helvetica-Bold')
    .fontSize(40)
    .text('cpcqc', doc.page.margins.left, 80);

  doc
    .fillColor(PURPLE_DARK)
    .font('Helvetica')
    .fontSize(10)
    .text('COLORADO PERINATAL CARE QUALITY COLLABORATIVE', doc.page.margins.left, 130, {
      characterSpacing: 1.5,
    });

  // Title block
  doc
    .moveDown(6)
    .fillColor(PURPLE_DARK)
    .font('Helvetica')
    .fontSize(14)
    .text('Annual Report');

  doc
    .moveDown(0.5)
    .fillColor(PURPLE)
    .font('Helvetica-Bold')
    .fontSize(32)
    .text(opts.title ?? `Hospital Engagement — Program Year ${data.programYear}`, {
      width: w,
    });

  if (opts.subtitle) {
    doc.moveDown(0.5).fillColor(PURPLE_DARK).font('Helvetica').fontSize(14).text(opts.subtitle, {
      width: w,
    });
  }

  // Metadata at bottom
  const bottomY = doc.page.height - doc.page.margins.bottom - 80;
  doc.fillColor(PURPLE_DARK).font('Helvetica').fontSize(10);
  doc.text(`Generated: ${data.generatedAt.toLocaleDateString('en-US', { dateStyle: 'long' })}`, doc.page.margins.left, bottomY);
  doc.text(`Compliance as-of: ${data.asOf.toLocaleDateString('en-US', { dateStyle: 'long' })}`);
  doc.text(`Hospitals included: ${data.totals.hospitalsParticipating}`);
  doc.text(`Total enrollments: ${data.totals.totalEnrollments}`);
}

function drawExecutiveSummary(doc: PDFKit.PDFDocument, data: AnnualReportData) {
  sectionTitle(doc, 'Executive Summary');

  doc.moveDown(0.5);
  doc.fillColor(TEXT).font('Helvetica').fontSize(11);
  doc.text(
    `Across ${data.totals.hospitalsParticipating} participating hospitals and ${data.totals.totalEnrollments} initiative enrollments for program year ${data.programYear}, the following outcomes were recorded:`,
    { width: contentWidth(doc) },
  );

  doc.moveDown(1);
  // Big-stat row
  const stats: Array<[string, number, string]> = [
    ['Met', data.totals.metEnrollments, TEAL_DARK],
    ['On track', data.totals.onTrackEnrollments, PURPLE],
    ['At risk', data.totals.atRiskEnrollments, ORANGE_DARK],
    ['Not met', data.totals.notMetEnrollments, PINK_DARK],
  ];
  drawStatsRow(doc, stats);

  doc.moveDown(2);
  sectionSubtitle(doc, 'Per-initiative breakdown');
  doc.moveDown(0.5);

  // Table header
  const colWidths = [200, 80, 70, 70, 70, 70]; // total 560
  const headers = ['Initiative', 'Enrolled', 'Met', 'On track', 'At risk', 'Not met'];
  drawTableRow(doc, headers, colWidths, { fill: PURPLE, color: '#fff', bold: true });
  for (const init of data.initiatives) {
    drawTableRow(
      doc,
      [
        `${init.code} — ${init.name}`,
        String(init.totalEnrollments),
        String(init.met),
        String(init.onTrack),
        String(init.atRisk),
        String(init.notMet),
      ],
      colWidths,
      {},
    );
    if (init.sustainability) {
      drawTableRow(
        doc,
        [
          `   ↳ Sustainability cohort`,
          String(init.sustainability.total),
          String(init.sustainability.met),
          String(init.sustainability.onTrack),
          String(init.sustainability.atRisk),
          String(init.sustainability.notMet),
        ],
        colWidths,
        { color: PURPLE_DARK, italic: true },
      );
    }
  }
}

function drawPerHospital(doc: PDFKit.PDFDocument, data: AnnualReportData) {
  sectionTitle(doc, 'Hospital Detail');
  doc.moveDown(0.5);
  doc
    .fillColor(TEXT)
    .font('Helvetica')
    .fontSize(11)
    .text(
      'One row per (hospital × enrollment) showing the four (or five, for sustainability) requirement scores. Hospitals are listed alphabetically.',
      { width: contentWidth(doc) },
    );
  doc.moveDown(1);

  const colWidths = [170, 60, 70, 50, 50, 60, 60, 60]; // 580 total — slightly wider than content
  // Slim down to fit
  const adjusted = [150, 50, 60, 50, 50, 55, 55, 55]; // 525
  const headers = ['Hospital', 'Init.', 'Track', 'Status', 'Enroll.', 'Mtgs', 'Advise', 'Data'];
  drawTableRow(doc, headers, adjusted, { fill: PURPLE, color: '#fff', bold: true });

  for (const h of data.hospitals) {
    for (const [i, e] of h.enrollments.entries()) {
      // Repeat hospital name only on the first enrollment row; blank on subsequent
      const hospitalCell = i === 0 ? h.name : '';
      const cells = [
        hospitalCell,
        e.initiativeCode,
        e.track === 'active' ? 'Active' : 'Sustain.',
        STATUS_LABEL[e.overall] ?? e.overall,
        fmtReq(e.requirements.enrollment),
        fmtReq(e.requirements.meetings),
        fmtReq(e.requirements.advising),
        fmtReq(e.requirements.dataSubmissions),
      ];
      drawTableRow(doc, cells, adjusted, {
        statusCol: 3,
        statusValue: e.overall,
        bottomBorder: i === h.enrollments.length - 1, // thicker border after last row of a hospital
      });

      // New-page guard
      if (doc.y > doc.page.height - doc.page.margins.bottom - 80) {
        doc.addPage();
        drawTableRow(doc, headers, adjusted, { fill: PURPLE, color: '#fff', bold: true });
      }
    }
  }
}

function drawMethodology(doc: PDFKit.PDFDocument, data: AnnualReportData) {
  sectionTitle(doc, 'Methodology');
  const sections: Array<{ title?: string; body: string }> = [
    {
      body: 'This report measures hospital engagement against the Colorado state perinatal QI mandate. Four (or five, for SOAR sustainability) requirements are evaluated per enrollment per program year:',
    },
    {
      title: 'Requirements',
      body: '• Annual Enrollment — the year\'s enrollment form was submitted.\n• Meeting attendance — monthly cohort meetings + annual forum attendance.\n• QI advising — completed 1:1 advising sessions with CPCQC.\n• Data submissions — REDCap survey submissions for the cadence required by the initiative.\n• Readiness Assessments (SOAR sustainability only) — bi-annual HRAs in Q1 and Q4.',
    },
    {
      title: 'Thresholds',
      body: '• Active tracks (TTT, SPARK, SOAR, NEST): ≥9 meetings, 4 QI advising, monthly data submissions (TTT/SOAR/NEST all 12 months; SPARK ≥3 of 4 quarters).\n• SOAR Sustainability: ≥4 meetings (1 per quarter), 2 QI advising (bi-annual), 1 quarter of data, 2 HRAs (Q1 and Q4).\n• TTT is a 2-year cohort, evaluated annually — Year 1 and Year 2 carry independent requirements.',
    },
    {
      title: 'Status definitions',
      body: '• Met — the requirement\'s threshold is satisfied.\n• Not Met — the program year ended without meeting the threshold.\n• On Track — program year in progress; threshold not yet hit but mathematically still recoverable.\n• At Risk — year is more than half elapsed AND completion is under 30% of required. Flagged for proactive outreach.',
    },
    {
      body: 'Annual requirements are judged retrospectively. Mid-year statuses reflect activity rather than final judgment; end-of-year (after Dec 31) statuses are final.',
    },
  ];
  for (const s of sections) {
    doc.moveDown(0.5);
    if (s.title) {
      doc
        .fillColor(PURPLE)
        .font('Helvetica-Bold')
        .fontSize(13)
        .text(s.title, { width: contentWidth(doc) });
      doc.moveDown(0.25);
    }
    doc
      .fillColor(TEXT)
      .font('Helvetica')
      .fontSize(11)
      .text(s.body, { width: contentWidth(doc), lineGap: 2 });
  }

  doc.moveDown(2);
  doc
    .fillColor(PURPLE_DARK)
    .font('Helvetica-Oblique')
    .fontSize(10)
    .text(
      `Generated by the CPCQC Engagement Tracker on ${data.generatedAt.toLocaleString('en-US')}. Questions: engagement@qi.cpcqc.org.`,
      { width: contentWidth(doc) },
    );
}

// ---------- Drawing primitives ----------

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string) {
  doc
    .fillColor(PURPLE)
    .font('Helvetica-Bold')
    .fontSize(22)
    .text(text, { width: contentWidth(doc) });
  // Underline
  const y = doc.y + 2;
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.margins.left + 60, y)
    .lineWidth(3)
    .strokeColor(PURPLE)
    .stroke();
  doc.moveDown(0.5);
}

function sectionSubtitle(doc: PDFKit.PDFDocument, text: string) {
  doc
    .fillColor(PURPLE_DARK)
    .font('Helvetica-Bold')
    .fontSize(14)
    .text(text, { width: contentWidth(doc) });
}

function drawStatsRow(doc: PDFKit.PDFDocument, stats: Array<[string, number, string]>) {
  const w = contentWidth(doc);
  const cellW = w / stats.length;
  const startX = doc.page.margins.left;
  const startY = doc.y;

  stats.forEach(([label, value, color], i) => {
    const x = startX + i * cellW;
    const padding = 6;
    // tinted background card
    doc
      .rect(x + padding, startY, cellW - padding * 2, 72)
      .fillColor(color)
      .fillOpacity(0.1)
      .fill()
      .fillOpacity(1);
    // value
    doc
      .fillColor(color)
      .font('Helvetica-Bold')
      .fontSize(32)
      .text(String(value), x + padding + 12, startY + 10, { width: cellW - padding * 2 - 12 });
    // label
    doc
      .fillColor(PURPLE_DARK)
      .font('Helvetica')
      .fontSize(11)
      .text(label.toUpperCase(), x + padding + 12, startY + 50, {
        characterSpacing: 1,
        width: cellW - padding * 2 - 12,
      });
  });
  doc.y = startY + 80;
}

interface RowOpts {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  statusCol?: number;
  statusValue?: string;
  bottomBorder?: boolean;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  cells: string[],
  widths: number[],
  opts: RowOpts,
) {
  const startX = doc.page.margins.left;
  const startY = doc.y;
  const rowH = opts.bold ? 22 : 18;
  // Fill background
  if (opts.fill) {
    doc
      .rect(startX, startY, widths.reduce((a, b) => a + b, 0), rowH)
      .fillColor(opts.fill)
      .fill();
  }

  let x = startX;
  cells.forEach((cell, idx) => {
    const w = widths[idx]!;
    // Status pill for the status column
    if (opts.statusCol === idx && opts.statusValue) {
      const color = STATUS_COLOR[opts.statusValue] ?? PURPLE_DARK;
      const pillW = 56;
      const pillH = 12;
      const pillX = x + 3;
      const pillY = startY + (rowH - pillH) / 2;
      doc
        .roundedRect(pillX, pillY, pillW, pillH, 6)
        .fillColor(color)
        .fill();
      doc
        .fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(8)
        .text(cell.toUpperCase(), pillX, pillY + 2, {
          width: pillW,
          align: 'center',
          characterSpacing: 0.5,
        });
    } else {
      doc.fillColor(opts.color ?? TEXT);
      doc.font(
        opts.bold ? 'Helvetica-Bold' : opts.italic ? 'Helvetica-Oblique' : 'Helvetica',
      );
      doc.fontSize(opts.bold ? 10 : 9);
      doc.text(cell, x + 4, startY + 4, { width: w - 8, lineBreak: false, ellipsis: true });
    }
    x += w;
  });

  // Bottom border
  doc
    .moveTo(startX, startY + rowH)
    .lineTo(startX + widths.reduce((a, b) => a + b, 0), startY + rowH)
    .lineWidth(opts.bottomBorder ? 0.8 : 0.3)
    .strokeColor(opts.bottomBorder ? PURPLE_DARK : '#DDD')
    .stroke();
  doc.y = startY + rowH;
}
