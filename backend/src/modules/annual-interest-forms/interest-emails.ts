/**
 * Interest-form confirmation email and the resend rule.
 *
 * Pure, so both are testable without a database (the `@/` alias does not
 * resolve under vitest). The email lives here once, used by the original
 * submission and by the staff resend, so the two cannot drift apart in what
 * they promise the submitter.
 */

export interface VerificationEmailInput {
  submitterName: string;
  hospitalName: string;
  programYear: number;
  verifyUrl: string;
  /**
   * Set when staff re-send it. A resend issues a fresh link and retires the
   * old one, so the email has to say so — otherwise someone who later finds
   * the first email in their spam folder clicks a dead link and concludes the
   * form is broken.
   */
  resend?: boolean;
}

export function interestVerificationEmail(input: VerificationEmailInput): {
  subject: string;
  body: string;
} {
  const lines = [
    `Hi ${input.submitterName.trim()},`,
    '',
    input.resend
      ? `CPCQC is re-sending the confirmation link for ${input.hospitalName}'s ${input.programYear} interest form.`
      : `We've received an interest form for ${input.hospitalName} for ${input.programYear}.`,
    '',
    'Please confirm it by opening this link:',
    input.verifyUrl,
    '',
    'Your form is not final until you confirm by clicking the link.',
    ...(input.resend
      ? ['', 'This link replaces the one in any earlier confirmation email — that older link no longer works.']
      : []),
    '',
    'Keep this email. The same link reopens your submission if you need to change',
    'it — right up until the window closes. After that it becomes the record CPCQC',
    'plans cohorts from, so contact qi@cpcqc.org instead.',
    '',
    "If you didn't fill in this form, you can ignore this email and nothing will be recorded.",
    '',
    'Colorado Perinatal Care Quality Collaborative',
  ];
  return {
    subject: `Confirm your CPCQC ${input.programYear} interest form`,
    body: lines.join('\n'),
  };
}

export type ResendEligibility = { ok: true } | { ok: false; reason: string };

/**
 * Only an unconfirmed PUBLIC submission can be re-sent a confirmation link.
 *
 * A portal submission was confirmed by the hospital's own login, so there is
 * no link to send. A confirmed one needs nothing — and re-sending would retire
 * the link the submitter now uses to edit it.
 */
export function canResendConfirmation(row: {
  submittedVia: string;
  verifiedAt: Date | string | null;
}): ResendEligibility {
  if (row.submittedVia !== 'public') {
    return {
      ok: false,
      reason:
        "This form came through the portal, so the hospital's login already confirmed it — there is no confirmation link to send.",
    };
  }
  if (row.verifiedAt) {
    return {
      ok: false,
      reason:
        'This form is already confirmed. Re-sending would retire the link the submitter uses to edit it.',
    };
  }
  return { ok: true };
}
