import { describe, expect, it } from 'vitest';
import {
  ALWAYS_REQUIRED,
  ALL_DATA_FIELDS,
  IPV_CONDITIONAL_FIELDS,
  DEADLINES,
  secondFriday,
  eventToQuarter,
  determineQuarter,
  checkCompleteness,
  checkTimeliness,
  rowHasData,
  buildSparkGrid,
  type RedcapRow,
} from './spark-engagement.js';

describe('field definitions', () => {
  it('has 56 always-required and 74 total data fields', () => {
    expect(ALWAYS_REQUIRED).toHaveLength(56);
    expect(IPV_CONDITIONAL_FIELDS).toHaveLength(18);
    expect(ALL_DATA_FIELDS).toHaveLength(74);
  });
});

describe('secondFriday / DEADLINES', () => {
  // Deadlines from Luis's methodology table.
  it('matches the published deadline schedule', () => {
    expect(DEADLINES['2025-Q4']!.deadline).toBe('2026-01-09');
    expect(DEADLINES['2026-Q1']!.deadline).toBe('2026-04-10');
    expect(DEADLINES['2026-Q2']!.deadline).toBe('2026-07-10');
    expect(DEADLINES['2026-Q3']!.deadline).toBe('2026-10-09');
    expect(DEADLINES['2026-Q4']!.deadline).toBe('2027-01-08');
  });

  it('computes the 2nd Friday directly', () => {
    expect(secondFriday(2026, 4)).toBe('2026-04-10');
    expect(secondFriday(2026, 1)).toBe('2026-01-09');
  });

  it('has correct quarter period bounds', () => {
    expect(DEADLINES['2026-Q1']!.periodStart).toBe('2026-01-01');
    expect(DEADLINES['2026-Q1']!.periodEnd).toBe('2026-03-31');
    expect(DEADLINES['2026-Q2']!.periodEnd).toBe('2026-06-30');
  });
});

describe('eventToQuarter', () => {
  it('maps the confirmed event slugs', () => {
    expect(eventToQuarter('julysept_25_data_p_arm_1')).toBe('2025-Q3');
    expect(eventToQuarter('octdec_25_data_arm_1')).toBe('2025-Q4');
    expect(eventToQuarter('janmar_26_data_arm_1')).toBe('2026-Q1');
  });

  it('parses future data events by month-range slug', () => {
    expect(eventToQuarter('aprjun_26_data_arm_1')).toBe('2026-Q2');
    expect(eventToQuarter('octdec_26_data_arm_1')).toBe('2026-Q4');
  });

  it('returns null for non-data (assessment) events', () => {
    expect(eventToQuarter('baseline_assessmen_arm_1')).toBeNull();
    expect(eventToQuarter('self_assessment__t_arm_1')).toBeNull();
    expect(eventToQuarter('')).toBeNull();
    expect(eventToQuarter(undefined)).toBeNull();
  });
});

describe('determineQuarter (date → quarter)', () => {
  it('matches the reference examples', () => {
    expect(determineQuarter('2026-04-07')).toBe('2026-Q1'); // after Mar 31
    expect(determineQuarter('2026-06-02')).toBe('2026-Q1'); // still after Mar 31
    expect(determineQuarter('2026-07-15')).toBe('2026-Q2'); // after Jun 30
    expect(determineQuarter('')).toBeNull();
  });
});

describe('checkCompleteness', () => {
  it('is complete when all 56 always-required are filled and IPV gate != 1', () => {
    const row: RedcapRow = {};
    for (const f of ALWAYS_REQUIRED) row[f] = '10';
    row['ipv_screen_implemented'] = '2'; // No → IPV disaggregation not required
    const r = checkCompleteness(row);
    expect(r.complete).toBe(true);
    expect(r.pct).toBe(100);
    expect(r.ipvScreened).toBe(false);
    expect(r.missing.total).toBe(0);
  });

  it('requires the 18 IPV fields when the gate == 1', () => {
    const row: RedcapRow = {};
    for (const f of ALWAYS_REQUIRED) row[f] = '10';
    row['ipv_screen_implemented'] = '1'; // Yes → 18 more required
    const r = checkCompleteness(row);
    expect(r.complete).toBe(false);
    expect(r.ipvScreened).toBe(true);
    expect(r.missing.total).toBe(18);
    expect(r.missing.ipv).toHaveLength(18);
  });

  it('buckets missing fields by section', () => {
    const row: RedcapRow = {};
    for (const f of ALWAYS_REQUIRED) row[f] = '10';
    row['ipv_screen_implemented'] = '2';
    delete row['denom_total'];
    delete row['ssdoh_total'];
    const r = checkCompleteness(row);
    expect(r.complete).toBe(false);
    expect(r.missing.denom).toContain('denom_total');
    expect(r.missing.ssdoh).toContain('ssdoh_total');
    expect(r.missing.total).toBe(2);
  });
});

describe('checkTimeliness', () => {
  it('matches the reference examples for Q1 2026 (deadline 2026-04-10)', () => {
    expect(checkTimeliness('2026-04-07', '2026-Q1')).toEqual({ onTime: true, daysFromDeadline: -3 });
    expect(checkTimeliness('2026-04-10', '2026-Q1')).toEqual({ onTime: true, daysFromDeadline: 0 });
    expect(checkTimeliness('2026-06-02', '2026-Q1')).toEqual({ onTime: false, daysFromDeadline: 53 });
  });

  it('returns N/A when there is no date', () => {
    expect(checkTimeliness('', '2026-Q1')).toEqual({ onTime: null, daysFromDeadline: null });
    expect(checkTimeliness(null, '2026-Q1')).toEqual({ onTime: null, daysFromDeadline: null });
  });
});

describe('rowHasData', () => {
  it('detects empty placeholder rows', () => {
    expect(rowHasData({ denom_total: '', ssdoh_total: '' })).toBe(false);
    expect(rowHasData({ denom_total: '5' })).toBe(true);
  });
});

describe('buildSparkGrid', () => {
  function fullRow(extra: RedcapRow): RedcapRow {
    const row: RedcapRow = {};
    for (const f of ALWAYS_REQUIRED) row[f] = '10';
    row['ipv_screen_implemented'] = '2';
    return { ...row, ...extra };
  }

  it('collapses one submitted, complete, on-time row into a counting cell', () => {
    const rows: RedcapRow[] = [
      fullRow({
        record_id: '174336-1',
        redcap_event_name: 'janmar_26_data_arm_1',
        redcap_data_access_group: 'adventhealth_avist',
        date: '2026-04-07',
      }),
    ];
    const grid = buildSparkGrid(rows);
    const cell = grid.get('adventhealth_avist::2026-Q1')!;
    expect(cell.submitted).toBe(true);
    expect(cell.complete).toBe(true);
    expect(cell.onTime).toBe(true);
    expect(cell.duplicateRecords).toBe(false);
    expect(cell.submissionDate).toBe('2026-04-07');
  });

  it('ignores the REDCap test DAG and assessment events', () => {
    const rows: RedcapRow[] = [
      fullRow({ record_id: '1', redcap_event_name: 'janmar_26_data_arm_1', redcap_data_access_group: 'test', date: '2026-04-07' }),
      fullRow({ record_id: '2', redcap_event_name: 'baseline_assessmen_arm_1', redcap_data_access_group: 'mercy_hospital', date: '2026-04-07' }),
    ];
    expect(buildSparkGrid(rows).size).toBe(0);
  });

  it('flags multiple competing records and prefers the latest dated row', () => {
    const rows: RedcapRow[] = [
      // Earlier dated row (incomplete: missing denom_total)
      fullRow({
        record_id: '174263-1',
        redcap_event_name: 'janmar_26_data_arm_1',
        redcap_data_access_group: 'east_morgan_county',
        date: '2026-04-01',
        denom_total: '',
      }),
      // Later dated row, complete → should win
      fullRow({
        record_id: '174263-2',
        redcap_event_name: 'janmar_26_data_arm_1',
        redcap_data_access_group: 'east_morgan_county',
        date: '2026-06-02',
      }),
    ];
    const cell = buildSparkGrid(rows).get('east_morgan_county::2026-Q1')!;
    expect(cell.primaryRecordId).toBe('174263-2');
    expect(cell.duplicateRecords).toBe(true);
    expect(cell.dataRecordIds.sort()).toEqual(['174263-1', '174263-2']);
    expect(cell.complete).toBe(true);
    expect(cell.onTime).toBe(false); // 2026-06-02 is past the 2026-04-10 deadline
  });

  it('falls back to the most-complete row when no row has a date', () => {
    const rows: RedcapRow[] = [
      fullRow({ record_id: 'a', redcap_event_name: 'octdec_25_data_arm_1', redcap_data_access_group: 'mercy_hospital', denom_total: '' }),
      fullRow({ record_id: 'a', redcap_event_name: 'octdec_25_data_arm_1', redcap_data_access_group: 'mercy_hospital' }),
    ];
    const cell = buildSparkGrid(rows).get('mercy_hospital::2025-Q4')!;
    expect(cell.submitted).toBe(true);
    expect(cell.complete).toBe(true);
    expect(cell.onTime).toBeNull(); // no @TODAY date → timeliness N/A
    expect(cell.submissionDate).toBeNull();
  });
});
