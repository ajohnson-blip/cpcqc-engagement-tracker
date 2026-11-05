import { describe, expect, it } from 'vitest';
import {
  acceptanceEmail,
  enrollmentFormUrl,
  greetingFor,
  receiptEmail,
  welcomeEmail,
} from './enrollment-emails.js';

const BASE = 'https://qi.example.org/';
const link = (code: 'SPARK' | 'SOAR' | 'NEST' | 'TTT') => ({
  code,
  url: enrollmentFormUrl(BASE, 2027, 'h-ex-001', code),
});
const dates = { opensAt: '2026-11-15', closesAt: '2026-12-01' };

describe('enrollmentFormUrl', () => {
  it('opens the form with the hospital and initiative chosen', () => {
    expect(enrollmentFormUrl(BASE, 2027, 'h ex/001', 'NEST')).toBe(
      'https://qi.example.org/enrollment/2027?hospital=h%20ex%2F001&initiative=NEST',
    );
  });
});

describe('welcomeEmail', () => {
  const at = (code: 'SPARK' | 'SOAR' | 'NEST' | 'TTT', hospitalName = 'Example Valley Hospital') => ({
    ...link(code),
    hospitalName,
  });

  it("is CPCQC's welcome wording, one line per form", () => {
    const { subject, body } = welcomeEmail({
      recipientName: 'Jane Doe',
      programYear: 2027,
      links: [at('SPARK'), at('NEST')],
      closesAt: '2026-12-01',
    });
    expect(subject).toBe('CPCQC 2027 — Example Valley Hospital has been accepted');
    expect(body).toBe(
      [
        'Hi Jane Doe,',
        '',
        'Good news — Example Valley Hospital has been accepted into the following initiative(s) for 2027: SPARK, NEST.',
        '',
        'Next step: complete an enrollment form for each initiative. Each initiative has its own form, and your ' +
          'hospital isn’t enrolled until each one is submitted. Each form should be completed by one team member.',
        '',
        `– SPARK: Postpartum Discharge Transitions, ${link('SPARK').url}`,
        `– NEST: Infant Safe Sleep, ${link('NEST').url}`,
        '',
        'Enrollment forms must be submitted by December 1, 2026 to meet Colorado law.',
        '',
        'If anything has changed or if you have additional questions, please contact qi@cpcqc.org.',
      ].join('\n'),
    );
  });

  it('names each link in the HTML instead of showing the address', () => {
    const { html } = welcomeEmail({
      recipientName: 'Jane <Doe>',
      programYear: 2027,
      links: [at('SPARK'), at('NEST')],
      closesAt: '2026-12-01',
    });
    expect(html).toContain(`<a href="${link('SPARK').url.replace(/&/g, '&amp;')}"`);
    expect(html).toContain('>SPARK Enrollment Form</a>');
    expect(html).toContain('>NEST Enrollment Form</a>');
    expect(html).not.toContain(`, ${link('NEST').url}`);
    expect(html).toContain('Hi Jane &lt;Doe&gt;,');
  });

  it("lists all of a hospital's acceptances in a team's email but links only its own form", () => {
    const { body, html } = welcomeEmail({
      recipientName: 'everyone',
      programYear: 2027,
      links: [at('NEST')],
      accepted: ['SPARK', 'SOAR', 'NEST', 'TTT'],
      forTeam: true,
      closesAt: '2026-12-01',
    });
    expect(body.split('\n')[0]).toBe('Hi Example Valley Hospital NEST champions,');
    expect(body).toContain('for 2027: SPARK, SOAR, NEST, TtT (continuing).');
    expect(body).toContain(
      'This email has your NEST enrollment form. The SPARK, SOAR and TtT forms go to those initiatives’ teams.',
    );
    expect(html).toContain('>NEST Enrollment Form</a>');
    expect(html).not.toContain('SPARK Enrollment Form');
    // The TtT note belongs with the TtT form, which this team doesn't hold.
    expect(body).not.toContain('still required by Colorado law');
  });

  it('marks TtT as a continuation that is still required', () => {
    const { body } = welcomeEmail({
      recipientName: 'Jane',
      programYear: 2027,
      links: [at('TTT')],
      closesAt: '2026-12-01',
    });
    expect(body).toContain('for 2027: TtT (continuing).');
    expect(body).toContain('– Turning the Tide: Perinatal Substance Use (continuation form), ');
    expect(body).toContain('Submitting it is still required by Colorado law.');
  });

  it('tells a roster covering two sites that each files its own form', () => {
    const { subject, body } = welcomeEmail({
      recipientName: 'Morgan',
      programYear: 2027,
      links: [at('TTT', 'Example Central'), at('TTT', 'Example North')],
      closesAt: '2026-12-01',
    });
    expect(subject).toBe('CPCQC 2027 — Example Central and Example North have been accepted');
    expect(body).toContain('(continuation form) for Example Central, ');
    expect(body).toContain('(continuation form) for Example North, ');
    expect(welcomeEmail({
      recipientName: 'Morgan',
      programYear: 2027,
      links: [at('TTT', 'Example Central'), at('TTT', 'Example North')],
      closesAt: '2026-12-01',
    }).html).toContain('>TtT Enrollment Form: Example North</a>');
    expect(body).toContain(
      'Example Central and Example North enrolled together as one hospital in 2026. For 2027, each needs its own enrollment form',
    );
  });
});

describe('acceptanceEmail', () => {
  it('is the welcome email when there are forms to link', () => {
    const { subject, body } = acceptanceEmail({
      submitterName: ' Jane Doe ',
      hospitalName: 'Example Valley Hospital',
      programYear: 2027,
      initiatives: ['SPARK', 'NEST'],
      links: [link('SPARK'), link('NEST')],
      dates,
    });
    expect(subject).toBe('CPCQC 2027 — Example Valley Hospital has been accepted');
    expect(body).toContain('Hi Jane Doe,');
    expect(body).toContain('into the following initiative(s) for 2027: SPARK, NEST.');
    expect(body).toContain('SPARK: Postpartum Discharge Transitions');
    expect(body).toContain('NEST: Infant Safe Sleep');
    expect(body).toContain(link('SPARK').url);
    expect(body).toContain(link('NEST').url);
    expect(body).toContain('must be submitted by December 1, 2026');
  });

  it('without accepted initiatives, promises a follow-up instead of links', () => {
    const { body } = acceptanceEmail({
      submitterName: 'Jane',
      hospitalName: 'Example Valley Hospital',
      programYear: 2027,
      initiatives: [],
      links: [],
      dates,
    });
    expect(body).toContain('has been accepted for 2027.');
    expect(body).toContain('CPCQC will follow up with the detailed, initiative-specific');
    expect(body).not.toContain('/enrollment/');
  });
});

describe('greetingFor', () => {
  it('names up to three people and greets a bigger team as everyone', () => {
    expect(greetingFor(['Avery Kim'])).toBe('Avery Kim');
    expect(greetingFor(['Avery Kim', 'Blake Ortiz'])).toBe('Avery Kim and Blake Ortiz');
    expect(greetingFor(['A', 'B', 'C'])).toBe('A, B and C');
    expect(greetingFor(['A', 'B', 'C', 'D'])).toBe('everyone');
    expect(greetingFor([' '])).toBeNull();
  });
});

describe('receiptEmail', () => {
  it('says the enrollment is received and links the form for changes', () => {
    const editUrl = 'https://qi.example.org/enrollment/2027?token=ex-token';
    const { subject, body, html } = receiptEmail({
      submitterName: 'Jane Doe',
      hospitalName: 'Example Valley Hospital',
      initiativeCode: 'TTT',
      programYear: 2027,
      editUrl,
      closesAt: '2026-12-01',
    });
    expect(subject).toBe('TtT enrollment received — Example Valley Hospital');
    expect(body).toContain('Your enrollment form has been received and the program manager will be in contact');
    expect(body).toContain('Initiative: Turning the Tide: Perinatal Substance Use');
    expect(body).toContain(`To change anything before December 1, 2026, use this link: ${editUrl}`);
    expect(html).toContain('>Edit your enrollment form</a>');
    expect(body).not.toMatch(/confirm/i);
  });
});
