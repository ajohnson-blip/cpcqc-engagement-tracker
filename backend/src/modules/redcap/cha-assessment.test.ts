import { describe, expect, it } from 'vitest';
import {
  CONTRACT_VERSION,
  parseAssessResponse,
  soarCellsFromAssessments,
  type Assessment,
} from './cha-assessment.js';
import { monthDeadline } from './soar-engagement.js';

const CHA_TO_DAG = new Map([['428', 'denver_health'], ['300', 'advent_health_avis']]);

const assessment = (over: Partial<Assessment> = {}): Assessment =>
  ({
    cha_id: '428',
    period: '2026-07',
    submitted: true,
    complete: true,
    earliest_submission_date: '2026-08-10',
    records: { total: 4, complete: 4, attestation: 0 },
    attestation_only: false,
    missing_field_groups: [],
    notes: [],
    ...over,
  }) as Assessment;

const envelope = (assessments: Assessment[], over: Record<string, unknown> = {}) => ({
  contract_version: CONTRACT_VERSION,
  program: 'SOAR',
  program_year: 2026,
  methodology_version: 'soar-2026.10',
  computed_at: '2026-10-16T12:00:00Z',
  source: { records_read: 5028, redcap_project: 'CPCQC SOAR NTSV' },
  assessments,
  warnings: [],
  ...over,
});

describe('parseAssessResponse', () => {
  it('accepts a well-formed v1 response', () => {
    const r = parseAssessResponse(envelope([assessment()]));
    expect(r.assessments).toHaveLength(1);
    expect(r.methodology_version).toBe('soar-2026.10');
  });

  it('refuses a contract version it does not implement', () => {
    // Fields can change meaning between versions, and a figure that silently
    // changes meaning is worse than an error somebody can see.
    expect(() => parseAssessResponse(envelope([assessment()], { contract_version: 'v2' }))).toThrow(
      /contract v2/,
    );
  });

  it('rejects a malformed assessment rather than coercing it', () => {
    expect(() =>
      parseAssessResponse(envelope([{ ...assessment(), submitted: 'yes' } as never])),
    ).toThrow();
  });

  it('defaults the optional collections so callers need no guards', () => {
    const bare = { cha_id: '428', period: '2026-07', submitted: false, complete: false };
    const r = parseAssessResponse(envelope([bare as never]));
    expect(r.assessments[0]!.missing_field_groups).toEqual([]);
    expect(r.assessments[0]!.records.total).toBe(0);
  });
});

describe('soarCellsFromAssessments', () => {
  it('keys cells the way the REDCap path does', () => {
    const { cells } = soarCellsFromAssessments([assessment()], CHA_TO_DAG);
    expect([...cells.keys()]).toEqual(['denver_health::2026-07']);
    expect(cells.get('denver_health::2026-07')!.dagCode).toBe('denver_health');
  });

  it('computes the deadline and timeliness HERE, not from the service', () => {
    // The contract has the service report when data arrived and never judge
    // it. A submission after the deadline must still read as late.
    const deadline = monthDeadline(2026, 7);
    const late = soarCellsFromAssessments(
      [assessment({ earliest_submission_date: '2026-12-31' })],
      CHA_TO_DAG,
    ).cells.get('denver_health::2026-07')!;
    expect(late.deadline).toBe(deadline);
    expect(late.onTime).toBe(false);
    expect(late.daysFromDeadline).toBeGreaterThan(0);

    const onTime = soarCellsFromAssessments(
      [assessment({ earliest_submission_date: '2026-08-01' })],
      CHA_TO_DAG,
    ).cells.get('denver_health::2026-07')!;
    expect(onTime.onTime).toBe(true);
  });

  it('reports timeliness as unknown when no submission date was captured', () => {
    const cell = soarCellsFromAssessments(
      [assessment({ earliest_submission_date: null })],
      CHA_TO_DAG,
    ).cells.get('denver_health::2026-07')!;
    expect(cell.onTime).toBeNull();
    expect(cell.daysFromDeadline).toBeNull();
  });

  it('surfaces a CHA id it cannot map rather than dropping the hospital', () => {
    // A hospital missing from the grid reads as one that did not submit.
    const { cells, unmappedChaIds } = soarCellsFromAssessments(
      [assessment({ cha_id: '999' })],
      CHA_TO_DAG,
    );
    expect(cells.size).toBe(0);
    expect(unmappedChaIds).toEqual(['999']);
  });

  it('carries the grouped missing fields through untouched', () => {
    const groups = [
      { form: 'ntsv_cesarean_section', records: 9, fields: [{ field: 'age', label: "Patient's age" }] },
    ];
    const cell = soarCellsFromAssessments(
      [assessment({ complete: false, missing_field_groups: groups })],
      CHA_TO_DAG,
    ).cells.get('denver_health::2026-07')!;
    expect(cell.missingFieldGroups).toEqual(groups);
    // And no record identifiers can arrive by this route.
    expect(JSON.stringify(cell)).not.toContain('recordId');
  });

  it('maps a zero-case attestation month', () => {
    const cell = soarCellsFromAssessments(
      [
        assessment({
          records: { total: 0, complete: 0, attestation: 1 },
          attestation_only: true,
          complete: true,
        }),
      ],
      CHA_TO_DAG,
    ).cells.get('denver_health::2026-07')!;
    expect(cell.attestationOnly).toBe(true);
    expect(cell.dataComplete).toBe(true);
    expect(cell.noNtsv.nRows).toBe(1);
    expect(cell.ntsv.nRows).toBe(0);
  });

  it('carries an incomplete verdict onto the cell', () => {
    const cell = soarCellsFromAssessments(
      [assessment({ complete: false, records: { total: 4, complete: 1, attestation: 0 } })],
      CHA_TO_DAG,
    ).cells.get('denver_health::2026-07')!;
    expect(cell.submitted).toBe(true);
    expect(cell.dataComplete).toBe(false);
    expect(cell.ntsv.nComplete).toBe(1);
    expect(cell.ntsv.pctComplete).toBe(25);
  });

  it('ignores a period it cannot parse instead of inventing one', () => {
    const { cells } = soarCellsFromAssessments([assessment({ period: '2026-Q3' })], CHA_TO_DAG);
    expect(cells.size).toBe(0);
  });
});
