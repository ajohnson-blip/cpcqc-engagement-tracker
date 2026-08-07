import { describe, expect, it } from 'vitest';
import {
  parseRoster,
  isPlausibleEmail,
  tidyName,
  splitCsvLine,
  csvToRows,
} from './ce-roster.js';
import {
  formatTrainingDate,
  formatContactHours,
  certificateFilename,
  ACCREDITATION_DISCLAIMER,
} from './ce-certificate-pdf.js';

describe('isPlausibleEmail', () => {
  it('accepts ordinary and awkward-but-real addresses', () => {
    expect(isPlausibleEmail('jane.doe@cpcqc.org')).toBe(true);
    expect(isPlausibleEmail("o'brien+ce@uchealth.org")).toBe(true);
    expect(isPlausibleEmail('a@b.co')).toBe(true);
  });
  it('rejects what is clearly not an address', () => {
    expect(isPlausibleEmail('jane.doe')).toBe(false);
    expect(isPlausibleEmail('jane@doe')).toBe(false);
    expect(isPlausibleEmail('jane @doe.org')).toBe(false);
    expect(isPlausibleEmail('a@@b.org')).toBe(false);
    expect(isPlausibleEmail('jane@.org')).toBe(false);
    expect(isPlausibleEmail('')).toBe(false);
  });
});

describe('tidyName', () => {
  it('fixes shouting and whispering', () => {
    expect(tidyName('JANE DOE')).toBe('Jane Doe');
    expect(tidyName('jane doe')).toBe('Jane Doe');
  });
  it('leaves deliberate mixed case alone', () => {
    expect(tidyName('Jane McDonald')).toBe('Jane McDonald');
    expect(tidyName('Sanne van Dijk')).toBe('Sanne van Dijk');
  });
  it('collapses stray whitespace', () => {
    expect(tidyName('  Jane   Doe  ')).toBe('Jane Doe');
  });
});

describe('splitCsvLine / csvToRows', () => {
  it('honors quoted fields containing commas', () => {
    expect(splitCsvLine('"Doe, Jane",jane@x.org')).toEqual(['Doe, Jane', 'jane@x.org']);
  });
  it('handles escaped double quotes', () => {
    expect(splitCsvLine('"She said ""hi""",a@b.org')).toEqual(['She said "hi"', 'a@b.org']);
  });
  it('strips a UTF-8 BOM and handles CRLF', () => {
    const rows = csvToRows('﻿Name,Email\r\nJane,jane@x.org');
    expect(rows[0]).toEqual(['Name', 'Email']);
    expect(rows[1]).toEqual(['Jane', 'jane@x.org']);
  });
});

describe('parseRoster', () => {
  it('parses a simple Name/Email sheet', () => {
    const r = parseRoster([
      ['Name', 'Email'],
      ['Jane Doe', 'jane@cpcqc.org'],
      ['John Smith', 'john@cpcqc.org'],
    ]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ name: 'Jane Doe', email: 'jane@cpcqc.org', sourceRow: 2 });
    expect(r.problems).toHaveLength(0);
    expect(r.detected).toEqual({ nameColumns: ['Name'], emailColumn: 'Email' });
  });

  it('finds the header when the export has junk rows above it', () => {
    const r = parseRoster([
      ['Zoom Webinar Attendance Report'],
      ['Generated 2026-09-09'],
      [],
      ['First Name', 'Last Name', 'Email Address'],
      ['Jane', 'Doe', 'jane@cpcqc.org'],
    ]);
    expect(r.rows).toEqual([{ name: 'Jane Doe', email: 'jane@cpcqc.org', sourceRow: 5 }]);
    expect(r.detected.nameColumns).toEqual(['First Name', 'Last Name']);
  });

  it('unflips "Last, First"', () => {
    const r = parseRoster([
      ['Name', 'Email'],
      ['Doe, Jane', 'jane@cpcqc.org'],
    ]);
    expect(r.rows[0].name).toBe('Jane Doe');
  });

  it('flags duplicates, keeping the first, case-insensitively', () => {
    const r = parseRoster([
      ['Name', 'Email'],
      ['Jane Doe', 'jane@cpcqc.org'],
      ['Jane D', 'JANE@cpcqc.org'],
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].reason).toMatch(/Duplicate of row 2/);
  });

  it('flags bad and missing values instead of dropping them silently', () => {
    const r = parseRoster([
      ['Name', 'Email'],
      ['Jane Doe', 'not-an-email'],
      ['', 'ghost@cpcqc.org'],
      ['No Email Person', ''],
      ['Good Person', 'good@cpcqc.org'],
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe('Good Person');
    expect(r.problems.map((p) => p.reason)).toEqual([
      'Email does not look valid',
      'Missing name',
      'Missing email',
    ]);
  });

  it('skips fully blank spacer rows without reporting them', () => {
    const r = parseRoster([
      ['Name', 'Email'],
      ['Jane Doe', 'jane@cpcqc.org'],
      [],
      ['', ''],
      ['John Smith', 'john@cpcqc.org'],
    ]);
    expect(r.rows).toHaveLength(2);
    expect(r.problems).toHaveLength(0);
  });

  it('returns nothing usable when there is no recognizable header', () => {
    const r = parseRoster([
      ['Widget', 'Quantity'],
      ['Sprocket', '4'],
    ]);
    expect(r.rows).toHaveLength(0);
    expect(r.detected.emailColumn).toBeNull();
  });
});

describe('certificate formatting', () => {
  it('formats the date US-style without timezone drift', () => {
    expect(formatTrainingDate('2026-09-09')).toBe('9/9/2026');
    expect(formatTrainingDate('2026-12-01')).toBe('12/1/2026');
  });
  it('trims meaningless trailing zeros but keeps real precision', () => {
    expect(formatContactHours('1.50')).toBe('1.5');
    expect(formatContactHours(2)).toBe('2');
    expect(formatContactHours('1.25')).toBe('1.25');
  });
  it('keeps the accreditation statement verbatim', () => {
    expect(ACCREDITATION_DISCLAIMER).toContain('Colorado Nurses Association');
    expect(ACCREDITATION_DISCLAIMER).toContain(
      "American Nurses Credentialing Center's Commission on Accreditation",
    );
  });
});

describe('certificateFilename', () => {
  it('produces a filesystem-safe, meaningful name', () => {
    expect(certificateFilename('Breaking Stigma: Compassionate Care', 'Jane Doe')).toBe(
      'CE-Certificate_Breaking-Stigma-Compassionate-Care_Jane-Doe.pdf',
    );
  });
  it('strips characters that break filenames', () => {
    expect(certificateFilename('A/B "C"', "O'Brien")).toBe('CE-Certificate_AB-C_OBrien.pdf');
  });
});
