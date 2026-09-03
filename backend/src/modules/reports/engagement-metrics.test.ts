import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_METRICS,
  EMPTY_TALLY,
  engagementNarrative,
  pct,
  programLabel,
  statutorySentence,
  toMetrics,
  type EngagementSummary,
  type StatutoryCompliance,
  type Tally,
} from './engagement-metrics.js';

const tallies: Record<string, Tally> = {
  enrollment_form: { expected: 74, engaged: 74, late: 0 },
  readiness_assessment: { expected: 74, engaged: 72, late: 1 },
  qi_advising: { expected: 151, engaged: 144, late: 0 },
  meeting_attendance: { expected: 519, engaged: 453, late: 0 },
  data_submission: { expected: 390, engaged: 346, late: 17 },
};
const get = (tt: string) => tallies[tt] ?? EMPTY_TALLY;

const statutory: StatutoryCompliance = {
  hospitals: 49,
  engagedInAtLeastOne: 49,
  notEngaged: 0,
  compliantInAtLeastOne: 49,
  metInAtLeastOne: 3,
  atRiskInAll: 0,
  byInitiativeCount: [
    { initiatives: 1, hospitals: 32 },
    { initiatives: 2, hospitals: 12 },
    { initiatives: 3, hospitals: 2 },
    { initiatives: 4, hospitals: 3 },
  ],
};

function summary(): EngagementSummary {
  return {
    programYear: 2026,
    asOf: '2026-09-03',
    overall: {
      initiativeCode: null,
      initiativeName: null,
      hospitals: 60,
      metrics: toMetrics(get),
    },
    byInitiative: [
      { initiativeCode: 'NEST', initiativeName: 'NEST', hospitals: 9, metrics: [] },
      { initiativeCode: 'SOAR', initiativeName: 'SOAR', hospitals: 30, metrics: [] },
      { initiativeCode: 'SPARK', initiativeName: 'SPARK', hospitals: 11, metrics: [] },
      { initiativeCode: 'TTT', initiativeName: 'Turning the Tide', hospitals: 24, metrics: [] },
    ],
    statutory: { ...statutory },
  };
}

describe('pct', () => {
  it('reports one decimal place', () => {
    expect(pct(453, 519)).toBe(87.3);
    expect(pct(346, 390)).toBe(88.7);
  });
  it('returns null rather than dividing by zero', () => {
    // A program with nothing due yet must not read as 0% engagement.
    expect(pct(0, 0)).toBeNull();
  });
});

describe('toMetrics', () => {
  it('covers all five funder-facing metrics, in report order', () => {
    expect(toMetrics(get).map((m) => m.key)).toEqual([
      'enrollment',
      'survey',
      'coaching',
      'meetings',
      'dataSubmission',
    ]);
    expect(ENGAGEMENT_METRICS).toHaveLength(5);
  });

  it('reports timely-and-complete, excluding late arrivals', () => {
    const data = toMetrics(get).find((m) => m.key === 'dataSubmission')!;
    // 346 of 390 completed without being missed or not-submitted, but 17 of
    // those arrived late. A late submission is not "timely and complete", so
    // the reported rate counts the other 329.
    expect(data.engaged).toBe(346);
    expect(data.late).toBe(17);
    expect(data.timely).toBe(329);
    expect(data.rate).toBe(84.4);
    expect(data.rateInclLate).toBe(88.7);
  });

  it('leaves a metric with no late arrivals unchanged either way', () => {
    const m = toMetrics(get).find((x) => x.key === 'meetings')!;
    expect(m.rate).toBe(87.3);
    expect(m.rateInclLate).toBe(87.3);
  });

  it('treats a missing task type as nothing expected, not as zero engagement', () => {
    const m = toMetrics(() => EMPTY_TALLY);
    expect(m.every((x) => x.rate === null)).toBe(true);
  });
});

describe('programLabel', () => {
  it('spells out Turning the Tide, which is never written as TTT in prose', () => {
    expect(programLabel('TTT')).toBe('Turning the Tide');
    expect(programLabel('SOAR')).toBe('SOAR');
  });
});

describe('engagementNarrative', () => {
  it('produces the paragraph in the shape CPCQC reports to funders', () => {
    const text = engagementNarrative(summary());
    expect(text).toContain('five key hospital engagement metrics');
    expect(text).toContain('SB24-175');
    expect(text).toContain(
      'enrollment 100%, survey completion 95.9%, coaching 95.4%, ' +
        'meeting participation 87.3%, data submission 84.4%',
    );
  });

  it('lists the programs with an Oxford comma and the full TtT name', () => {
    expect(engagementNarrative(summary())).toContain(
      'in place for NEST, SOAR, SPARK, and Turning the Tide.',
    );
  });

  it('says n/a rather than inventing a rate when nothing is expected', () => {
    const s = summary();
    s.overall.metrics = toMetrics(() => EMPTY_TALLY);
    expect(engagementNarrative(s)).toContain('enrollment n/a');
  });

  it('reads naturally with a single program', () => {
    const s = summary();
    s.byInitiative = [
      { initiativeCode: 'SOAR', initiativeName: 'SOAR', hospitals: 30, metrics: [] },
    ];
    expect(engagementNarrative(s)).toContain('in place for SOAR.');
  });
});

describe('statutorySentence', () => {
  it('states full coverage plainly when every hospital is engaged', () => {
    const text = statutorySentence(statutory);
    expect(text).toContain('All 49 tracked hospitals (100%) are engaged in at least one');
    expect(text).toContain('SB24-175');
    expect(text).toContain('All are meeting or on track');
  });

  it('names the gap when hospitals are not enrolled in anything', () => {
    const text = statutorySentence({
      ...statutory,
      engagedInAtLeastOne: 47,
      notEngaged: 2,
      compliantInAtLeastOne: 45,
      atRiskInAll: 2,
    });
    expect(text).toContain('47 of 49 tracked hospitals (95.9%)');
    expect(text).toContain('2 are not currently enrolled in any');
    expect(text).toContain('2 are at risk across all of their initiatives');
  });

  it('uses a singular verb for a single hospital', () => {
    const text = statutorySentence({
      ...statutory,
      engagedInAtLeastOne: 48,
      notEngaged: 1,
      compliantInAtLeastOne: 47,
      atRiskInAll: 1,
    });
    expect(text).toContain('1 is not currently enrolled');
    expect(text).toContain('1 is at risk');
  });

  it('does not divide by zero on an empty roster', () => {
    expect(statutorySentence({ ...statutory, hospitals: 0 })).toBe(
      'No hospitals are currently tracked.',
    );
  });
});
