import { describe, expect, it } from 'vitest';
import { onboardingRecipients, planOnboarding, type OnboardingForm, type OnboardingPlanInput } from './onboarding-plan.js';
import { onboardingEmail, receiptEmail } from './enrollment-emails.js';

const form = (over: Partial<OnboardingForm> = {}): OnboardingForm => ({
  formId: 'f-ex-001-spark',
  hospitalId: 'h-ex-001',
  hospitalName: 'Example Valley Hospital',
  code: 'SPARK',
  submitterName: 'Jordan Lee',
  submitterEmail: 'jordan@example.test',
  champions: [
    { name: 'Jordan Lee', email: 'JORDAN@example.test' },
    { name: 'Casey Ng', email: 'casey@example.test' },
    { name: 'No Address', email: '' },
  ],
  ...over,
});

const ttt = form({
  formId: 'f-ex-002-ttt',
  hospitalId: 'h-ex-002',
  hospitalName: 'Sample Hospital 01',
  code: 'TTT',
  submitterName: 'Riley Chen',
  submitterEmail: 'riley@example.test',
  champions: [],
});

const send = (formId: string, version: number, emailSent: boolean, sentAt = '2026-11-18T17:00:00.000Z') => ({
  formId,
  version,
  emailSent,
  sentAt,
  sentDay: sentAt.slice(0, 10),
  toEmail: 'jordan@example.test',
});

const input = (over: Partial<OnboardingPlanInput> = {}): OnboardingPlanInput => ({
  forms: [form(), ttt, form({ formId: 'f-ex-003-nest', hospitalId: 'h-ex-003', hospitalName: 'Sample Hospital 03', code: 'NEST' })],
  roster: new Map([['h-ex-002:TTT', [{ name: 'Morgan Hale', email: 'morgan@example.test' }]]]),
  versions: { SPARK: 2, TTT: 1 },
  sends: [],
  includeUpdated: false,
  includeFailed: false,
  attemptedSince: null,
  ...over,
});

describe('onboardingRecipients', () => {
  it('is the submitter, then the champions the form names, once each', () => {
    expect(onboardingRecipients(form(), []).map((r) => r.email)).toEqual(['jordan@example.test', 'casey@example.test']);
  });

  it("uses the hospital's roster when the form names no champions", () => {
    expect(onboardingRecipients(ttt, [{ name: 'Morgan Hale', email: 'morgan@example.test' }])).toEqual([
      { name: 'Riley Chen', email: 'riley@example.test' },
      { name: 'Morgan Hale', email: 'morgan@example.test' },
    ]);
  });
});

describe('planOnboarding', () => {
  it('sends every submitted form whose initiative has details, and holds the rest', () => {
    const plan = planOnboarding(input());
    expect(plan.emails.map((e) => [e.hospital.name, e.code, e.kind, e.version])).toEqual([
      ['Example Valley Hospital', 'SPARK', 'new', 2],
      ['Sample Hospital 01', 'TTT', 'new', 1],
    ]);
    expect(plan.held).toEqual([
      { hospital: 'Sample Hospital 03', initiative: 'NEST', reason: 'No NEST onboarding details yet.' },
    ]);
  });

  it('skips a form already sent the current version', () => {
    const plan = planOnboarding(input({ sends: [send('f-ex-001-spark', 2, true)] }));
    expect(plan.emails.map((e) => e.code)).toEqual(['TTT']);
    expect(plan.skipped).toEqual([
      { hospital: 'Example Valley Hospital', initiative: 'SPARK', reason: 'Sent 2026-11-18.' },
    ]);
  });

  it('lists a form sent an earlier version, and sends it as an update only when asked', () => {
    const sends = [send('f-ex-001-spark', 1, true)];
    const plan = planOnboarding(input({ sends }));
    expect(plan.emails.map((e) => e.code)).toEqual(['TTT']);
    expect(plan.updated.map((n) => n.hospital)).toEqual(['Example Valley Hospital']);

    const withUpdates = planOnboarding(input({ sends, includeUpdated: true }));
    expect(withUpdates.emails[0]).toMatchObject({ code: 'SPARK', kind: 'update', update: true, version: 2 });
  });

  it("lists a send that didn't go through, and retries it only when asked", () => {
    const sends = [send('f-ex-001-spark', 2, false)];
    expect(planOnboarding(input({ sends })).failed).toEqual([
      expect.objectContaining({ hospital: 'Example Valley Hospital', initiative: 'SPARK' }),
    ]);
    const retry = planOnboarding(input({ sends, includeFailed: true }));
    expect(retry.emails[0]).toMatchObject({ code: 'SPARK', kind: 'retry', update: false });
  });

  it('leaves out anything attempted in this run, so batches never repeat a form', () => {
    const plan = planOnboarding(
      input({
        sends: [send('f-ex-001-spark', 2, false, '2026-11-18T18:00:05.000Z')],
        includeFailed: true,
        attemptedSince: '2026-11-18T18:00:00.000Z',
      }),
    );
    expect(plan.emails.map((e) => e.code)).toEqual(['TTT']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['Sent in this run.']);
  });
});

const onboarding = {
  sessions: [
    { title: 'Onboarding webinar', when: 'Tuesday, January 12, 2027, 12–1 pm MT', registrationUrl: 'https://example.test/register' },
    { title: 'Data training', when: 'January 20, 2027', registrationUrl: null },
  ],
  note: 'Slides will be posted at https://example.test/slides.\n\nBring your data champion.',
};

describe('onboardingEmail', () => {
  it('greets the team, lists each date with a named registration link, and keeps the note', () => {
    const { subject, body, html } = onboardingEmail({
      recipientName: null,
      forTeam: true,
      hospitalName: 'Example Valley Hospital',
      initiativeCode: 'TTT',
      programYear: 2027,
      onboarding,
    });
    expect(subject).toBe('Turning the Tide 2027 onboarding dates and registration — Example Valley Hospital');
    expect(body).toContain('Hi Example Valley Hospital Turning the Tide team,');
    expect(body).toContain('Onboarding webinar: Tuesday, January 12, 2027, 12–1 pm MT\nhttps://example.test/register');
    expect(body).toContain('Data training: January 20, 2027');
    expect(body).toContain('Bring your data champion.');
    expect(html).toContain('>Register for Onboarding webinar</a>');
    expect(html).toContain('href="https://example.test/slides"');
    expect(html).not.toContain('slides.</a>');
    expect(body).not.toMatch(/TtT/);
  });

  it('says what changed for someone sent an earlier version', () => {
    const { subject, body } = onboardingEmail({
      recipientName: 'Jordan Lee',
      forTeam: false,
      hospitalName: 'Example Valley Hospital',
      initiativeCode: 'SPARK',
      programYear: 2027,
      onboarding,
      update: true,
    });
    expect(subject).toMatch(/^Updated: SPARK 2027 onboarding/);
    expect(body).toContain('Hi Jordan Lee,');
    expect(body).toContain('The 2027 SPARK onboarding details have changed.');
  });

  it('escapes what the PM typed', () => {
    const { html } = onboardingEmail({
      recipientName: null,
      forTeam: true,
      hospitalName: 'Example Valley Hospital',
      initiativeCode: 'NEST',
      programYear: 2027,
      onboarding: { sessions: [{ title: '<b>Kickoff</b>', when: 'Jan 5', registrationUrl: null }], note: null },
    });
    expect(html).toContain('&lt;b&gt;Kickoff&lt;/b&gt;');
  });
});

describe('receiptEmail with onboarding details', () => {
  const base = {
    submitterName: 'Jordan Lee',
    hospitalName: 'Example Valley Hospital',
    initiativeCode: 'SPARK' as const,
    programYear: 2027,
    editUrl: 'https://qi.example.org/enrollment/2027?token=abc',
    closesAt: '2026-12-01',
  };

  it('carries the dates once the PM has written them', () => {
    const { body } = receiptEmail({ ...base, onboarding });
    expect(body).toContain('Your onboarding dates and registration are below.');
    expect(body).toContain('Onboarding dates and registration:');
    expect(body).toContain('Onboarding webinar: Tuesday, January 12, 2027');
    expect(body).toContain('https://qi.example.org/enrollment/2027?token=abc');
  });

  it('says the PM will follow up until then', () => {
    const { body } = receiptEmail({ ...base, onboarding: { sessions: [], note: '  ' } });
    expect(body).toContain('the program manager will be in contact with next steps');
    expect(body).not.toContain('Onboarding dates and registration:');
  });
});
