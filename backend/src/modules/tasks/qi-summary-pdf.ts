/**
 * The end-of-year QI summary, downloaded from a team's Q4 1:1: the year's
 * 1:1s and who came, the aims completed and those carrying into next year with
 * their PDSA tests, and each call's notes.
 *
 * pdfkit and the annual report's colors (reports-pdf.ts); Helvetica stands in
 * for Nunito Sans.
 */
import PDFDocument from 'pdfkit';
import type { QiAim, QiYearSession, QiYearSummary } from './qi-advising.js';

const PURPLE = '#6B529B';
const PURPLE_DARK = '#6A6587';
const TEAL_DARK = '#3D7F72';
const PINK_DARK = '#C1534E';
const CREAM_DARK = '#F1EAD9';
const TEXT = '#2A2536';

const STAGE_LABEL: Record<string, string> = { plan: 'Plan', do: 'Do', study: 'Study', act: 'Act' };
const DECISION_LABEL: Record<string, string> = { adopt: 'Adopt', adapt: 'Adapt', abandon: 'Abandon' };
const ATTENDANCE: Record<QiYearSession['attendance'], [label: string, color: string]> = {
  attended: ['Attended', TEAL_DARK],
  missed: ['Did not attend', PINK_DARK],
  not_recorded: ['Not recorded yet', PURPLE_DARK],
};

export interface QiSummaryPdfData {
  hospitalName: string;
  initiativeName: string;
  cohortLabel: string | null;
  summary: QiYearSummary;
}

export function renderQiSummaryPdf(data: QiSummaryPdfData, generatedOn = new Date()): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 56, bottom: 64, left: 56, right: 56 },
      bufferPages: true,
      info: {
        Title: `End-of-year QI summary ${data.summary.year}: ${data.hospitalName}, ${data.initiativeName}`,
        Author: 'CPCQC Engagement Tracker',
      },
    });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeader(doc, data);
    drawSessions(doc, data.summary);
    drawAims(doc, data.summary);
    drawNotes(doc, data.summary);
    drawFooters(doc, data, generatedOn);

    doc.end();
  });
}

// ---------- Sections ----------

function drawHeader(doc: PDFKit.PDFDocument, data: QiSummaryPdfData) {
  const left = doc.page.margins.left;
  const w = contentWidth(doc);
  doc.rect(0, 0, doc.page.width, 8).fill('#CE7672');
  doc.fillColor(PURPLE).font('Helvetica-Bold').fontSize(20).text('cpcqc', left, 36);
  doc
    .fillColor(PURPLE_DARK)
    .font('Helvetica')
    .fontSize(7.5)
    .text('COLORADO PERINATAL CARE QUALITY COLLABORATIVE', { characterSpacing: 1.2 });

  doc.moveDown(1.6);
  doc
    .fillColor(PURPLE)
    .font('Helvetica-Bold')
    .fontSize(22)
    .text(`End-of-year QI summary ${data.summary.year}`, { width: w });
  doc
    .moveDown(0.2)
    .fillColor(TEXT)
    .font('Helvetica')
    .fontSize(13)
    .text(`${data.hospitalName} · ${data.initiativeName}`, { width: w });
  if (data.cohortLabel) {
    doc.fillColor(PURPLE_DARK).fontSize(10).text(data.cohortLabel, { width: w });
  }

  const s = data.summary;
  const attended = s.sessions.filter((x) => x.attendance === 'attended').length;
  const completed = s.aims.filter((a) => a.completedOn).length;
  const tests = s.aims.reduce((n, a) => n + a.tests.length, 0);
  doc.moveDown(1);
  drawStats(doc, [
    [`${attended} of ${s.sessions.length}`, 'QI 1:1s attended'],
    [String(completed), completed === 1 ? 'Aim completed' : 'Aims completed'],
    [String(s.aims.length - completed), s.aims.length - completed === 1 ? 'Aim still open' : 'Aims still open'],
    [String(tests), tests === 1 ? 'PDSA test' : 'PDSA tests'],
  ]);
}

function drawSessions(doc: PDFKit.PDFDocument, s: QiYearSummary) {
  sectionTitle(doc, 'QI 1:1s');
  if (s.sessions.length === 0) {
    body(doc, 'No QI 1:1s this year.');
    return;
  }
  const w = contentWidth(doc);
  const cols = [70, 82, 92, 110];
  const widths = [...cols, w - cols.reduce((a, b) => a + b, 0)];
  tableRow(doc, ['Quarter', 'Date', 'Attendance', 'QI advisor', 'Attendees'], widths, { header: true });
  for (const x of s.sessions) {
    const [label, color] = ATTENDANCE[x.attendance];
    tableRow(
      doc,
      [
        fmtPeriod(x.period),
        x.sessionDate ? fmtDate(x.sessionDate) : '—',
        label,
        x.advisorName ?? '—',
        x.attendees.length ? x.attendees.join(', ') : '—',
      ],
      widths,
      { colors: { 2: color } },
    );
  }
}

function drawAims(doc: PDFKit.PDFDocument, s: QiYearSummary) {
  sectionTitle(doc, 'Aims and PDSA tests');
  if (s.aims.length === 0) {
    body(doc, 'No aims recorded this year.');
    return;
  }
  if (s.aimsAsOf) {
    doc
      .fillColor(PURPLE_DARK)
      .font('Helvetica')
      .fontSize(9.5)
      .text(`As of the ${fmtPeriod(s.aimsAsOf)} 1:1.`, { width: contentWidth(doc) });
    doc.moveDown(0.4);
  }
  const completed = s.aims.filter((a) => a.completedOn);
  const open = s.aims.filter((a) => !a.completedOn);
  if (completed.length > 0) {
    subTitle(doc, `Completed this year (${completed.length})`);
    for (const a of completed) drawAim(doc, a);
  }
  if (open.length > 0) {
    subTitle(doc, `Carrying into ${s.year + 1} (${open.length})`);
    for (const a of open) drawAim(doc, a);
  }
}

function drawAim(doc: PDFKit.PDFDocument, a: QiAim) {
  const left = doc.page.margins.left;
  const w = contentWidth(doc);
  ensureSpace(doc, 60);
  doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(10.5).text(a.statement, left, doc.y, { width: w });
  const meta = [
    a.completedOn ? `Completed ${fmtDate(a.completedOn)}` : null,
    a.tests.length === 0 ? 'No PDSA tests yet' : `${a.tests.length} PDSA ${a.tests.length === 1 ? 'test' : 'tests'}`,
  ].filter(Boolean);
  doc
    .fillColor(a.completedOn ? TEAL_DARK : PURPLE_DARK)
    .font('Helvetica')
    .fontSize(9)
    .text(meta.join(' · '), { width: w });
  for (const t of a.tests) {
    ensureSpace(doc, 28);
    const stage = [STAGE_LABEL[t.stage] ?? t.stage, t.decision ? DECISION_LABEL[t.decision] : null]
      .filter(Boolean)
      .join(', ');
    doc.moveDown(0.25);
    doc
      .fillColor(TEXT)
      .font('Helvetica')
      .fontSize(10)
      .text(`•  ${t.change}`, left + 10, doc.y, { width: w - 10, continued: true })
      .fillColor(PURPLE_DARK)
      .text(`  (${stage})`);
    if (t.learning) {
      doc
        .fillColor(PURPLE_DARK)
        .fontSize(9.5)
        .text(`Learning: ${t.learning}`, left + 22, doc.y, { width: w - 22 });
    }
  }
  doc.x = left;
  doc.moveDown(0.8);
}

function drawNotes(doc: PDFKit.PDFDocument, s: QiYearSummary) {
  sectionTitle(doc, 'Call notes');
  const withNotes = s.sessions.filter((x) => x.notes.length > 0);
  if (withNotes.length === 0) {
    body(doc, 'No call notes recorded this year.');
    return;
  }
  const left = doc.page.margins.left;
  const w = contentWidth(doc);
  for (const x of withNotes) {
    const when =
      x.attendance === 'missed'
        ? 'did not attend'
        : x.sessionDate
          ? fmtDate(x.sessionDate)
          : 'added ahead of the call';
    ensureSpace(doc, 60);
    subTitle(doc, `${fmtPeriod(x.period)} 1:1 · ${when}`, { caps: false });
    for (const n of x.notes) {
      ensureSpace(doc, 32);
      doc.fillColor(PURPLE_DARK).font('Helvetica-Bold').fontSize(9).text(n.label, left, doc.y, { width: w });
      doc.fillColor(TEXT).font('Helvetica').fontSize(10).text(n.text, { width: w });
      doc.moveDown(0.4);
    }
    doc.moveDown(0.5);
  }
}

function drawFooters(doc: PDFKit.PDFDocument, data: QiSummaryPdfData, generatedOn: Date) {
  const range = doc.bufferedPageRange();
  const generated = generatedOn.toLocaleDateString('en-US', { dateStyle: 'long' });
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would otherwise start a new page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 40;
    const left = doc.page.margins.left;
    const w = contentWidth(doc);
    doc.fillColor(PURPLE_DARK).font('Helvetica').fontSize(8);
    doc.text(`${data.hospitalName} · Generated ${generated} from the CPCQC Engagement Tracker`, left, y, {
      width: w,
      lineBreak: false,
    });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, left, y, {
      width: w,
      align: 'right',
      lineBreak: false,
    });
    doc.page.margins.bottom = bottom;
  }
}

// ---------- Drawing primitives ----------

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string) {
  doc.moveDown(1.2);
  ensureSpace(doc, 70);
  const left = doc.page.margins.left;
  doc.fillColor(PURPLE).font('Helvetica-Bold').fontSize(15).text(text, left, doc.y, {
    width: contentWidth(doc),
  });
  const y = doc.y + 2;
  doc.moveTo(left, y).lineTo(left + 48, y).lineWidth(2.5).strokeColor(PURPLE).stroke();
  doc.moveDown(0.7);
}

function subTitle(doc: PDFKit.PDFDocument, text: string, opts: { caps?: boolean } = {}) {
  const caps = opts.caps ?? true;
  ensureSpace(doc, 50);
  doc
    .fillColor(caps ? PURPLE_DARK : PURPLE)
    .font('Helvetica-Bold')
    .fontSize(caps ? 10.5 : 11.5)
    .text(caps ? text.toUpperCase() : text, doc.page.margins.left, doc.y, {
      width: contentWidth(doc),
      characterSpacing: caps ? 0.6 : 0,
    });
  doc.moveDown(0.4);
}

function body(doc: PDFKit.PDFDocument, text: string) {
  doc.fillColor(PURPLE_DARK).font('Helvetica').fontSize(10).text(text, { width: contentWidth(doc) });
}

function drawStats(doc: PDFKit.PDFDocument, stats: Array<[value: string, label: string]>) {
  const left = doc.page.margins.left;
  const gap = 10;
  const boxW = (contentWidth(doc) - gap * (stats.length - 1)) / stats.length;
  const boxH = 52;
  const y = doc.y;
  stats.forEach(([value, label], i) => {
    const x = left + i * (boxW + gap);
    doc.roundedRect(x, y, boxW, boxH, 6).fill(CREAM_DARK);
    doc.fillColor(PURPLE).font('Helvetica-Bold').fontSize(17).text(value, x + 10, y + 9, {
      width: boxW - 20,
      lineBreak: false,
    });
    doc.fillColor(PURPLE_DARK).font('Helvetica').fontSize(8.5).text(label, x + 10, y + 32, {
      width: boxW - 20,
      lineBreak: false,
    });
  });
  doc.x = left;
  doc.y = y + boxH;
}

function tableRow(
  doc: PDFKit.PDFDocument,
  cells: string[],
  widths: number[],
  opts: { header?: boolean; colors?: Record<number, string> } = {},
) {
  const left = doc.page.margins.left;
  const pad = 5;
  doc.font(opts.header ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.header ? 8.5 : 9.5);
  const height =
    Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i]! - pad * 2 }))) + pad * 2;
  ensureSpace(doc, height);
  const y = doc.y;
  if (opts.header) doc.rect(left, y, contentWidth(doc), height).fill(CREAM_DARK);
  let x = left;
  cells.forEach((c, i) => {
    doc
      .fillColor(opts.header ? PURPLE_DARK : (opts.colors?.[i] ?? TEXT))
      .font(opts.header ? 'Helvetica-Bold' : 'Helvetica')
      .text(c, x + pad, y + pad, { width: widths[i]! - pad * 2 });
    x += widths[i]!;
  });
  doc
    .moveTo(left, y + height)
    .lineTo(left + contentWidth(doc), y + height)
    .lineWidth(0.5)
    .strokeColor('#D9D3E6')
    .stroke();
  doc.x = left;
  doc.y = y + height;
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "2026-Q3" → "Q3 2026", as the tracker shows it. */
function fmtPeriod(period: string): string {
  const m = /^(\d{4})-(Q[1-4])$/.exec(period);
  return m ? `${m[2]} ${m[1]}` : period;
}
