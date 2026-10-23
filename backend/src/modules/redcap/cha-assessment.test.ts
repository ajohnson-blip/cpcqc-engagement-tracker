import { describe, expect, it } from 'vitest';
import { nestCellsFromAssessments, soarCellsFromAssessments, sparkCellsFromAssessments } from './cha-assessment.js';
import type { ChaAssessment } from './cha-snapshot.js';
import { monthDeadline } from './soar-engagement.js';
import { monthDeadline as nestMonthDeadline } from './nest-engagement.js';
import { checkCompleteness, competingRecordCount, ALWAYS_REQUIRED, type RedcapRow } from './spark-engagement.js';

const CHA_TO_DAG = new Map([['EX-001', 'example_hospital_a'], ['EX-002', 'example_hospital_b']]);

const assessment = (over: Partial<ChaAssessment> = {}): ChaAssessment => ({
  cha_id: 'EX-001',
  period: '2026-07',
  submitted: true,
  complete: true,
  earliest_submission_date: '2026-08-10',
  records: { total: 4, complete: 4, attestation: 0 },
  attestation_only: false,
  missing_field_groups: [],
  notes: [],
  ...over,
});

describe('soarCellsFromAssessments', () => {
  it('keys cells the way the REDCap path does', () => {
    const { cells } = soarCellsFromAssessments([assessment()], CHA_TO_DAG);
    expect([...cells.keys()]).toEqual(['example_hospital_a::2026-07']);
    expect(cells.get('example_hospital_a::2026-07')!.dagCode).toBe('example_hospital_a');
  });

  it('computes the deadline and timeliness HERE, not at CHA', () => {
    // The contract has CHA report when data arrived and never judge it. A
    // submission after the deadline must still read as late.
    const deadline = monthDeadline(2026, 7);
    const late = soarCellsFromAssessments(
      [assessment({ earliest_submission_date: '2026-12-31' })],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-07')!;
    expect(late.deadline).toBe(deadline);
    expect(late.onTime).toBe(false);
    expect(late.daysFromDeadline).toBeGreaterThan(0);

    const onTime = soarCellsFromAssessments(
      [assessment({ earliest_submission_date: '2026-08-01' })],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-07')!;
    expect(onTime.onTime).toBe(true);
  });

  it('reports timeliness as unknown when no submission date was captured', () => {
    const cell = soarCellsFromAssessments(
      [assessment({ earliest_submission_date: null })],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-07')!;
    expect(cell.onTime).toBeNull();
    expect(cell.daysFromDeadline).toBeNull();
  });

  it('surfaces a CHA id it cannot map rather than dropping the hospital', () => {
    // A hospital missing from the grid reads as one that did not submit.
    const { cells, unmappedChaIds } = soarCellsFromAssessments(
      [assessment({ cha_id: 'EX-999' })],
      CHA_TO_DAG,
    );
    expect(cells.size).toBe(0);
    expect(unmappedChaIds).toEqual(['EX-999']);
  });

  it('carries the grouped missing fields through, labelled as the REDCap path labels them', () => {
    const cell = soarCellsFromAssessments(
      [
        assessment({
          complete: false,
          missing_field_groups: [
            { form: 'ntsv_cesarean_section', records: 9, fields: [{ field: 'age', label: "Patient's age" }] },
            { form: 'no_ntsv_csections', records: 1, fields: [{ field: 'self_report_nontsv', label: 'Attest' }] },
          ],
        }),
      ],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-07')!;
    expect(cell.missingFieldGroups).toEqual([
      { form: 'NTSV', records: 9, fields: [{ field: 'age', label: "Patient's age" }] },
      { form: 'No-NTSV attestation', records: 1, fields: [{ field: 'self_report_nontsv', label: 'Attest' }] },
    ]);
    // And no record identifiers can arrive by this route.
    expect(JSON.stringify(cell)).not.toContain('recordId');
  });

  it('carries CHA notes onto the cell', () => {
    const note = '1 NTSV record has a delivery date in the future — possible data-entry error.';
    const cell = soarCellsFromAssessments([assessment({ notes: [note] })], CHA_TO_DAG).cells.get(
      'example_hospital_a::2026-07',
    )!;
    expect(cell.notes).toEqual([note]);
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
    ).cells.get('example_hospital_a::2026-07')!;
    expect(cell.attestationOnly).toBe(true);
    expect(cell.dataComplete).toBe(true);
    expect(cell.noNtsv.nRows).toBe(1);
    expect(cell.ntsv.nRows).toBe(0);
  });

  it('carries an incomplete verdict onto the cell', () => {
    const cell = soarCellsFromAssessments(
      [assessment({ complete: false, records: { total: 4, complete: 1, attestation: 0 } })],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-07')!;
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

describe('nestCellsFromAssessments', () => {
  const nest = (over: Partial<ChaAssessment> = {}): ChaAssessment =>
    assessment({
      period: '2026-03',
      earliest_submission_date: '2026-04-05',
      records: { total: 3, complete: 3, attestation: 0 },
      forms: [
        { form: 'safe_sleep_audit', total: 2, complete: 2 },
        { form: 'chart_reviews', total: 1, complete: 1 },
      ],
      ...over,
    });

  it('builds the per-form rollups the NEST sync decides from', () => {
    const cell = nestCellsFromAssessments([nest()], CHA_TO_DAG).cells.get('example_hospital_a::2026-03')!;
    expect(cell.bothSubmitted).toBe(true);
    expect(cell.dataComplete).toBe(true);
    expect([cell.ssp.nRows, cell.ssp.nComplete, cell.chart.nRows, cell.chart.nComplete]).toEqual([2, 2, 1, 1]);
    expect(cell.deadline).toBe(nestMonthDeadline(2026, 3));
    expect(cell.onTime).toBe(true);
  });

  it('knows when only one form arrived', () => {
    const cell = nestCellsFromAssessments(
      [
        nest({
          complete: false,
          forms: [
            { form: 'safe_sleep_audit', total: 2, complete: 2 },
            { form: 'chart_reviews', total: 0, complete: 0 },
          ],
        }),
      ],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-03')!;
    expect(cell.ssp.submitted).toBe(true);
    expect(cell.chart.submitted).toBe(false);
    expect(cell.bothSubmitted).toBe(false);
    expect(cell.dataComplete).toBe(false);
  });

  it('labels missing-field groups as the REDCap path does, and carries notes', () => {
    const cell = nestCellsFromAssessments(
      [
        nest({
          complete: false,
          missing_field_groups: [
            { form: 'chart_reviews', records: 1, fields: [{ field: 'language', label: 'Primary language' }] },
            { form: 'safe_sleep_audit', records: 2, fields: [{ field: 'compliant_ssp', label: 'Compliant' }] },
          ],
          notes: ['1 record has a data-entry date that is not a valid date — timeliness may be affected.'],
        }),
      ],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-03')!;
    expect(cell.missingFieldGroups!.map((g) => g.form)).toEqual(['Chart audit', 'Safe Sleep Practices']);
    expect(cell.notes).toHaveLength(1);
  });

  it('surfaces a CHA id it cannot map', () => {
    expect(nestCellsFromAssessments([nest({ cha_id: 'EX-999' })], CHA_TO_DAG).unmappedChaIds).toEqual(['EX-999']);
  });
});

describe('sparkCellsFromAssessments', () => {
  const spark = (over: Partial<ChaAssessment> = {}): ChaAssessment =>
    assessment({
      period: '2026-Q1',
      earliest_submission_date: '2026-04-07',
      records: { total: 1, complete: 1, attestation: 0 },
      fields_required: 56,
      ...over,
    });

  it('keys by quarter and judges timeliness here', () => {
    const cell = sparkCellsFromAssessments([spark()], CHA_TO_DAG).cells.get('example_hospital_a::2026-Q1')!;
    expect(cell.submitted && cell.complete).toBe(true);
    expect(cell.submissionDate).toBe('2026-04-07');
    expect(cell.onTime).toBe(true); // Q1 deadline 2026-04-10
    expect(cell.pctComplete).toBe(100);
    expect(cell.duplicateRecords).toBe(false);
  });

  it('computes percent-complete exactly as the REDCap path does', () => {
    // A row missing three of its 56 fields, judged both ways.
    const row: RedcapRow = {};
    for (const f of ALWAYS_REQUIRED) row[f] = '10';
    row['ipv_screen_implemented'] = '2';
    for (const f of ['denom_total', 'ssdoh_total', 'pmhc_total']) delete row[f];
    const direct = checkCompleteness(row);
    const cell = sparkCellsFromAssessments(
      [
        spark({
          complete: false,
          missing_field_groups: [
            {
              form: 'quarterly_measures',
              records: 1,
              fields: ['denom_total', 'ssdoh_total', 'pmhc_total'].map((f) => ({ field: f, label: f })),
            },
          ],
        }),
      ],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-Q1')!;
    expect(cell.pctComplete).toBe(direct.pct);
    expect(cell.missing).toEqual(direct.missing);
  });

  it('knows IPV screening from the required count', () => {
    const cell = sparkCellsFromAssessments([spark({ fields_required: 74 })], CHA_TO_DAG).cells.get(
      'example_hospital_a::2026-Q1',
    )!;
    expect(cell.ipvScreened).toBe(true);
  });

  it('carries competing records as a count, never identifiers', () => {
    const cell = sparkCellsFromAssessments(
      [spark({ records: { total: 3, complete: 1, attestation: 0 } })],
      CHA_TO_DAG,
    ).cells.get('example_hospital_a::2026-Q1')!;
    expect(cell.duplicateRecords).toBe(true);
    expect(competingRecordCount(cell)).toBe(3);
    expect(cell.dataRecordIds).toEqual([]);
    expect(cell.primaryRecordId).toBeNull();
  });

  it('ignores a period that is not a quarter', () => {
    expect(sparkCellsFromAssessments([spark({ period: '2026-07' })], CHA_TO_DAG).cells.size).toBe(0);
  });
});
