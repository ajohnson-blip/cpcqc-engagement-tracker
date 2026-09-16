/**
 * Hospital identifier normalization.
 *
 * The original hospital roster came from a spreadsheet, and Excel treated the
 * ID columns as numbers. CHA and AIM IDs arrived as floats ("632" → "632.0"),
 * and numeric CDPHE facility IDs additionally lost their leading zero
 * ("010542" → 10542 → "10542.0"). The annual report prints these verbatim, so
 * CDPHE has been receiving mangled IDs.
 *
 * Pure, so it can be unit-tested and used identically by the one-off repair
 * script and by the importers that match hospitals on these values (the `@/`
 * alias does not resolve under vitest, so this must not reach `@/db`).
 */

/** "632.0" → "632". Anything else is returned trimmed and unchanged. */
export function stripFloatArtifact(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim();
  if (!v) return null;
  return /^\d+\.0+$/.test(v) ? v.slice(0, v.indexOf('.')) : v;
}

/** CHA hospital IDs: integers, apart from tracker-only ones like "632b". */
export const normalizeChaId = stripFloatArtifact;

/** AIM IDs: integers. */
export const normalizeAimId = stripFloatArtifact;

/**
 * CDPHE facility IDs are six characters. Purely numeric ones lose their
 * leading zero to a spreadsheet import, so pad them back: "10542.0" → "010542"
 * (confirmed against CDPHE's facility record for Memorial Central).
 *
 * Left untouched: alphanumeric IDs ("01L581"), the "NA" placeholder, and
 * anything longer than six characters — which would mean the assumption is
 * wrong, and silently truncating or padding it would be worse than leaving it.
 */
export function normalizeCdpheId(raw: string | null | undefined): string | null {
  const v = stripFloatArtifact(raw);
  if (v === null) return null;
  if (/^\d{1,6}$/.test(v)) return v.padStart(6, '0');
  return v;
}

/**
 * Do two CHA IDs refer to the same hospital, ignoring import formatting?
 *
 * Importers match a spreadsheet's CHA ID against the stored one. Once the
 * stored values are normalized, a source file still carrying "632.0" would no
 * longer match "632" — so both sides go through this.
 */
export function chaIdsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeChaId(a);
  const nb = normalizeChaId(b);
  return na !== null && nb !== null && na.toLowerCase() === nb.toLowerCase();
}
