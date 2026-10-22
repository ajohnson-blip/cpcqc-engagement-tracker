import { describe, expect, it } from 'vitest';
import { describeAssignments, staffSetupEmail } from './staff-setup-email.js';

const base = {
  firstName: 'Alex',
  email: 'alex@example.test',
  setupUrl: 'https://tracker.example.test/reset-password?token=abc&setup=1',
  loginUrl: 'https://tracker.example.test/login',
  expiresInDays: 7,
  addedBy: 'Sam Example',
  admin: false,
  assignments: [],
  reason: 'welcome' as const,
};

describe('describeAssignments', () => {
  it('reads naturally for none, one and several', () => {
    expect(describeAssignments([])).toBeNull();
    expect(describeAssignments([{ initiativeCode: 'SOAR', role: 'program_manager' }])).toBe(
      'Program Manager for SOAR',
    );
    expect(
      describeAssignments([
        { initiativeCode: 'NEST', role: 'program_manager' },
        { initiativeCode: 'NEST', role: 'qi_advisor' },
        { initiativeCode: 'TTT', role: 'qi_advisor' },
      ]),
    ).toBe('Program Manager for NEST, QI Advisor for NEST and QI Advisor for Turning the Tide');
  });
});

describe('staffSetupEmail', () => {
  it('welcomes a new staff member with their role, the link and its expiry', () => {
    const { subject, body } = staffSetupEmail({
      ...base,
      assignments: [{ initiativeCode: 'SOAR', role: 'program_manager' }],
    });
    expect(subject).toBe('Your CPCQC Engagement Tracker staff account');
    expect(body).toContain('Sam Example has set up your CPCQC Engagement Tracker staff account as Program Manager for SOAR.');
    expect(body).toContain(base.setupUrl);
    expect(body).toContain('expires in 7 days');
    expect(body).toContain('alex@example.test');
  });

  it('mentions admin access, and copes without a role or a known sender', () => {
    const { body } = staffSetupEmail({ ...base, admin: true, addedBy: null });
    expect(body).toContain('A CPCQC administrator has set up your CPCQC Engagement Tracker staff account with admin access.');
  });

  it('words a resent link as a new link, not a new account', () => {
    const { subject, body } = staffSetupEmail({ ...base, reason: 'resend' });
    expect(subject).toBe('Set your CPCQC Engagement Tracker password');
    expect(body).toContain('Here is a new link');
    expect(body).not.toContain('has set up');
  });

  it('never contains a password', () => {
    expect(staffSetupEmail(base).body.toLowerCase()).not.toMatch(/password:\s/);
  });
});
