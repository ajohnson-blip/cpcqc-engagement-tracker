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
 *
 * Everything here is pure so it can be unit-tested without a file or a DB; the
 * caller turns the sheet into rows of cells first.
 */

export interface RosterRow {
  name: string;
  email: string;
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
  detected: { nameColumns: string[]; emailColumn: string | null };
}

const EMAIL_ALIASES = ['email', 'email address', 'e-mail', 'e-mail address', 'participant email', 'attendee email', 'user email'];
const NAME_ALIASES = ['name', 'full name', 'participant', 'participant name', 'attendee', 'attendee name', 'user name', 'display name'];
const FIRST_ALIASES = ['first name', 'first', 'firstname', 'given name'];
const LAST_ALIASES = ['last name', 'last', 'lastname', 'surname', 'family name'];

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
    return {
      rows: [],
      problems: [],
      detected: { nameColumns: [], emailColumn: null },
    };
  }

  const header = (rows[headerIdx] ?? []).map(key);
  const headerRaw = (rows[headerIdx] ?? []).map(norm);
  const emailCol = header.findIndex((c) => EMAIL_ALIASES.includes(c));
  const nameCol = header.findIndex((c) => NAME_ALIASES.includes(c));
  const firstCol = header.findIndex((c) => FIRST_ALIASES.includes(c));
  const lastCol = header.findIndex((c) => LAST_ALIASES.includes(c));

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
    out.push({ name, email, sourceRow });
  }

  return {
    rows: out,
    problems,
    detected: { nameColumns, emailColumn: emailCol >= 0 ? headerRaw[emailCol] : null },
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
