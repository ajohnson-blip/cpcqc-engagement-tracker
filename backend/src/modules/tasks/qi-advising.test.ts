import { describe, expect, it } from 'vitest';
import {
  latestAims,
  latestNotesSession,
  nextSessionOn,
  qiAdvisingContentSchema,
  qiAdvisingPayloadSchema,
  qiYearSummary,
} from './qi-advising.js';
import { manageTaskBody } from './tasks.schemas.js';

const aim = (statement: string) => ({
  statement,
  tests: [{ change: 'Teach-back at discharge', stage: 'do' as const }],
});

describe('latestAims', () => {
  const tasks = [
    { period: '2026-Q1', payload: { aims: [aim('Q1 aim')] } },
    { period: '2026-Q2', payload: { aims: [aim('Q2 aim')] } },
    { period: '2026-Q3', payload: { progress: 'No aims recorded this time' } },
    { period: '2026-Q4', payload: null },
  ];

  it('finds the most recent session with aims', () => {
    expect(latestAims(tasks)).toEqual({ aims: [aim('Q2 aim')], period: '2026-Q2' });
  });

  it('carries forward from before a given session', () => {
    expect(latestAims(tasks, '2026-Q2')?.period).toBe('2026-Q1');
    expect(latestAims(tasks, '2026-Q1')).toBeNull();
  });
});

describe('nextSessionOn', () => {
  it('uses the most recent session that set one, while it is still ahead', () => {
    const tasks = [
      { period: '2026-Q3', payload: { nextSessionOn: '2026-12-02' } },
      { period: '2026-Q2', payload: { nextSessionOn: '2026-09-10' } },
    ];
    expect(nextSessionOn(tasks, '2026-10-29')).toBe('2026-12-02');
    expect(nextSessionOn(tasks, '2026-12-02')).toBe('2026-12-02');
    expect(nextSessionOn(tasks, '2026-12-03')).toBeNull();
  });

  it('ignores sessions that never set one', () => {
    expect(nextSessionOn([{ period: '2026-Q4', payload: {} }], '2026-10-29')).toBeNull();
  });
});

describe('latestNotesSession', () => {
  it('finds the most recent held session with notes', () => {
    const tasks = [
      { period: '2026-Q2', payload: { progress: 'Audits started', sessionDate: '2026-06-10' } },
      { period: '2026-Q3', payload: { priorities: 'Night shift huddles', sessionDate: '2026-09-09' } },
      { period: '2026-Q4', payload: { progress: '  ', aims: [aim('A')] } },
    ];
    expect(latestNotesSession(tasks)).toEqual({ period: '2026-Q3', sessionDate: '2026-09-09' });
    // Notes added ahead of the next call don't replace the last call's.
    const ahead = [...tasks, { period: '2027-Q1', status: 'not_started', payload: { challenges: 'Staffing' } }];
    expect(latestNotesSession(ahead)?.period).toBe('2026-Q3');
    // A session marked complete counts as held even without a date.
    expect(
      latestNotesSession([...tasks, { period: '2027-Q1', status: 'complete', payload: { notes: 'From upload' } }]),
    ).toEqual({ period: '2027-Q1', sessionDate: null });
    expect(latestNotesSession([{ period: '2026-Q4', payload: { challenges: 'Staffing' } }])).toEqual({
      period: '2026-Q4',
      sessionDate: null,
    });
    expect(latestNotesSession([{ period: '2026-Q1', payload: null }])).toBeNull();
  });

  it('passes over a 1:1 the team missed', () => {
    const tasks = [
      { period: '2026-Q2', status: 'complete', outcome: 'attended', payload: { progress: 'Audits started' } },
      { period: '2026-Q3', status: 'complete', outcome: 'missed', payload: { challenges: 'Added before the call' } },
    ];
    expect(latestNotesSession(tasks)?.period).toBe('2026-Q2');
  });
});

describe('qiYearSummary', () => {
  const tasks = [
    { period: '2025-Q4', status: 'complete', outcome: 'attended', payload: { progress: 'Last year' } },
    {
      period: '2026-Q1',
      status: 'complete',
      outcome: 'attended',
      payload: {
        sessionDate: '2026-03-12',
        advisorName: 'Alex Rivera',
        attendees: ['Jordan Lee'],
        progress: 'Policy updated',
        challenges: ' ',
        aims: [aim('First aim')],
      },
    },
    { period: '2026-Q2', status: 'complete', outcome: 'missed', payload: { nextSessionOn: '2026-09-09' } },
    {
      period: '2026-Q3',
      status: 'complete',
      outcome: 'attended',
      payload: {
        sessionDate: '2026-09-09',
        aims: [
          { ...aim('Finished last year'), completedOn: '2025-11-20' },
          { ...aim('First aim'), completedOn: '2026-09-09' },
          aim('Second aim'),
        ],
      },
    },
    { period: '2026-Q4', status: 'not_started', outcome: null, payload: null },
  ];

  it("lists the year's 1:1s oldest first, with attendance and notes", () => {
    const s = qiYearSummary(tasks, 2026);
    expect(s.sessions.map((x) => [x.period, x.attendance])).toEqual([
      ['2026-Q1', 'attended'],
      ['2026-Q2', 'missed'],
      ['2026-Q3', 'attended'],
      ['2026-Q4', 'not_recorded'],
    ]);
    expect(s.sessions[0]).toMatchObject({
      sessionDate: '2026-03-12',
      advisorName: 'Alex Rivera',
      attendees: ['Jordan Lee'],
      notes: [{ label: 'Progress and successes', text: 'Policy updated' }],
    });
  });

  it("takes the plan from the year's last session with aims, without aims finished in earlier years", () => {
    const s = qiYearSummary(tasks, 2026);
    expect(s.aimsAsOf).toBe('2026-Q3');
    expect(s.aims.map((a) => a.statement)).toEqual(['First aim', 'Second aim']);
    expect(qiYearSummary(tasks, 2027)).toEqual({ year: 2027, sessions: [], aims: [], aimsAsOf: null });
  });
});

describe('the 1:1 schemas', () => {
  it('allows five open aims, with completed ones not counting', () => {
    const open = (n: number) => Array.from({ length: n }, (_, i) => aim(`Aim ${i + 1}`));
    const done = { ...aim('Done'), completedOn: '2026-09-09' };
    expect(qiAdvisingContentSchema.safeParse({ aims: open(5) }).success).toBe(true);
    expect(qiAdvisingContentSchema.safeParse({ aims: open(6) }).success).toBe(false);
    expect(qiAdvisingContentSchema.safeParse({ aims: [...open(5), done, done] }).success).toBe(true);
  });

  it('keeps the date an aim was completed', () => {
    const parsed = qiAdvisingContentSchema.parse({ aims: [{ ...aim('A'), completedOn: '2026-09-09' }] });
    expect(parsed.aims?.[0]?.completedOn).toBe('2026-09-09');
    expect(
      qiAdvisingContentSchema.safeParse({ aims: [{ ...aim('A'), completedOn: 'September' }] }).success,
    ).toBe(false);
  });

  it('needs a statement and a change for every test', () => {
    expect(qiAdvisingContentSchema.safeParse({ aims: [{ statement: ' ', tests: [] }] }).success).toBe(false);
    expect(
      qiAdvisingContentSchema.safeParse({
        aims: [{ statement: 'A', tests: [{ change: '', stage: 'plan' }] }],
      }).success,
    ).toBe(false);
  });

  it('lets staff clear the next 1:1 date with null', () => {
    expect(qiAdvisingPayloadSchema.parse({ nextSessionOn: null }).nextSessionOn).toBeNull();
  });

  it('keeps a 1:1 payload intact through the manage body', () => {
    // A union of the per-type schemas used to strip this to {}.
    const body = manageTaskBody.parse({
      status: 'complete',
      outcome: 'attended',
      payload: { sessionDate: '2026-10-01', advisorName: 'Pat Example', progress: 'Started audits' },
    });
    expect(qiAdvisingPayloadSchema.parse(body.payload)).toEqual({
      sessionDate: '2026-10-01',
      advisorName: 'Pat Example',
      progress: 'Started audits',
    });
  });
});
