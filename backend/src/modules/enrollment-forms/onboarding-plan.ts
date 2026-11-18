/**
 * Onboarding details: who gets them, and which hospitals still need them.
 *
 * Every submitted enrollment form gets its initiative's onboarding details,
 * once its PM has written them, in one email to the person who submitted it
 * and the champions it names. A Turning the Tide form that names no champions
 * goes to the hospital's Turning the Tide roster instead, since continuing
 * hospitals were not asked for one.
 *
 * A form already sent the current version is skipped. One sent an earlier
 * version, or whose send didn't go through, is listed, and sent only when
 * staff choose to include it. Anything attempted since `attemptedSince` is
 * left out, so a send run in batches never tries the same form twice.
 *
 * Pure, so it is testable without a database (the `@/` alias does not resolve
 * under vitest).
 */
import { INITIATIVE_SHORT, type FormInitiativeCode } from './enrollment-emails.js';
import type { PlanNote, PlannedRecipient } from './welcome-plan.js';

const ORDER: FormInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface OnboardingForm {
  formId: string;
  hospitalId: string;
  hospitalName: string;
  code: FormInitiativeCode;
  submitterName: string;
  submitterEmail: string;
  /** The champions the form names; empty for a Turning the Tide continuation. */
  champions: Array<{ name: string; email: string }>;
}

/**
 * The submitter first, then the form's champions, or the hospital's roster
 * for the initiative when the form names none. One entry per address.
 */
export function onboardingRecipients(
  form: OnboardingForm,
  roster: Array<{ name: string; email: string | null }>,
): PlannedRecipient[] {
  const named = form.champions.filter((c) => c.email?.trim());
  const team = named.length > 0 ? named : roster;
  const out = new Map<string, PlannedRecipient>();
  for (const p of [{ name: form.submitterName, email: form.submitterEmail }, ...team]) {
    const email = (p.email ?? '').trim();
    const key = email.toLowerCase();
    if (!EMAIL.test(email) || out.has(key)) continue;
    out.set(key, { name: (p.name ?? '').trim(), email });
  }
  return [...out.values()];
}

export interface OnboardingSendRecord {
  formId: string;
  version: number;
  emailSent: boolean;
  /** ISO timestamp. */
  sentAt: string;
  /** The day it went, as CPCQC counts it, YYYY-MM-DD. */
  sentDay: string;
  toEmail: string;
}

export interface PlannedOnboarding {
  formId: string;
  hospital: { id: string; name: string };
  code: FormInitiativeCode;
  recipients: PlannedRecipient[];
  /** new: never sent. update: sent an earlier version. retry: didn't go through. */
  kind: 'new' | 'update' | 'retry';
  /** They have an earlier version: the email says the details changed. */
  update: boolean;
  version: number;
}

export interface OnboardingPlanInput {
  forms: OnboardingForm[];
  /** `${hospitalId}:${code}` → that hospital's roster for the initiative. */
  roster: Map<string, Array<{ name: string; email: string | null }>>;
  /** Each initiative's current version, when its details are set. */
  versions: Partial<Record<FormInitiativeCode, number>>;
  sends: OnboardingSendRecord[];
  includeUpdated: boolean;
  includeFailed: boolean;
  /** ISO timestamp: forms attempted since then are left out. */
  attemptedSince: string | null;
}

export interface OnboardingPlan {
  emails: PlannedOnboarding[];
  /** Waiting for their initiative's details. */
  held: PlanNote[];
  /** Already sent the current version. */
  skipped: PlanNote[];
  /** Sent an earlier version: sent again only when staff include them. */
  updated: PlanNote[];
  /** The current version didn't go through: retried only when staff include them. */
  failed: PlanNote[];
}

export function planOnboarding(input: OnboardingPlanInput): OnboardingPlan {
  const plan: OnboardingPlan = { emails: [], held: [], skipped: [], updated: [], failed: [] };
  const sendsFor = new Map<string, OnboardingSendRecord[]>();
  for (const s of input.sends) sendsFor.set(s.formId, [...(sendsFor.get(s.formId) ?? []), s]);

  const forms = [...input.forms].sort(
    (a, b) => a.hospitalName.localeCompare(b.hospitalName) || ORDER.indexOf(a.code) - ORDER.indexOf(b.code),
  );
  for (const f of forms) {
    const note = (reason: string): PlanNote => ({ hospital: f.hospitalName, initiative: f.code, reason });
    const version = input.versions[f.code];
    if (version === undefined) {
      plan.held.push(note(`No ${INITIATIVE_SHORT[f.code]} onboarding details yet.`));
      continue;
    }
    const sends = (sendsFor.get(f.formId) ?? []).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    if (input.attemptedSince && sends.some((s) => s.sentAt >= input.attemptedSince!)) {
      plan.skipped.push(note('Sent in this run.'));
      continue;
    }
    const current = sends.filter((s) => s.version === version);
    const currentOk = current.find((s) => s.emailSent);
    const earlierOk = sends.find((s) => s.emailSent && s.version !== version);

    let kind: PlannedOnboarding['kind'];
    if (currentOk) {
      plan.skipped.push(note(`Sent ${currentOk.sentDay}.`));
      continue;
    } else if (current.length > 0) {
      const to = [...new Set(current.map((s) => s.toEmail))].join(', ');
      plan.failed.push(note(`Didn't go through on ${current[0]!.sentDay} (${to}).`));
      if (!input.includeFailed) continue;
      kind = 'retry';
    } else if (earlierOk) {
      plan.updated.push(note(`Sent ${earlierOk.sentDay}, before the details last changed.`));
      if (!input.includeUpdated) continue;
      kind = 'update';
    } else {
      kind = 'new';
    }

    const recipients = onboardingRecipients(f, input.roster.get(`${f.hospitalId}:${f.code}`) ?? []);
    if (recipients.length === 0) {
      plan.held.push(note('No valid email address on the form or the roster.'));
      continue;
    }
    plan.emails.push({
      formId: f.formId,
      hospital: { id: f.hospitalId, name: f.hospitalName },
      code: f.code,
      recipients,
      kind,
      update: !!earlierOk,
      version,
    });
  }
  return plan;
}
