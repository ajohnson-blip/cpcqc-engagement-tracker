import { describe, expect, it } from 'vitest';
import {
  interestFormAcceptances,
  parseAcceptanceSheet,
  planWelcomeEmails,
  type PlanInput,
} from './welcome-plan.js';

// The Board tab's shape: summary rows, then the header row, then hospitals.
const SHEET = [
  ['2027 enrollment decisions', '', '', 'Yellow cells are decisions'],
  ['Initiative', 'SPARK', 'SOAR', 'NEST', 'TtT'],
  [],
  ['Hospital', 'Form', 'Initiatives wanted', '#1 choice', '#2 choice', 'In TtT', 'In SOAR sustain', 'SPARK', 'SOAR', 'NEST', 'TtT'],
  ['Example Valley Hospital', 'Yes', '2', 'SPARK', 'NEST', 'Yes', 'No', 'Accept', '', 'Accept', 'Continuing'],
  ['Sample Hospital 01', 'No form', '', '', '', '', '', '', 'Accept', '', 'Continuing'],
  ['Sample Hospital 02', 'Yes', '2', 'NEST', 'SOAR', 'Yes', 'No', '', 'Waitlist', 'Accept', 'Withdrawing'],
  ['Example Central', 'No form', '', '', '', '', '', '', '', '', 'Continuing'],
  ['Example North', 'No form', '', '', '', '', '', '', '', '', 'Continuing'],
  ['Unknown Regional', 'Yes', '1', 'SPARK', '', '', '', 'Accept'],
  ['', '', '', '', '', '', '', '17', '16', '12', '23'],
];

describe('parseAcceptanceSheet', () => {
  it('finds the header row and reads each decision', () => {
    const rows = parseAcceptanceSheet(SHEET);
    expect(rows.map((r) => r.hospital)).toEqual([
      'Example Valley Hospital',
      'Sample Hospital 01',
      'Sample Hospital 02',
      'Example Central',
      'Example North',
      'Unknown Regional',
    ]);
    expect(rows[0]).toMatchObject({ rowNumber: 5, filedInterestForm: true, send: ['SPARK', 'NEST', 'TTT'] });
    expect(rows[1]).toMatchObject({ filedInterestForm: false, send: ['SOAR', 'TTT'] });
    expect(rows[2]).toMatchObject({
      send: ['NEST'],
      notSent: [
        { code: 'SOAR', decision: 'Waitlist' },
        { code: 'TTT', decision: 'Withdrawing' },
      ],
    });
  });

  it('refuses a sheet without the decision columns', () => {
    expect(() => parseAcceptanceSheet([['Hospital', 'SPARK', 'NEST']])).toThrow(/header row/);
  });
});

const hospitals = [
  { id: 'h-ex-001', name: 'Example Valley Hospital' },
  { id: 'h-ex-002', name: 'Sample Hospital 01' },
  { id: 'h-ex-003', name: 'Sample Hospital 02' },
  { id: 'h-ex-004', name: 'Example Central' },
  { id: 'h-ex-005', name: 'Example North' },
];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  sheet: parseAcceptanceSheet(SHEET),
  hospitals,
  interestForms: new Map([
    ['h-ex-001', { submitterName: 'Jordan Lee', submitterEmail: 'jordan@example.test' }],
    ['h-ex-003', { submitterName: 'Sam Patel', submitterEmail: 'sam@example.test' }],
  ]),
  roster: [
    { hospitalId: 'h-ex-002', initiativeCode: 'SOAR', name: 'Avery Kim', email: 'avery@example.test' },
    { hospitalId: 'h-ex-002', initiativeCode: 'SOAR', name: 'Blake Ortiz', email: 'blake@example.test' },
    { hospitalId: 'h-ex-002', initiativeCode: 'SOAR', name: 'Avery Kim (again)', email: 'AVERY@example.test' },
    { hospitalId: 'h-ex-002', initiativeCode: 'SOAR', name: 'No Address', email: null },
    { hospitalId: 'h-ex-002', initiativeCode: 'TTT', name: 'Riley Chen', email: 'riley@example.test' },
    // Example Valley's own roster is ignored: it filed an interest form.
    { hospitalId: 'h-ex-001', initiativeCode: 'SPARK', name: 'Casey Ng', email: 'casey@example.test' },
    { hospitalId: 'h-ex-004', initiativeCode: 'TTT', name: 'Morgan Hale', email: 'morgan@example.test' },
    { hospitalId: 'h-ex-004', initiativeCode: 'TTT', name: 'Quinn Ross', email: 'quinn@example.test' },
  ],
  filed: new Set(),
  sent: new Map(),
  sharedRoster: { 'Example North': 'Example Central' },
  ...over,
});

describe('planWelcomeEmails', () => {
  it('sends a hospital with an interest form one email, to whoever filed it', () => {
    const plan = planWelcomeEmails(input());
    const mine = plan.emails.filter((e) => e.hospitals[0]!.id === 'h-ex-001');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      recipients: [{ name: 'Jordan Lee', email: 'jordan@example.test' }],
      source: 'Interest form',
      forTeam: false,
      accepted: ['SPARK', 'NEST', 'TTT'],
    });
    expect(mine[0]!.links.map((l) => l.code)).toEqual(['SPARK', 'NEST', 'TTT']);
  });

  it("sends a hospital without one each initiative's form, to that initiative's champions together", () => {
    const plan = planWelcomeEmails(input());
    const theirs = plan.emails.filter((e) => e.hospitals[0]!.id === 'h-ex-002');
    // One email per initiative; a duplicate address and a blank one drop out.
    expect(theirs.map((e) => [e.recipients.map((r) => r.email), e.source, e.links.map((l) => l.code)])).toEqual([
      [['avery@example.test', 'blake@example.test'], 'SOAR roster', ['SOAR']],
      [['riley@example.test'], 'TtT roster', ['TTT']],
    ]);
    // Each team hears everything the hospital was accepted into.
    expect(theirs.map((e) => [e.forTeam, e.accepted])).toEqual([
      [true, ['SOAR', 'TTT']],
      [true, ['SOAR', 'TTT']],
    ]);
  });

  it("gives a shared roster's champions both sites' links in one email", () => {
    const plan = planWelcomeEmails(input());
    const memorial = plan.emails.filter((e) => e.recipients.some((r) => r.email === 'morgan@example.test'));
    expect(memorial).toHaveLength(1);
    expect(memorial[0]!.recipients.map((r) => r.name)).toEqual(['Morgan Hale', 'Quinn Ross']);
    expect(memorial[0]!.hospitals.map((h) => h.name)).toEqual(['Example Central', 'Example North']);
    expect(memorial[0]!.links.map((l) => l.hospitalId)).toEqual(['h-ex-004', 'h-ex-005']);
  });

  it('skips what the sheet holds back or was already filed or sent, and holds what it cannot place', () => {
    const plan = planWelcomeEmails(
      input({
        filed: new Set(['h-ex-001:NEST']),
        sent: new Map([['h-ex-002:TTT', '2026-11-10']]),
      }),
    );
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { hospital: 'Sample Hospital 02', initiative: 'SOAR', reason: 'Marked Waitlist.' },
        { hospital: 'Sample Hospital 02', initiative: 'TTT', reason: 'Marked Withdrawing.' },
        { hospital: 'Example Valley Hospital', initiative: 'NEST', reason: 'Already submitted.' },
        { hospital: 'Sample Hospital 01', initiative: 'TTT', reason: 'Already sent on 2026-11-10.' },
      ]),
    );
    expect(plan.held).toEqual([
      { hospital: 'Unknown Regional', initiative: null, reason: 'Row 10: no hospital by this name in the tracker.' },
    ]);
    const jordan = plan.emails.find((e) => e.recipients[0]!.email === 'jordan@example.test');
    expect(jordan!.links.map((l) => l.code)).toEqual([
      'SPARK',
      'TTT',
    ]);
  });

  it('holds an initiative whose roster has no addresses rather than guessing', () => {
    const plan = planWelcomeEmails(input({ roster: [] }));
    expect(plan.held).toEqual(
      expect.arrayContaining([
        { hospital: 'Sample Hospital 01', initiative: 'SOAR', reason: 'No one with an email address on its SOAR roster.' },
        {
          hospital: 'Example North',
          initiative: 'TTT',
          reason: "No one with an email address on Example Central's TtT roster.",
        },
      ]),
    );
  });

  it('follows the sheet when it says No form, and says so', () => {
    const plan = planWelcomeEmails(
      input({
        interestForms: new Map([
          ['h-ex-002', { submitterName: 'Pat Doe', submitterEmail: 'pat@example.test' }],
        ]),
      }),
    );
    const theirs = plan.emails.filter((e) => e.hospitals[0]!.id === 'h-ex-002');
    expect(theirs.every((e) => e.source.endsWith('roster'))).toBe(true);
    expect(theirs[0]!.warning).toMatch(/interest form from Pat Doe/);
  });

  it('matches names whatever the apostrophes and spacing', () => {
    const plan = planWelcomeEmails(
      input({
        sheet: parseAcceptanceSheet([
          ['Hospital', 'Form', 'SPARK', 'SOAR', 'NEST', 'TtT'],
          ['St. Mary’s  Regional', 'No form', '', 'Accept'],
        ]),
        hospitals: [{ id: 'h-ex-009', name: "St. Mary's Regional" }],
        roster: [{ hospitalId: 'h-ex-009', initiativeCode: 'SOAR', name: 'Drew', email: 'drew@example.test' }],
      }),
    );
    expect(plan.emails.map((e) => e.recipients.map((r) => r.email))).toEqual([['drew@example.test']]);
  });
});

describe('interestFormAcceptances', () => {
  it("takes each interest-form hospital's SPARK, SOAR and NEST decisions from the sheet", () => {
    const filed = new Set(['h-ex-001', 'h-ex-002', 'h-ex-003']);
    const got = interestFormAcceptances(parseAcceptanceSheet(SHEET), hospitals, (id) => filed.has(id));
    expect([...got.entries()]).toEqual([
      ['h-ex-001', ['SPARK', 'NEST']],
      // Waitlisted SOAR and a TtT withdrawal leave only NEST.
      ['h-ex-003', ['NEST']],
    ]);
    // Sample Hospital 01 says No form, so its interest form, if any, is left alone.
    expect(got.has('h-ex-002')).toBe(false);
  });
});
