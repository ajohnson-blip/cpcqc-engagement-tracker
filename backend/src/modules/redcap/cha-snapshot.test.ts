import { describe, expect, it } from 'vitest';
import { parseSnapshotFile, SnapshotRejected, type SnapshotFile } from './cha-snapshot.js';

/**
 * A well-formed file, built here. Every hospital and figure is fictional — the
 * EX- ids belong to no real hospital — so nothing in this test resembles data
 * from REDCap.
 */
function sample(): SnapshotFile {
  const assessment = (chaId: string, period: string, over: Record<string, unknown> = {}) => ({
    cha_id: chaId,
    period,
    submitted: true,
    complete: true,
    earliest_submission_date: '2026-08-14',
    records: { total: 2, complete: 2, attestation: 0 },
    attestation_only: false,
    missing_field_groups: [],
    notes: [],
    ...over,
  });
  return {
    format_version: 'v2',
    snapshot_id: '00000000-0000-4000-8000-000000000001',
    generated_at: '2026-10-20T07:05:12Z',
    generator: { name: 'cpcqc-engagement-assessment', version: '0.2.0' },
    runs: [
      {
        program: 'SOAR',
        program_year: 2025,
        status: 'ok',
        methodology_version: 'soar-2026.10',
        source: { records_read: 10, redcap_project: 'Example project' },
        assessments: [assessment('EX-001', '2025-11'), assessment('EX-002', '2025-12')],
        warnings: [],
      },
      {
        program: 'SOAR',
        program_year: 2026,
        status: 'ok',
        methodology_version: 'soar-2026.10',
        source: { records_read: 10, redcap_project: 'Example project' },
        assessments: [
          assessment('EX-001', '2026-07'),
          assessment('EX-002', '2026-07', {
            records: { total: 0, complete: 0, attestation: 1 },
            attestation_only: true,
          }),
          assessment('EX-003', '2026-08', { notes: ['1 NTSV record has a delivery date in the future.'] }),
          assessment('EX-004', '2026-07', {
            complete: false,
            records: { total: 3, complete: 0, attestation: 0 },
            missing_field_groups: [
              { form: 'ntsv_cesarean_section', records: 3, fields: [{ field: 'example_field', label: 'Example field' }] },
            ],
          }),
        ],
        warnings: ['REDCap DAG "example_unknown" has SOAR data but is not in the crosswalk; its rows were skipped.'],
      },
      {
        program: 'TTT',
        program_year: 2026,
        status: 'error',
        error: { code: 'redcap_unavailable', message: 'REDCap did not respond within 90s' },
      },
    ],
  } as SnapshotFile;
}

const RECEIVED = new Date('2026-10-20T07:30:00Z');

function problems(raw: unknown, now = RECEIVED): string[] {
  try {
    parseSnapshotFile(raw, now);
  } catch (e) {
    if (e instanceof SnapshotRejected) return e.problems;
    throw e;
  }
  throw new Error('expected the file to be refused');
}

/** The sample with one change applied to a deep copy. */
function edited(change: (f: any) => void): unknown {
  const f = sample();
  change(f);
  return f;
}

describe('parseSnapshotFile', () => {
  it('accepts a well-formed file', () => {
    const f = parseSnapshotFile(sample(), RECEIVED);
    expect(f.runs.map((r) => `${r.program}:${r.program_year}:${r.status}`)).toEqual([
      'SOAR:2025:ok',
      'SOAR:2026:ok',
      'TTT:2026:error',
    ]);
  });

  it.each([
    ['the envelope', (f: any) => (f.extra = 1), 'file'],
    ['a run', (f: any) => (f.runs[1].computed_at = 'x'), 'runs[1]'],
    ['an assessment', (f: any) => (f.runs[1].assessments[0].delivery_date = '2026-07-03'), 'runs[1].assessments[0]'],
    ['record counts', (f: any) => (f.runs[1].assessments[0].records.age = 31), 'runs[1].assessments[0].records'],
    ['a missing-field group', (f: any) => (f.runs[1].assessments[3].missing_field_groups[0].record_ids = ['1']), 'runs[1].assessments[3].missing_field_groups[0]'],
    ['a missing field', (f: any) => (f.runs[1].assessments[3].missing_field_groups[0].fields[0].value = ''), 'runs[1].assessments[3].missing_field_groups[0].fields[0]'],
    ['an error run', (f: any) => (f.runs[2].assessments = []), 'runs[2]'],
  ])('refuses a key the contract does not define on %s', (_where, change, path) => {
    const found = problems(edited(change));
    expect(found.some((p) => p.startsWith(`${path}: key the contract does not define`))).toBe(true);
  });

  it('names the stray key but never repeats its value', () => {
    const found = problems(edited((f) => (f.runs[1].assessments[0].delivery_date = '2026-07-03'))).join(' ');
    expect(found).toContain('"delivery_date"');
    expect(found).not.toContain('2026-07-03');
  });

  it('never repeats a malformed value either', () => {
    const found = problems(
      edited((f) => {
        f.runs[1].assessments[0].cha_id = 'R-1041 Jane';
        f.runs[1].program = 'SOAR-1041';
        f.runs[1].assessments[1].earliest_submission_date = '07/03/1990';
      }),
    ).join(' ');
    for (const value of ['R-1041', 'Jane', 'SOAR-1041', '07/03/1990', '1990']) {
      expect(found).not.toContain(value);
    }
  });

  it('refuses another format version with that reason alone', () => {
    expect(problems(edited((f) => (f.format_version = 'v1'))) ).toEqual([
      'format_version: this tracker implements v2 only',
    ]);
  });

  it('requires every assessment key, even when null', () => {
    const found = problems(edited((f) => delete f.runs[1].assessments[0].earliest_submission_date));
    expect(found).toContain('runs[1].assessments[0].earliest_submission_date: required');
  });

  it('allows linkage on TtT only', () => {
    const linkage = { positive_screens: 4, patient_forms: 3, shortfall: 1, floor_met: true, ideal_met: false };
    expect(problems(edited((f) => (f.runs[1].assessments[0].linkage = linkage)))).toContain(
      'runs[1].assessments[0].linkage: linkage is defined for TTT only',
    );
    const ttt = edited((f) => {
      f.runs[2] = { ...f.runs[1], program: 'TTT', assessments: [{ ...f.runs[1].assessments[0], linkage }] };
    });
    expect(() => parseSnapshotFile(ttt, RECEIVED)).not.toThrow();
  });

  it('checks periods against the program cadence and year', () => {
    expect(problems(edited((f) => (f.runs[1].assessments[0].period = '2026-Q3')))).toContain(
      'runs[1].assessments[0].period: not a SOAR reporting period',
    );
    expect(problems(edited((f) => (f.runs[1].assessments[0].period = '2025-07')))).toContain(
      'runs[1].assessments[0].period: outside program year 2026',
    );
    const spark = edited((f) => {
      f.runs[1].program = 'SPARK';
      f.runs[1].assessments = [{ ...f.runs[1].assessments[0], period: '2026-Q3' }];
    });
    expect(() => parseSnapshotFile(spark, RECEIVED)).not.toThrow();
  });

  it('refuses two runs for one program year, and two assessments for one cell', () => {
    expect(problems(edited((f) => f.runs.push(f.runs[1])))).toContain(
      'runs[3]: a second run for SOAR 2026',
    );
    expect(problems(edited((f) => f.runs[1].assessments.push(f.runs[1].assessments[0])))).toContain(
      'runs[1].assessments[4]: a second assessment for the same hospital and period',
    );
  });

  it('refuses counts that cannot be true', () => {
    expect(problems(edited((f) => (f.runs[1].assessments[0].records.complete = 99)))).toContain(
      'runs[1].assessments[0].records: more complete records than records',
    );
    expect(problems(edited((f) => (f.runs[1].assessments[0].records.total = -1))).length).toBeGreaterThan(0);
  });

  it('refuses a file stamped later than its arrival, allowing for clock skew', () => {
    expect(problems(edited((f) => (f.generated_at = '2026-10-20T08:00:00Z')))).toEqual([
      'generated_at: later than the time it was received',
    ]);
    const skewed = edited((f) => (f.generated_at = '2026-10-20T07:35:00Z'));
    expect(() => parseSnapshotFile(skewed, RECEIVED)).not.toThrow();
  });

  it('refuses an error code the contract does not list', () => {
    expect(problems(edited((f) => (f.runs[2].error.code = 'oops')))[0]).toMatch(
      /^runs\[2\]\.error\.code: expected one of "redcap_unavailable", "configuration", "internal"$/,
    );
  });

  it('reports at most twenty problems', () => {
    const found = problems(
      edited((f) => {
        for (const a of f.runs[1].assessments) for (let i = 0; i < 10; i++) a[`k${i}`] = 1;
        for (const a of f.runs[0].assessments) for (let i = 0; i < 10; i++) a.records[`k${i}`] = 1;
        f.runs[1].assessments.forEach((a: any) => (a.cha_id = '!'));
        f.runs[0].assessments.forEach((a: any) => (a.submitted = 'yes'));
        for (let i = 0; i < 30; i++) f.runs[1].warnings.push('');
      }),
    );
    expect(found).toHaveLength(21);
    expect(found[20]).toMatch(/^…and \d+ more$/);
  });

  it('refuses something that is not a file at all', () => {
    expect(problems(null)).toEqual(['file: expected object']);
    expect(problems([])).toEqual(['file: expected object']);
  });
});
