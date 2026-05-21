/**
 * Plain-text email templates. Kept simple and copy-editable; can be swapped
 * for MJML/HTML templates later without touching call sites.
 */

import { env } from '@/config/env.js';

export function interestFormReceivedToStaff(input: {
  initiativeName: string;
  facilityName: string;
  submitterName: string;
  submitterEmail: string;
  submitterRole: string;
  interestFormId: string;
}): { subject: string; body: string } {
  return {
    subject: `New Interest Form: ${input.facilityName} — ${input.initiativeName}`,
    body: `A new Interest Form has been submitted.

Initiative: ${input.initiativeName}
Facility: ${input.facilityName}
Submitter: ${input.submitterName} (${input.submitterRole})
Email: ${input.submitterEmail}

Review and approve or decline:
${env.APP_BASE_URL}/staff/interest-forms/${input.interestFormId}

— CPCQC Engagement Tracker`,
  };
}

export function interestFormApprovedToHospital(input: {
  recipientName: string;
  initiativeName: string;
  facilityName: string;
  passwordSetupUrl: string;
}): { subject: string; body: string } {
  return {
    subject: `You're approved to enroll in ${input.initiativeName}`,
    body: `Hello ${input.recipientName},

Your Interest Form for ${input.facilityName} has been reviewed and approved
for the ${input.initiativeName} initiative.

Next step: set up your account and submit the Enrollment Form.

${input.passwordSetupUrl}

This link expires in 7 days. If you have any questions, reply to this email.

— CPCQC`,
  };
}

export function interestFormDeclinedToHospital(input: {
  recipientName: string;
  initiativeName: string;
  staffNotes?: string;
}): { subject: string; body: string } {
  const noteBlock = input.staffNotes ? `\n\nNote from CPCQC staff:\n${input.staffNotes}\n` : '';
  return {
    subject: `Your Interest Form for ${input.initiativeName}`,
    body: `Hello ${input.recipientName},

Thank you for your interest in the ${input.initiativeName} initiative. After
reviewing your Interest Form, we are not able to approve enrollment for the
upcoming program year.${noteBlock}

If you have questions or would like to discuss further, please reply to this email.

— CPCQC`,
  };
}
