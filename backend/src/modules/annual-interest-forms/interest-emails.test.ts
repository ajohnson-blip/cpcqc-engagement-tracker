import { describe, expect, it } from 'vitest';
import { canResendConfirmation, interestVerificationEmail } from './interest-emails.js';

const base = {
  submitterName: '  Jane Doe ',
  hospitalName: 'Gunnison Valley Health',
  programYear: 2027,
  verifyUrl: 'https://qi.cpcqc.org/interest/verify?token=abc',
};

describe('interestVerificationEmail', () => {
  it('carries the link and says the form is not final until confirmed', () => {
    const { subject, body } = interestVerificationEmail(base);
    expect(subject).toBe('Confirm your CPCQC 2027 interest form');
    expect(body).toContain('Hi Jane Doe,');
    expect(body).toContain(base.verifyUrl);
    expect(body).toContain('not final until you confirm by clicking the link');
    expect(body).not.toContain('no longer works');
  });

  it('on a resend, says the earlier link is dead', () => {
    // Someone who later finds the first email in spam would otherwise click a
    // retired link and conclude the form is broken.
    const { subject, body } = interestVerificationEmail({ ...base, resend: true });
    expect(subject).toBe('Confirm your CPCQC 2027 interest form');
    expect(body).toContain('re-sending the confirmation link');
    expect(body).toContain('older link no longer works');
    expect(body).toContain(base.verifyUrl);
  });
});

describe('canResendConfirmation', () => {
  it('allows an unconfirmed public submission', () => {
    expect(canResendConfirmation({ submittedVia: 'public', verifiedAt: null })).toEqual({ ok: true });
  });

  it("refuses a portal submission — the hospital's login confirmed it", () => {
    expect(canResendConfirmation({ submittedVia: 'portal', verifiedAt: null }).ok).toBe(false);
  });

  it('refuses a confirmed submission, which would retire the edit link', () => {
    const r = canResendConfirmation({ submittedVia: 'public', verifiedAt: new Date() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/already confirmed/);
  });
});
