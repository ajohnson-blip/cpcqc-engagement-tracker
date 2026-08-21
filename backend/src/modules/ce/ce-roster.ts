/**
 * Participant-roster parsing for CE certificates.
 *
 * PMs upload whatever their registration/webinar platform exported (Zoom,
 * Eventbrite, a hand-kept spreadsheet), so this is deliberately forgiving about
 * shape and strict about the result:
 *   - finds the header row even if the export has title/blurb rows above it
 *   - matches name/email columns by a set of known aliases
 *   - supports a single "Name" column OR separate First/Last columns
 *   - flags invalid emails and in-file duplicates instead of silently dropping
 *   - optionally reads a per-participant completion date, for asynchronous
 *     courses where people finish on different days
 *
 * Everything here is pure so it can be unit-tested without a file or a DB; the
 * caller turns the sheet into rows of cells first.
 */

export interface RosterRow {
  name: string;
  email: string;
  /**
   * Per-participant completion date (ISO), when the file supplies one.
   * Asynchronous courses are completed on different days by different people,
   * so the training's own date would be wrong on the certificate.
   */
  completionDate?: string;
  /** 1-based row number in the source file, for error messages the PM can act on. */
  sourceRow: number;
}

export interface RosterProblem {
  sourceRow: number;
  /** The raw values we saw, so the PM can find the row in their file. */
  name: string;
  email: string;
  reason: string;
}

export interface ParsedRoster {
  rows: RosterRow[];
  problems: RosterProblem[];
  /** Which source columns were used, echoed back so the PM can confirm. */
  detected: { nameColumns: string[]; emailColumn: string | null; dateColumn: string | null };
  /**
   * Every header we saw. Returned even on failure: "no name/email columns
   * found" is unactionable on its own, but seeing the headers actually present
   * usually makes the mismatch obvious.
   */
  headersSeen: string[];
}

const EMAIL_ALIASES = ['email', 'email address', 'e-mail', 'e-mail address', 'participant email', 'attendee email', 'user email'];
const NAME_ALIASES = ['name', 'full name', 'participant', 'participant name', 'attendee', 'attendee name', 'user name', 'display name'];
const FIRST_ALIASES = ['first name', 'first', 'firstname', 'given name'];
const LAST_ALIASES = ['last name', 'last', 'lastname', 'surname', 'family name'];
const DATE_ALIASES = [
  'completion date', 'date completed', 'completed', 'completed on', 'date',
  'date of completion', 'training date', 'course completion date', 'completion',
];

const norm = (v: unknown): string => String(v ?? '').trim();
const key = (v: unknown): string => norm(v).toLowerCase().replace(/\s+/g, ' ');

/**
 * Deliberately permissive: this only rejects what is clearly not an address.
 * Bouncing a real participant's certificate because their address looked unusual
 * is worse than letting SendGrid be the final judge.
 */
export function isPlausibleEmail(value: string): boolean {
  const v = value.trim();
  if (v.length < 5 || v.length > 254) return false;
  if (/\s/.test(v)) return false;
  const at = v.indexOf('@');
  if (at <= 0 || at !== v.lastIndexOf('@')) return false;
  const domain = v.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/**
 * Normalise a completion date to ISO. Excel hands dates over as serial numbers
 * or as Date objects depending on how the cell was formatted, and PMs type
 * them in several ways — none of which should be a reason to reject a row.
 * Returns null when it isn't confidently a date; the caller then falls back to
 * the training's own date.
 */
export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return null;

  // Excel serial: days since 1899-12-30 (its epoch, leap-year bug included).
  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const ms = Math.round(Number(raw)) * 86400000;
    const d = new Date(Date.UTC(1899, 11, 30) + ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  // US-style M/D/YYYY — the format CPCQC's own sheets use.
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(raw);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Title-case a name that arrived shouting or whispering; leave mixed case alone
 *  so "McDonald" and "van Dijk" survive untouched. */
export function tidyName(raw: string): string {
  const v = raw.trim().replace(/\s+/g, ' ');
  if (!v) return v;
  const allOneCase = v === v.toUpperCase() || v === v.toLowerCase();
  if (!allOneCase) return v;
  return v
    .split(' ')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** "Doe, Jane" → "Jane Doe". Only when there's exactly one comma. */
function unflipName(raw: string): string {
  const parts = raw.split(',');
  if (parts.length !== 2) return raw;
  const [last, first] = parts.map((p) => p.trim());
  if (!last || !first) return raw;
  return `${first} ${last}`;
}

function findHeaderRow(rows: unknown[][]): number {
  // The header is the first row that contains something email-shaped AND
  // something name-shaped — exports often carry title/date rows above it.
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    const cells = (rows[i] ?? []).map(key);
    const hasEmail = cells.some((c) => EMAIL_ALIASES.includes(c));
    const hasName = cells.some(
      (c) => NAME_ALIASES.includes(c) || FIRST_ALIASES.includes(c) || LAST_ALIASES.includes(c),
    );
    if (hasEmail && hasName) return i;
  }
  return -1;
}

/**
 * Parse a sheet (array of rows of cells) into a participant roster.
 * Row 0 need not be the header — see findHeaderRow.
 */
export function parseRoster(rows: unknown[][]): ParsedRoster {
  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) {
    // Report the most populated row's headers — the likeliest intended header
    // row — so the caller can say what it saw instead of a bare refusal.
    const candidate = rows
      .slice(0, 25)
      .map((r) => (r ?? []).map(norm).filter(Boolean))
      .sort((a, b) => b.length - a.length)[0];
    return {
      rows: [],
      problems: [],
      detected: { nameColumns: [], emailColumn: null, dateColumn: null },
      headersSeen: candidate ?? [],
    };
  }

  const header = (rows[headerIdx] ?? []).map(key);
  const headerRaw = (rows[headerIdx] ?? []).map(norm);
  const emailCol = header.findIndex((c) => EMAIL_ALIASES.includes(c));
  const nameCol = header.findIndex((c) => NAME_ALIASES.includes(c));
  const firstCol = header.findIndex((c) => FIRST_ALIASES.includes(c));
  const lastCol = header.findIndex((c) => LAST_ALIASES.includes(c));
  const dateCol = header.findIndex((c) => DATE_ALIASES.includes(c));

  const nameColumns: string[] = [];
  if (nameCol >= 0) nameColumns.push(headerRaw[nameCol]);
  else {
    if (firstCol >= 0) nameColumns.push(headerRaw[firstCol]);
    if (lastCol >= 0) nameColumns.push(headerRaw[lastCol]);
  }

  const out: RosterRow[] = [];
  const problems: RosterProblem[] = [];
  const seen = new Map<string, number>(); // lowercased email -> source row

  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const cells = rows[i] ?? [];
    const sourceRow = i + 1; // 1-based, matches what the PM sees in Excel

    const rawEmail = emailCol >= 0 ? norm(cells[emailCol]) : '';
    const completionDate = dateCol >= 0 ? toIsoDate(cells[dateCol]) : null;
    let rawName = nameCol >= 0 ? norm(cells[nameCol]) : '';
    if (!rawName && (firstCol >= 0 || lastCol >= 0)) {
      rawName = [firstCol >= 0 ? norm(cells[firstCol]) : '', lastCol >= 0 ? norm(cells[lastCol]) : '']
        .filter(Boolean)
        .join(' ');
    }

    // Entirely blank row — spacer, not a problem worth reporting.
    if (!rawEmail && !rawName) continue;

    const name = tidyName(unflipName(rawName));
    const email = rawEmail;

    if (!name) {
      problems.push({ sourceRow, name: rawName, email, reason: 'Missing name' });
      continue;
    }
    if (!email) {
      problems.push({ sourceRow, name, email: rawEmail, reason: 'Missing email' });
      continue;
    }
    if (!isPlausibleEmail(email)) {
      problems.push({ sourceRow, name, email, reason: 'Email does not look valid' });
      continue;
    }

    const dupeOf = seen.get(email.toLowerCase());
    if (dupeOf !== undefined) {
      problems.push({
        sourceRow,
        name,
        email,
        reason: `Duplicate of row ${dupeOf} — only the first is kept`,
      });
      continue;
    }

    seen.set(email.toLowerCase(), sourceRow);
    out.push({ name, email, sourceRow, ...(completionDate ? { completionDate } : {}) });
  }

  return {
    rows: out,
    problems,
    detected: {
      nameColumns,
      emailColumn: emailCol >= 0 ? headerRaw[emailCol] : null,
      dateColumn: dateCol >= 0 ? headerRaw[dateCol] : null,
    },
    headersSeen: headerRaw.filter(Boolean),
  };
}

/** Split a CSV line honoring double-quoted fields (Zoom exports quote names). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse raw CSV text into rows of cells. Handles CRLF and a UTF-8 BOM. */
export function csvToRows(text: string): string[][] {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\n|\r/)
    .map((line) => splitCsvLine(line));
}
