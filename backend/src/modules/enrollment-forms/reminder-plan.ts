/**
 * Enrollment reminders: who still owes a form, and who to remind.
 *
 * A reminder goes to everyone the form was successfully emailed to (the
 * welcome email's recipients, plus anyone it was resent to), one email per
 * hospital per set of people. So a submitter who owes two forms gets one
 * reminder with both links, and each initiative's team gets its own. A
 * hospital sharing another's roster (UCHealth Memorial North) is reminded in
 * the same email as that hospital.
 *
 * Held: a form never successfully emailed, since there is no one to remind
 * yet. Skipped: a form already reminded today, so a second click (or the next
 * batch of the same send) sends nothing twice.
 *
 * Pure, so it is testable without a database (the `@/` alias does not resolve
 * under vitest).
 */
import type { FormInitiativeCode } from './enrollment-emails.js';
import {
  nameKey,
  type PlanHospital,
  type PlanNote,
  type PlannedLink,
  type PlannedRecipient,
} from './welcome-plan.js';

export interface ReminderInput {
  /** Forms still owed, from the chase list. */
  outstanding: Array<{ hospitalId: string; hospitalName: string; code: FormInitiativeCode }>;
  /** Every send of a form this year, welcome emails and resends alike. */
  sent: Array<{
    hospitalId: string;
    code: string;
    toEmail: string;
    toName: string | null;
    emailSent: boolean;
    sentAt: string;
  }>;
  /** Earlier reminders this year. */
  reminded: Array<{ hospitalId: string; code: string; sentAt: string }>;
  hospitals: PlanHospital[];
  /** Hospital name → the hospital whose people are reminded with it. */
  sharedRoster: Record<string, string>;
  /** YYYY-MM-DD. */
  today: string;
}

export interface PlannedReminder {
  recipients: PlannedRecipient[];
  /** The hospitals it is about; two when one roster covers both. */
  hospitals: PlanHospital[];
  links: PlannedLink[];
  /** The latest earlier reminder for any of its forms, YYYY-MM-DD. */
  lastReminded: string | null;
}

export interface ReminderPlan {
  emails: PlannedReminder[];
  held: PlanNote[];
  skipped: PlanNote[];
}

const ORDER: FormInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];

export function planReminders(input: ReminderInput): ReminderPlan {
  const byName = new Map(input.hospitals.map((h) => [nameKey(h.name), h]));
  const shared = new Map(
    Object.entries(input.sharedRoster).map(([from, to]) => [nameKey(from), nameKey(to)]),
  );
  const sharedTo = (h: PlanHospital) => byName.get(shared.get(nameKey(h.name)) ?? '') ?? h;
  const lastReminded = new Map<string, string>();
  for (const r of input.reminded) {
    const k = `${r.hospitalId}:${r.code}`;
    const day = r.sentAt.slice(0, 10);
    if ((lastReminded.get(k) ?? '') < day) lastReminded.set(k, day);
  }

  const emails = new Map<string, PlannedReminder>();
  const held: PlanNote[] = [];
  const skipped: PlanNote[] = [];

  const outstanding = [...input.outstanding].sort(
    (a, b) => a.hospitalName.localeCompare(b.hospitalName) || ORDER.indexOf(a.code) - ORDER.indexOf(b.code),
  );
  for (const o of outstanding) {
    const k = `${o.hospitalId}:${o.code}`;
    const last = lastReminded.get(k) ?? null;
    if (last === input.today) {
      skipped.push({ hospital: o.hospitalName, initiative: o.code, reason: 'Already reminded today.' });
      continue;
    }
    // Everyone it reached, newest send first so the latest name is kept.
    const people = new Map<string, PlannedRecipient>();
    for (const s of [...input.sent].sort((a, b) => b.sentAt.localeCompare(a.sentAt))) {
      if (s.hospitalId !== o.hospitalId || s.code !== o.code || !s.emailSent) continue;
      const email = s.toEmail.trim();
      const key = email.toLowerCase();
      if (!key || people.has(key)) continue;
      // A send with no name gives none: the greeting falls back to "there".
      people.set(key, { name: s.toName?.trim() || '', email });
    }
    if (people.size === 0) {
      held.push({
        hospital: o.hospitalName,
        initiative: o.code,
        reason: 'Its form was never successfully emailed, so there is no one to remind. Send it from the chase list.',
      });
      continue;
    }
    const recipients = [...people.values()].sort((a, b) => a.email.localeCompare(b.email));
    const hospital = { id: o.hospitalId, name: o.hospitalName };
    const target = sharedTo(hospital);
    const key = `${target.id}|${recipients.map((r) => r.email.toLowerCase()).join(',')}`;
    const e = emails.get(key) ?? { recipients, hospitals: [], links: [], lastReminded: null };
    for (const h of [target, hospital]) if (!e.hospitals.some((x) => x.id === h.id)) e.hospitals.push(h);
    e.links.push({ code: o.code, hospitalId: o.hospitalId, hospitalName: o.hospitalName });
    if (last && (!e.lastReminded || e.lastReminded < last)) e.lastReminded = last;
    emails.set(key, e);
  }

  const planned = [...emails.values()].map((e) => ({
    ...e,
    // Only hospitals it carries a link for: a shared roster's own hospital may
    // already have filed.
    hospitals: e.hospitals.filter((h) => e.links.some((l) => l.hospitalId === h.id)),
    links: [...e.links].sort(
      (a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code) || a.hospitalName.localeCompare(b.hospitalName),
    ),
  }));
  planned.sort(
    (a, b) =>
      a.hospitals[0]!.name.localeCompare(b.hospitals[0]!.name) ||
      ORDER.indexOf(a.links[0]!.code) - ORDER.indexOf(b.links[0]!.code),
  );
  return { emails: planned, held, skipped };
}
