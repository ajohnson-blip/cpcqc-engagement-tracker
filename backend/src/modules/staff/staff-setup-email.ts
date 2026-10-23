/**
 * The email a new CPCQC staff member receives: a link to choose their own
 * password. Pure — no `@/` imports — so it is unit testable.
 *
 * It never carries a password. Staff accounts are created with one nobody
 * knows; the link is the only way in.
 */

export type InitiativeCode = 'TTT' | 'SPARK' | 'SOAR' | 'NEST';
export type AssignmentRole = 'program_manager' | 'qi_advisor';

const ROLE_LABEL: Record<AssignmentRole, string> = {
  program_manager: 'Program Manager',
  qi_advisor: 'QI Advisor',
};

const INITIATIVE_LABEL: Record<InitiativeCode, string> = {
  TTT: 'Turning the Tide',
  SPARK: 'SPARK',
  SOAR: 'SOAR',
  NEST: 'NEST',
};

/** "Program Manager for SOAR and QI Advisor for NEST", or null with none. */
export function describeAssignments(
  assignments: Array<{ initiativeCode: InitiativeCode; role: AssignmentRole }>,
): string | null {
  if (assignments.length === 0) return null;
  const parts = assignments.map((a) => `${ROLE_LABEL[a.role]} for ${INITIATIVE_LABEL[a.initiativeCode]}`);
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function staffSetupEmail(input: {
  firstName: string;
  email: string;
  setupUrl: string;
  loginUrl: string;
  expiresInDays: number;
  /** The admin who added them, when known. */
  addedBy: string | null;
  admin: boolean;
  assignments: Array<{ initiativeCode: InitiativeCode; role: AssignmentRole }>;
  /** 'welcome' for a new account; 'resend' for a fresh link to an existing one. */
  reason: 'welcome' | 'resend';
}): { subject: string; body: string } {
  const roles = describeAssignments(input.assignments);
  const access = [roles ? `as ${roles}` : null, input.admin ? 'with admin access' : null]
    .filter(Boolean)
    .join(', ');

  const intro =
    input.reason === 'welcome'
      ? `${input.addedBy ?? 'A CPCQC administrator'} has set up your CPCQC Engagement Tracker staff ` +
        `account${access ? ` ${access}` : ''}.`
      : `Here is a new link to set the password for your CPCQC Engagement Tracker staff account.`;

  return {
    subject:
      input.reason === 'welcome'
        ? 'Your CPCQC Engagement Tracker staff account'
        : 'Set your CPCQC Engagement Tracker password',
    body: [
      `Hi ${input.firstName},`,
      intro,
      `Choose your password here:\n${input.setupUrl}`,
      `The link works once and expires in ${input.expiresInDays} days. Your sign-in email is ` +
        `${input.email}. After that, sign in at ${input.loginUrl}.`,
      `If the link has expired, ask a CPCQC administrator to send a new one, or use ` +
        `"Forgot password?" on the sign-in page.`,
      `Questions? qi@cpcqc.org`,
    ].join('\n\n'),
  };
}
