import { describe, expect, it } from 'vitest';
import { onboardingRecipients, planOnboarding, type OnboardingForm, type OnboardingPlanInput } from './onboarding-plan.js';
import { onboardingEmail, onboardingProblem, onboardingTemplate, receiptEmail } from './enrollment-emails.js';

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
      { hospital: 'Sample Hospital 03', initiative: 'NEST', reason: 'No NEST onboarding message yet.' },
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

  it("plans one initiative's forms only, when a PM sends their own", () => {
    const plan = planOnboarding(input({ initiative: 'TTT' }));
    expect(plan.emails.map((e) => [e.hospital.name, e.code])).toEqual([['Sample Hospital 01', 'TTT']]);
    expect(plan.held).toEqual([]);
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
  message: [
    'Please register your team for one of the two onboarding sessions below.',
    '',
    'Option 1: Tuesday, January 12, 2027, 12–1 pm MT – [Register for option 1](https://example.test/option-1)',
    'Option 2: Thursday, January 14, 2027, 9–10 am MT – [Register for option 2](https://example.test/option-2)',
    '',
    'Slides will be posted at https://example.test/slides.',
    '',
    'Alex Rivera',
    'SPARK Program Manager',
  ].join('\n'),
};

describe('onboardingEmail', () => {
  it("greets the team, then carries the PM's message with its links named", () => {
    const { subject, body, html } = onboardingEmail({
      recipientName: null,
      forTeam: true,
      hospitalName: 'Example Valley Hospital',
      initiativeCode: 'TTT',
      programYear: 2027,
      onboarding,
    });
    expect(subject).toBe('Turning the Tide 2027 onboarding — Example Valley Hospital');
    expect(body).toContain('Hi Example Valley Hospital Turning the Tide team,');
    expect(body).toContain("Thank you for submitting Example Valley Hospital's 2027 Turning the Tide enrollment form.");
    expect(body).toContain(
      'Option 1: Tuesday, January 12, 2027, 12–1 pm MT – Register for option 1 (https://example.test/option-1)\n' +
        'Option 2:',
    );
    expect(body).toMatch(/Alex Rivera\nSPARK Program Manager\n\nColorado Perinatal Care Quality Collaborative$/);
    expect(html).toContain('href="https://example.test/option-1"');
    expect(html).toContain('>Register for option 1</a>');
    expect(html).toContain('href="https://example.test/slides"');
    expect(html).not.toContain('slides.</a>');
    expect(body).not.toMatch(/TtT/);
  });

  it('says it changed for someone sent an earlier version', () => {
    const { subject, body } = onboardingEmail({
      recipientName: 'Jordan Lee',
      forTeam: false,
      hospitalName: 'Example Valley Hospital',
      initiativeCode: 'SPARK',
      programYear: 2027,
      onboarding,
      update: true,
    });
    expect(subject).toBe('Updated: SPARK 2027 onboarding — Example Valley Hospital');
    expect(body).toContain('Hi Jordan Lee,');
    expect(body).toContain('The 2027 SPARK onboarding information has changed.');
  });

  it('escapes what the PM typed', () => {
    const { html } = onboardingEmail({
      recipientName: null,
      forTeam: true,
      hospitalName: 'Example Valley Hospital',
      initiativeCode: 'NEST',
      programYear: 2027,
      onboarding: { message: '<b>Kickoff</b> & more' },
    });
    expect(html).toContain('&lt;b&gt;Kickoff&lt;/b&gt; &amp; more');
  });
});

describe('onboardingProblem', () => {
  it('refuses the template until every {placeholder} is replaced', () => {
    const template = onboardingTemplate(2027);
    expect(template).toContain('Onboarding attendance is required and your team only needs to attend one.');
    expect(template).toContain('to support your success in 2027!');
    expect(onboardingProblem(template)).toBe('Replace {day, date and time} with your own text before saving.');
    expect(onboardingProblem(onboarding.message)).toBeNull();
  });

  it('refuses a named link without a web address', () => {
    expect(onboardingProblem('[Register](www.example.test/register)')).toBe(
      'The link "Register" needs a web address starting with https://.',
    );
  });
});

describe('receiptEmail with an onboarding message', () => {
  const base = {
    submitterName: 'Jordan Lee',
    hospitalName: 'Example Valley Hospital',
    initiativeCode: 'SPARK' as const,
    programYear: 2027,
    editUrl: 'https://qi.example.org/enrollment/2027?token=abc',
    closesAt: '2026-12-01',
  };

  it("carries the PM's message last, just above CPCQC's sign-off", () => {
    const { body } = receiptEmail({ ...base, onboarding });
    expect(body).toContain('Onboarding information from your program manager is below.');
    expect(body).toContain('https://qi.example.org/enrollment/2027?token=abc');
    expect(body.indexOf('Keep this email')).toBeLessThan(body.indexOf('Onboarding\n\nPlease register'));
    expect(body).toMatch(/SPARK Program Manager\n\nColorado Perinatal Care Quality Collaborative$/);
  });

  it('says the PM will follow up until then', () => {
    const { body } = receiptEmail({ ...base, onboarding: { message: '  ' } });
    expect(body).toContain('the program manager will be in contact with next steps');
    expect(body).not.toContain('Onboarding\n');
  });
});
