/**
 * The CE program list — the initiatives that host CPCQC educational trainings.
 *
 * Deliberately separate from the `initiatives` table: IMPACT hosts CE trainings
 * but is not a QI initiative in this tracker, and the QI enum has no room for it.
 * Adding a program here + dropping a logo file in assets/initiative-logos is all
 * that's needed — no migration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface CeProgram {
  code: string;
  /** Shown in the UI and used as the PDF fallback when no logo file exists. */
  label: string;
}

export const CE_PROGRAMS: CeProgram[] = [
  { code: 'SPARK', label: 'SPARK' },
  { code: 'SOAR', label: 'SOAR' },
  { code: 'NEST', label: 'NEST' },
  { code: 'TTT', label: 'Turning the Tide' },
  { code: 'IMPACT', label: 'IMPACT' },
];

export const CE_PROGRAM_CODES = CE_PROGRAMS.map((p) => p.code);

export function ceProgramLabel(code: string): string {
  return CE_PROGRAMS.find((p) => p.code === code)?.label ?? code;
}

export function isCeProgramCode(code: string): boolean {
  return CE_PROGRAM_CODES.includes(code);
}

/** backend/assets/initiative-logos/ — resolved from this file, since the server
 *  runs from source (tsx) rather than a build output directory. */
const LOGO_DIR = fileURLToPath(new URL('../../../assets/initiative-logos/', import.meta.url));

/** CPCQC's own mark, on every certificate regardless of host initiative. */
export function cpcqcLogo(): Buffer | null {
  return readLogoFile('cpcqc');
}

/**
 * The host initiative's logo, or null when the file hasn't been added yet. The
 * renderer falls back to the program name as text, so a missing logo degrades to
 * a plain-but-correct certificate rather than a crash — and the UI warns first.
 */
export function programLogo(code: string): Buffer | null {
  return readLogoFile(code.toLowerCase());
}

function readLogoFile(basename: string): Buffer | null {
  // PNG preferred (pdfkit supports PNG and JPEG only — not SVG).
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

/** Which program logos are missing — surfaced in the preview so a PM never
 *  discovers a blank logo slot after 100 certificates have gone out. */
export function missingProgramLogos(): string[] {
  return CE_PROGRAMS.filter((p) => programLogo(p.code) === null).map((p) => p.code);
}
