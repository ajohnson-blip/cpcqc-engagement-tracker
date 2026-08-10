/**
 * The CE program list — the initiatives that host CPCQC educational trainings —
 * and logo resolution for their certificates.
 *
 * The program list is deliberately separate from the `initiatives` table:
 * IMPACT hosts CE trainings but is not a QI initiative in this tracker, and the
 * QI enum has no room for it. Adding a program is a one-line change here.
 *
 * Logos resolve DB-first, then the files committed under
 * assets/initiative-logos/. Staff uploads go to the DB because Render's
 * filesystem is ephemeral — a file written at runtime is gone at the next
 * deploy, silently unbranding every certificate issued afterwards.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';

export interface CeProgram {
  code: string;
  /** Shown in the UI and used as the PDF fallback when no logo exists. */
  label: string;
  /**
   * A training CPCQC hosts directly, not on behalf of an initiative. There is
   * no host logo to show — CPCQC's own mark already appears on the certificate —
   * so the host slot is left empty rather than filled with fallback text, and
   * no logo is expected or requested for it.
   */
  generic?: boolean;
}

export const CE_PROGRAMS: CeProgram[] = [
  { code: 'SPARK', label: 'SPARK' },
  { code: 'SOAR', label: 'SOAR' },
  { code: 'NEST', label: 'NEST' },
  { code: 'TTT', label: 'Turning the Tide' },
  { code: 'IMPACT', label: 'IMPACT' },
  { code: 'FIRST', label: 'FIRST' },
  { code: 'GENERAL', label: 'CPCQC-hosted education', generic: true },
];

/** CPCQC's own mark appears on every certificate regardless of host program. */
export const CPCQC_LOGO_CODE = 'CPCQC';

export const CE_PROGRAM_CODES = CE_PROGRAMS.map((p) => p.code);

/** Codes that accept a logo upload — every non-generic program, plus CPCQC's
 *  own mark. Generic programs have no host logo by design. */
export const LOGO_CODES = [
  ...CE_PROGRAMS.filter((p) => !p.generic).map((p) => p.code),
  CPCQC_LOGO_CODE,
];

export function ceProgramLabel(code: string): string {
  if (code === CPCQC_LOGO_CODE) return 'CPCQC';
  return CE_PROGRAMS.find((p) => p.code === code)?.label ?? code;
}

/** True for CPCQC-hosted trainings that aren't tied to an initiative. */
export function isGenericProgram(code: string): boolean {
  return CE_PROGRAMS.find((p) => p.code === code)?.generic === true;
}

/**
 * What to print in the host-logo slot when no logo image exists. Empty for
 * generic programs: "CPCQC-hosted education" set in type beside the CPCQC logo
 * would read as a mistake rather than as branding.
 */
export function hostLogoFallbackLabel(code: string): string {
  return isGenericProgram(code) ? '' : ceProgramLabel(code);
}

export function isCeProgramCode(code: string): boolean {
  return CE_PROGRAM_CODES.includes(code);
}

export function isLogoCode(code: string): boolean {
  return LOGO_CODES.includes(code);
}

// ---------------------------------------------------------------------------
// Image validation
// ---------------------------------------------------------------------------

/** pdfkit embeds PNG and JPEG only. 4 MB is far above any real logo. */
export const MAX_LOGO_BYTES = 4 * 1024 * 1024;

export interface DetectedImage {
  mimeType: 'image/png' | 'image/jpeg';
}

/**
 * Identify an image by its magic bytes rather than its filename or the
 * browser-supplied content type — a .png that is actually an SVG would sail
 * past an extension check and then fail at render time, mid-send.
 */
export function detectImageType(buf: Buffer): DetectedImage | { error: string } {
  if (!buf || buf.length === 0) return { error: 'The file is empty.' };
  if (buf.length > MAX_LOGO_BYTES) {
    return { error: `That file is ${(buf.length / 1024 / 1024).toFixed(1)} MB. The limit is 4 MB.` };
  }
  const isPng =
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  if (isPng) return { mimeType: 'image/png' };

  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (isJpeg) return { mimeType: 'image/jpeg' };

  // SVG is the likely wrong-format upload, so name the fix rather than just refusing.
  const head = buf.subarray(0, 400).toString('latin1').trim().toLowerCase();
  if (head.startsWith('<?xml') || head.includes('<svg')) {
    return {
      error:
        'That looks like an SVG, which cannot be embedded in a PDF. Export it as a PNG (transparent background, at least 600px wide) and upload that.',
    };
  }
  return { error: 'Unsupported image format. Upload a PNG or JPEG.' };
}

// ---------------------------------------------------------------------------
// Resolution: uploaded (DB) first, then the committed file
// ---------------------------------------------------------------------------

/** backend/assets/initiative-logos/ — resolved from this file, since the server
 *  runs from source (tsx) rather than a build output directory. */
const LOGO_DIR = fileURLToPath(new URL('../../../assets/initiative-logos/', import.meta.url));

function readLogoFile(basename: string): Buffer | null {
  for (const ext of ['png', 'jpg', 'jpeg']) {
    const path = `${LOGO_DIR}${basename}.${ext}`;
    if (existsSync(path)) {
      try {
        return readFileSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The logo bytes for a code, or null when neither an upload nor a committed
 * file exists — in which case the renderer sets the program name in type, so a
 * missing logo yields a plain-but-valid certificate rather than a failure.
 */
export async function loadLogo(code: string): Promise<Buffer | null> {
  const row = await db.query.ceProgramLogos.findFirst({
    where: eq(schema.ceProgramLogos.programCode, code),
  });
  if (row) {
    try {
      return Buffer.from(row.bytesBase64, 'base64');
    } catch {
      /* corrupt row — fall through to the committed file */
    }
  }
  return readLogoFile(code.toLowerCase());
}

/** Which codes currently have a logo, from either source. Surfaced in the UI so
 *  a PM never discovers a blank logo slot after 100 certificates have gone out. */
export async function logoAvailability(): Promise<Record<string, boolean>> {
  const rows = await db.select({ code: schema.ceProgramLogos.programCode }).from(schema.ceProgramLogos);
  const uploaded = new Set(rows.map((r) => r.code));
  const out: Record<string, boolean> = {};
  for (const code of LOGO_CODES) {
    out[code] = uploaded.has(code) || readLogoFile(code.toLowerCase()) !== null;
  }
  return out;
}
