/**
 * CE certificate renderer (pdfkit, landscape US Letter — matches the CPCQC
 * template proportions).
 *
 * Layout, top to bottom:
 *   [host initiative logo]   Certificate of Completion   [CPCQC logo]
 *                            PRESENTED TO :
 *                            <recipient name>            (script-style, purple)
 *                            ──────────────────────────
 *          THIS CERTIFICATE ACKNOWLEDGES THAT THE RECIPIENT
 *                    HAS SUCCESSFULLY COMPLETED
 *                        <TRAINING TITLE>
 *                          <training date>
 *                    <n> Nursing Contact Hours
 *                   offered by CPCQC www.cpcqc.org
 *   <ANCC/CNA accreditation disclaimer>            Activity ID <id>
 *
 * pdfkit only embeds PNG/JPEG, so logos must be raster. A missing logo degrades
 * to the program name set in type rather than failing the render.
 */
// NB: this module deliberately imports nothing from ce-programs.ts — that file
// reaches the database, which would drag a DB import into the unit tests (the
// '@/' alias doesn't resolve under vitest). Logos and the fallback label are
// passed in by the caller, which keeps rendering pure and testable.
import PDFDocument from 'pdfkit';

const PURPLE = '#6B529B';
const PURPLE_DEEP = '#5A3E85';
const SLATE = '#6A6587';

/**
 * The accreditation statement is regulated boilerplate — it must appear verbatim
 * on every certificate. Do not reword.
 */
export const ACCREDITATION_DISCLAIMER =
  "This nursing continuing professional development activity was approved by Colorado Nurses Association, an " +
  "accredited approver by the American Nurses Credentialing Center's Commission on Accreditation";

export interface CertificateData {
  programCode: string;
  /** Set in type where the logo would go when no logo image is available. */
  programLabel: string;
  trainingTitle: string;
  /** ISO 'YYYY-MM-DD'. Rendered US-style (M/D/YYYY) to match the template. */
  trainingDate: string;
  contactHours: string | number;
  activityId: string;
  recipientName: string;
  /** Printed small in the footer so a reissued certificate is traceable. */
  certificateCode?: string;
  /** PNG/JPEG bytes. Either may be null — the certificate still renders. */
  logos?: { program?: Buffer | null; cpcqc?: Buffer | null };
}

/** '2026-09-09' → '9/9/2026'. Parsed as plain date parts — no timezone shifting. */
export function formatTrainingDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim());
  if (!m) return String(iso);
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

/** 1.5 → '1.5', 2 → '2', '1.50' → '1.5' — trailing zeros look like a typo on a
 *  certificate, but a genuine 1.25 must survive. */
export function formatContactHours(value: string | number): string {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return String(value);
  return String(Number(n.toFixed(2)));
}

/** A filename that's meaningful in a downloads folder and safe on every OS.
 *  Lives here (not in the service) so it stays free of DB imports and testable. */
export function certificateFilename(trainingTitle: string, recipientName: string): string {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 48);
  return `CE-Certificate_${slug(trainingTitle)}_${slug(recipientName)}.pdf`;
}

export function renderCertificatePdf(data: CertificateData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: 'LETTER',
      layout: 'landscape',
      margins: { top: 40, bottom: 40, left: 54, right: 54 },
      info: {
        Title: `CE Certificate — ${data.trainingTitle}`,
        Author: 'Colorado Perinatal Care Quality Collaborative',
        Subject: `Certificate of Completion for ${data.recipientName}`,
      },
    });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      draw(doc, data);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    doc.end();
  });
}

function draw(doc: PDFKit.PDFDocument, data: CertificateData) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const centerText = (text: string, y: number, size: number, color: string, font = 'Helvetica') => {
    doc.font(font).fontSize(size).fillColor(color).text(text, left, y, { width, align: 'center' });
  };

  // ---- Header band: host logo · title · CPCQC logo ----
  const headerTop = 34;
  const logoBoxH = 58;

  const hostLogo = data.logos?.program ?? null;
  if (hostLogo) {
    fitImage(doc, hostLogo, left, headerTop, 150, logoBoxH, 'left');
  } else if (data.programLabel) {
    // No logo yet — set the program name so the certificate is still valid.
    // An empty label means the slot is intentionally blank (CPCQC-hosted
    // trainings, where the CPCQC mark on the right already identifies the host).
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor(PURPLE_DEEP)
      .text(data.programLabel, left, headerTop + 18, { width: 150, align: 'left' });
  }

  const cpcqc = data.logos?.cpcqc ?? null;
  if (cpcqc) {
    fitImage(doc, cpcqc, right - 130, headerTop, 130, logoBoxH, 'right');
  } else {
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor(PURPLE)
      .text('CPCQC', right - 130, headerTop + 18, { width: 130, align: 'right' });
  }

  centerText('Certificate of Completion', headerTop + 14, 23, SLATE);

  // ---- Recipient ----
  centerText('PRESENTED TO :', headerTop + 62, 12, PURPLE_DEEP);

  // The template uses a script face. pdfkit ships only the standard 14 PostScript
  // fonts, so Times-Italic stands in — embedding a licensed script font would be
  // the only way to match exactly.
  const nameY = headerTop + 84;
  doc
    .font('Times-Italic')
    .fontSize(38)
    .fillColor(PURPLE_DEEP)
    .text(data.recipientName, left, nameY, { width, align: 'center', lineBreak: false });

  // Rule under the name
  const ruleY = nameY + 52;
  doc
    .moveTo(left + 40, ruleY)
    .lineTo(right - 40, ruleY)
    .lineWidth(1.2)
    .strokeColor(PURPLE_DEEP)
    .stroke();

  // ---- Body ----
  // NB: the source template misspells this as "RECEIPIENT"; corrected here.
  centerText(
    'THIS CERTIFICATE ACKNOWLEDGES THAT THE RECIPIENT',
    ruleY + 22,
    14,
    PURPLE_DEEP,
    'Helvetica-Bold',
  );
  centerText('HAS SUCCESSFULLY COMPLETED', ruleY + 40, 14, PURPLE_DEEP, 'Helvetica-Bold');

  // Title: shrink to fit rather than wrapping to a third line.
  const title = data.trainingTitle.toUpperCase();
  const titleY = ruleY + 68;
  let titleSize = 26;
  doc.font('Helvetica-Bold');
  while (titleSize > 14 && doc.fontSize(titleSize).heightOfString(title, { width }) > 76) {
    titleSize -= 1;
  }
  doc.fontSize(titleSize).fillColor(PURPLE).text(title, left, titleY, { width, align: 'center' });

  const afterTitle = titleY + doc.heightOfString(title, { width }) + 10;
  centerText(formatTrainingDate(data.trainingDate), afterTitle, 13, PURPLE);
  centerText(
    `${formatContactHours(data.contactHours)}   Nursing Contact Hours`,
    afterTitle + 24,
    12,
    '#2A2536',
    'Helvetica-Bold',
  );
  centerText('offered by CPCQC www.cpcqc.org', afterTitle + 40, 11, '#2A2536', 'Helvetica-Bold');

  // ---- Footer: disclaimer (left) · activity ID (right) ----
  const footerY = doc.page.height - doc.page.margins.bottom - 34;
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor('#3F3A4B')
    .text(ACCREDITATION_DISCLAIMER, left, footerY, { width: width * 0.62, align: 'left' });

  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor('#3F3A4B')
    .text(`Activity ID ${data.activityId}`, left + width * 0.68, footerY + 10, {
      width: width * 0.32,
      align: 'right',
    });

  if (data.certificateCode) {
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .fillColor('#8B8699')
      .text(data.certificateCode, left + width * 0.68, footerY + 22, {
        width: width * 0.32,
        align: 'right',
      });
  }
}

/**
 * Draw an image scaled to fit a box, anchored left or right. pdfkit's `fit`
 * preserves the aspect ratio for us. A corrupt or unsupported image is skipped —
 * one bad logo must not stop a 100-certificate run.
 */
function fitImage(
  doc: PDFKit.PDFDocument,
  buf: Buffer,
  x: number,
  y: number,
  maxW: number,
  maxH: number,
  anchor: 'left' | 'right',
) {
  try {
    // pdfkit takes only 'right'/'center' here — left-alignment is the default,
    // so it's expressed by omitting the option.
    doc.image(buf, x, y, {
      fit: [maxW, maxH],
      valign: 'center',
      ...(anchor === 'right' ? { align: 'right' as const } : {}),
    });
  } catch {
    /* unsupported or corrupt image — leave the slot empty */
  }
}
