import { describe, expect, it } from 'vitest';
import {
  caveatsForGroup,
  describePeriod,
  expandPeriod,
  rank,
  scopeCaveats,
  toGroup,
  type MetricsGroup,
  type RawGroup,
} from './metrics-query.js';
import { pct, toMetrics, EMPTY_TALLY, type Tally } from '../reports/engagement-metrics.js';

const raw = (over: Partial<RawGroup> = {}): RawGroup => ({
  group: '2026-05',
  taskType: 'data_submission',
  expected: 24,
  engaged: 15,
  late: 0,
  completeNoOutcome: 0,
  unfinalized: 0,
  hospitals: 24,
  ...over,
});

describe('expandPeriod', () => {
  it('matches a quarter label and its three months, because cadence varies by cohort', () => {
    expect(expandPeriod(2026, { kind: 'quarter', quarter: 3 })).toEqual([
      '2026-Q3',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
  });

  it('does not fold a quarterly task into a single month', () => {
    // A quarterly submission is not evidence about July specifically; including
    // it would invent detail the data does not have.
    expect(expandPeriod(2026, { kind: 'month', month: 7 })).toEqual(['2026-07']);
  });

  it('matches the annual label only for a whole-year query', () => {
    expect(expandPeriod(2026, { kind: 'year' })).toContain('2026-annual');
    expect(expandPeriod(2026, { kind: 'quarter', quarter: 4 })).not.toContain('2026-annual');
  });

  it('covers every shape in a year query', () => {
    const all = expandPeriod(2026, undefined);
    expect(all).toHaveLength(17); // annual + 4 quarters + 12 months
    expect(all).toContain('2026-Q1');
    expect(all).toContain('2026-12');
  });

  it('builds an inclusive month range', () => {
    expect(expandPeriod(2026, { kind: 'months', from: 5, to: 7 })).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });
});

describe('describePeriod', () => {
  it('names periods the way staff would write them', () => {
    expect(describePeriod(2026, { kind: 'quarter', quarter: 2 })).toBe('Q2 2026');
    expect(describePeriod(2026, { kind: 'month', month: 7 })).toBe('July 2026');
    expect(describePeriod(2026, undefined)).toBe('2026');
  });
});

describe('rate arithmetic matches the grant report', () => {
  it('excludes late from the reported rate', () => {
    const g = toGroup(raw({ expected: 100, engaged: 90, late: 10 }), 'task');
    expect(g.timely).toBe(80);
    expect(g.rate).toBe(80);
    expect(g.rateInclLate).toBe(90);
  });

  it('produces the same number as toMetrics for the same tally', () => {
    // The assistant and the grant report must never disagree about a rate.
    const t: Tally = { expected: 390, engaged: 346, late: 17 };
    const fromReport = toMetrics((tt) => (tt === 'data_submission' ? t : EMPTY_TALLY)).find(
      (m) => m.key === 'dataSubmission',
    );
    const fromAssistant = toGroup(raw({ ...t, taskType: 'data_submission' }), 'task');
    expect(fromAssistant.rate).toBe(fromReport?.rate);
    expect(fromAssistant.timely).toBe(fromReport?.timely);
  });

  it('reports no rate rather than zero when nothing is expected', () => {
    const g = toGroup(raw({ expected: 0, engaged: 0, hospitals: 0 }), 'task');
    expect(g.rate).toBeNull();
    expect(pct(0, 0)).toBeNull();
  });
});

describe('caveatsForGroup', () => {
  it('flags a period whose completions have no recorded outcome as an upper bound', () => {
    // The trap that makes Jan-Apr 2026 look perfect next to May onwards.
    const c = caveatsForGroup(raw({ engaged: 24, completeNoOutcome: 21 }), 'task');
    expect(c.map((x) => x.code)).toContain('outcome_backfill');
    expect(c.find((x) => x.code === 'outcome_backfill')?.severity).toBe('warning');
  });

  it('does not flag a period where every completion carries an outcome', () => {
    const c = caveatsForGroup(raw({ completeNoOutcome: 0 }), 'task');
    expect(c.map((x) => x.code)).not.toContain('outcome_backfill');
  });

  it('flags unfinalized tasks as provisional', () => {
    const c = caveatsForGroup(raw({ unfinalized: 5 }), 'task');
    expect(c.map((x) => x.code)).toContain('provisional');
  });

  it('flags a small denominator', () => {
    expect(caveatsForGroup(raw({ expected: 6 }), 'task').map((x) => x.code)).toContain(
      'small_denominator',
    );
  });

  it('says so when nothing was expected', () => {
    expect(caveatsForGroup(raw({ expected: 0 }), 'task').map((x) => x.code)).toContain('no_data');
  });

  it('notes the counting unit only for task-level answers', () => {
    expect(caveatsForGroup(raw(), 'task').map((x) => x.code)).toContain('unit_is_task');
    expect(caveatsForGroup(raw(), 'hospital').map((x) => x.code)).not.toContain('unit_is_task');
  });
});

describe('scopeCaveats', () => {
  const soar = [
    { label: '2026 SOAR Active Cohort', cadence: 'monthly', initiativeCode: 'SOAR' },
    { label: '2026 SOAR Sustainability Cohort', cadence: 'quarterly', initiativeCode: 'SOAR' },
  ];
  const someGroups = [toGroup(raw(), 'task')];

  it('warns when one initiative mixes cadences', () => {
    const c = scopeCaveats(soar, new Set(soar.map((x) => x.label)), someGroups);
    expect(c.map((x) => x.code)).toContain('mixed_cadence');
  });

  it('names the cohorts missing from the window rather than silently dropping them', () => {
    // "SOAR's Q2 rate" otherwise reports 16 hospitals as if it were all 30.
    const c = scopeCaveats(soar, new Set(['2026 SOAR Active Cohort']), someGroups);
    const partial = c.find((x) => x.code === 'partial_coverage');
    expect(partial).toBeDefined();
    expect(partial?.message).toContain('2026 SOAR Sustainability Cohort');
  });

  it('stays quiet when a single-cadence scope is fully covered', () => {
    const ttt = [{ label: '2026 TTT Cohort', cadence: 'monthly', initiativeCode: 'TTT' }];
    const c = scopeCaveats(ttt, new Set(['2026 TTT Cohort']), someGroups);
    expect(c).toHaveLength(0);
  });

  it('reports an empty result explicitly', () => {
    expect(scopeCaveats([], new Set(), []).map((x) => x.code)).toContain('no_data');
  });
});

describe('rank', () => {
  const g = (group: string, rate: number | null): MetricsGroup =>
    ({ ...toGroup(raw({ group }), 'task'), rate }) as MetricsGroup;

  it('ignores periods with no rate instead of ranking them as zero', () => {
    const r = rank([g('2026-05', 62.5), g('2026-09', null), g('2026-06', 75)]);
    expect(r.highest[0].group).toBe('2026-06');
    expect(r.lowest[0].group).toBe('2026-05');
    expect([...r.highest, ...r.lowest].map((x) => x.group)).not.toContain('2026-09');
  });
});
