import { describe, expect, it } from 'vitest';
import { planReminders, type ReminderInput } from './reminder-plan.js';
import { reminderEmail } from './enrollment-emails.js';

const hospitals = [
  { id: 'h-ex-001', name: 'Example Valley Hospital' },
  { id: 'h-ex-002', name: 'Sample Hospital 01' },
  { id: 'h-ex-003', name: 'Sample Hospital 03' },
  { id: 'h-ex-004', name: 'Example Central' },
  { id: 'h-ex-005', name: 'Example North' },
];
const sent = (hospitalId: string, code: string, toEmail: string, toName: string, emailSent = true) => ({
  hospitalId,
  code,
  toEmail,
  toName,
  emailSent,
  sentAt: '2026-11-05T17:00:00.000Z',
});

const input = (over: Partial<ReminderInput> = {}): ReminderInput => ({
  outstanding: [
    { hospitalId: 'h-ex-001', hospitalName: 'Example Valley Hospital', code: 'NEST' },
    { hospitalId: 'h-ex-001', hospitalName: 'Example Valley Hospital', code: 'SPARK' },
    { hospitalId: 'h-ex-002', hospitalName: 'Sample Hospital 01', code: 'SOAR' },
    { hospitalId: 'h-ex-002', hospitalName: 'Sample Hospital 01', code: 'TTT' },
    { hospitalId: 'h-ex-003', hospitalName: 'Sample Hospital 03', code: 'SOAR' },
    { hospitalId: 'h-ex-004', hospitalName: 'Example Central', code: 'TTT' },
    { hospitalId: 'h-ex-005', hospitalName: 'Example North', code: 'TTT' },
  ],
  sent: [
    sent('h-ex-001', 'SPARK', 'jordan@example.test', 'Jordan Lee'),
    sent('h-ex-001', 'NEST', 'jordan@example.test', 'Jordan Lee'),
    sent('h-ex-002', 'SOAR', 'avery@example.test', 'Avery Kim'),
    sent('h-ex-002', 'SOAR', 'blake@example.test', 'Blake Ortiz'),
    sent('h-ex-002', 'TTT', 'riley@example.test', 'Riley Chen'),
    // The welcome email to this one failed, so there is no one to remind.
    sent('h-ex-003', 'SOAR', 'typo@example', 'Pat Typo', false),
    sent('h-ex-004', 'TTT', 'morgan@example.test', 'Morgan Hale'),
    sent('h-ex-005', 'TTT', 'morgan@example.test', 'Morgan Hale'),
  ],
  reminded: [],
  hospitals,
  sharedRoster: { 'Example North': 'Example Central' },
  today: '2026-11-12',
  ...over,
});

describe('planReminders', () => {
  it('reminds everyone a form reached, one email per hospital per set of people', () => {
    const plan = planReminders(input());
    expect(plan.emails.map((e) => [e.hospitals.map((h) => h.name), e.recipients.map((r) => r.email), e.links.map((l) => l.code)])).toEqual([
      [['Example Central', 'Example North'], ['morgan@example.test'], ['TTT', 'TTT']],
      [['Example Valley Hospital'], ['jordan@example.test'], ['SPARK', 'NEST']],
      [['Sample Hospital 01'], ['avery@example.test', 'blake@example.test'], ['SOAR']],
      [['Sample Hospital 01'], ['riley@example.test'], ['TTT']],
    ]);
  });

  it('holds a form no email ever reached', () => {
    expect(planReminders(input()).held).toEqual([
      expect.objectContaining({ hospital: 'Sample Hospital 03', initiative: 'SOAR' }),
    ]);
  });

  it("skips what was reminded today and shows when the rest were last reminded", () => {
    const plan = planReminders(
      input({
        reminded: [
          { hospitalId: 'h-ex-001', code: 'SPARK', sentAt: '2026-11-12' },
          { hospitalId: 'h-ex-001', code: 'NEST', sentAt: '2026-11-12' },
          { hospitalId: 'h-ex-002', code: 'SOAR', sentAt: '2026-11-09' },
        ],
      }),
    );
    expect(plan.skipped.map((s) => [s.hospital, s.initiative])).toEqual([
      ['Example Valley Hospital', 'SPARK'],
      ['Example Valley Hospital', 'NEST'],
    ]);
    expect(plan.emails.find((e) => e.links[0]!.code === 'SOAR')!.lastReminded).toBe('2026-11-09');
  });

  it("names only the hospitals still owing a form when a shared roster's other site has filed", () => {
    const plan = planReminders(
      input({ outstanding: [{ hospitalId: 'h-ex-005', hospitalName: 'Example North', code: 'TTT' }] }),
    );
    expect(plan.emails.map((e) => e.hospitals.map((h) => h.name))).toEqual([['Example North']]);
  });
});

describe('reminderEmail', () => {
  const link = (code: 'SPARK' | 'NEST' | 'TTT', hospitalName = 'Example Valley Hospital') => ({
    code,
    hospitalName,
    url: `https://qi.example.org/enrollment/2027?hospital=h-ex-001&initiative=${code}`,
  });

  it("reminds a submitter of each form still owed, by name", () => {
    const { subject, body, html } = reminderEmail({
      recipientName: 'Jordan Lee',
      programYear: 2027,
      links: [link('SPARK'), link('NEST')],
      closesAt: '2026-12-01',
    });
    expect(subject).toBe('Reminder: Example Valley Hospital 2027 enrollment forms due December 1, 2026');
    expect(body).toContain('Hi Jordan Lee,');
    expect(body).toContain(
      'Example Valley Hospital has not yet submitted the 2027 SPARK and NEST enrollment forms. ' +
        'Enrollment forms must be submitted by December 1, 2026 to meet Colorado law.',
    );
    expect(html).toContain('>SPARK Enrollment Form</a>');
    expect(html).toContain('>NEST Enrollment Form</a>');
  });

  it("greets a team, and writes out Turning the Tide", () => {
    const { subject, body } = reminderEmail({
      recipientName: 'everyone',
      programYear: 2027,
      forTeam: true,
      links: [link('TTT')],
      closesAt: '2026-12-01',
    });
    expect(subject).toBe('Reminder: Example Valley Hospital 2027 enrollment form due December 1, 2026');
    expect(body).toContain('Hi Example Valley Hospital Turning the Tide champions,');
    expect(body).toContain('has not yet submitted its 2027 Turning the Tide enrollment form.');
    expect(body).toContain('Submitting it is still required by Colorado law.');
    expect(body).not.toMatch(/TtT/);
  });
});
