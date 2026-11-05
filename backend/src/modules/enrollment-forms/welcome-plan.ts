/**
 * The welcome-to-enroll send: reading CPCQC's enrollment-decisions
 * spreadsheet and working out who gets which enrollment form.
 *
 * The spreadsheet is the Board tab of the year's enrollment-decisions sheet:
 * one row per hospital, a "Form" column saying whether it filed an interest
 * form, and one column per initiative holding the decision. Accept (SPARK,
 * SOAR, NEST) or Continuing (TtT) means the hospital is sent that initiative's
 * form; Discuss, Waitlist, Decline, Withdrawing or a blank mean it isn't.
 * Summary rows above the header row are ignored.
 *
 * Who it goes to:
 * - A hospital that filed an interest form: one email to whoever filed it,
 *   with a link for each initiative.
 * - A hospital that didn't: one email per initiative, to everyone on that
 *   initiative's roster with an email address, all on the same To line. Each
 *   initiative's own champions get its form, and getting it together makes
 *   it plain that the team files one form, not one each.
 * - A hospital sharing another's roster (`sharedRoster`): its links go to the
 *   other hospital's champions, in the same email. This is UCHealth Memorial,
 *   which enrolled as one hospital in 2026 and as Central and North from 2027.
 *
 * Nothing goes to an initiative already filed or already sent, and anything
 * that can't be placed (a name the tracker doesn't know, a roster with no
 * addresses) is held and listed rather than guessed at.
 *
 * Pure, so it is testable without a database (the `@/` alias does not resolve
 * under vitest).
 */
import { INITIATIVE_SHORT, type FormInitiativeCode } from './enrollment-emails.js';

/** Sheet column headers, compared lowercase with punctuation stripped. */
const INITIATIVE_HEADERS: Array<{ code: FormInitiativeCode; header: string }> = [
  { code: 'SPARK', header: 'spark' },
  { code: 'SOAR', header: 'soar' },
  { code: 'NEST', header: 'nest' },
  { code: 'TTT', header: 'ttt' },
];

/** Decisions that send the form. Everything else is recorded as not sent. */
const SENDS = new Set(['accept', 'accepted', 'continuing', 'continue']);

const headerKey = (v: unknown) => cellText(v).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A spreadsheet cell as plain text. Workbooks give formulas, hyperlinks and
 * rich text as objects. A formula whose result is blank comes with no result
 * at all, which is how the Board's empty TtT cells arrive, so that is blank
 * too, never "[object Object]".
 */
export function cellValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== 'object') return String(v).trim();
  const o = v as Record<string, unknown>;
  if ('formula' in o || 'sharedFormula' in o || 'result' in o) return cellValue(o['result']);
  if (Array.isArray(o['richText'])) {
    return (o['richText'] as Array<{ text?: unknown }>).map((r) => String(r.text ?? '')).join('').trim();
  }
  if (typeof o['text'] === 'string') return (o['text'] as string).trim();
  // An error value (#N/A) or anything else unrecognised reads as blank.
  return '';
}

function cellText(v: unknown): string {
  return cellValue(v);
}

/** Names as the sheet and the tracker write them, made comparable. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[‘’ʼ]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SheetRow {
  /** The spreadsheet's own row number, for messages. */
  rowNumber: number;
  hospital: string;
  /** From the Form column: true for Yes, false for "No form", null otherwise. */
  filedInterestForm: boolean | null;
  send: FormInitiativeCode[];
  /** Decisions that don't send a form, e.g. Waitlist or Withdrawing. */
  notSent: Array<{ code: FormInitiativeCode; decision: string }>;
}

export function parseAcceptanceSheet(rows: unknown[][]): SheetRow[] {
  const headerIndex = rows.findIndex((r) => {
    const keys = r.map(headerKey);
    return keys.includes('hospital') && INITIATIVE_HEADERS.every((i) => keys.includes(i.header));
  });
  if (headerIndex < 0) {
    throw new Error(
      'Could not find the header row. It needs a Hospital column and one each for SPARK, SOAR, NEST and TtT.',
    );
  }
  const keys = rows[headerIndex]!.map(headerKey);
  const hospitalCol = keys.indexOf('hospital');
  const formCol = keys.indexOf('form');
  const cols = INITIATIVE_HEADERS.map((i) => ({ ...i, col: keys.indexOf(i.header) }));

  const out: SheetRow[] = [];
  rows.slice(headerIndex + 1).forEach((r, i) => {
    const hospital = cellText(r[hospitalCol]);
    if (!hospital) return;
    const form = formCol >= 0 ? cellText(r[formCol]).toLowerCase() : '';
    const row: SheetRow = {
      rowNumber: headerIndex + i + 2,
      hospital,
      filedInterestForm: form === 'yes' ? true : form.startsWith('no') ? false : null,
      send: [],
      notSent: [],
    };
    for (const c of cols) {
      const decision = cellText(r[c.col]);
      if (!decision) continue;
      if (SENDS.has(decision.toLowerCase())) row.send.push(c.code);
      else row.notSent.push({ code: c.code, decision });
    }
    out.push(row);
  });
  return out;
}

/**
 * What each hospital that filed an interest form was accepted into, per the
 * sheet. Once the welcome emails go, this replaces whatever its interest form
 * recorded before: the sheet is CPCQC's final decision. TtT isn't on the
 * interest form, so it isn't here either.
 */
export function interestFormAcceptances(
  sheet: SheetRow[],
  hospitals: Array<{ id: string; name: string }>,
  hasInterestForm: (hospitalId: string) => boolean,
): Map<string, FormInitiativeCode[]> {
  const byName = new Map(hospitals.map((h) => [nameKey(h.name), h]));
  const out = new Map<string, FormInitiativeCode[]>();
  for (const row of sheet) {
    const hospital = byName.get(nameKey(row.hospital));
    if (!hospital || row.filedInterestForm === false || !hasInterestForm(hospital.id)) continue;
    out.set(hospital.id, row.send.filter((c) => c !== 'TTT'));
  }
  return out;
}

// -------- Planning --------

export interface PlanHospital {
  id: string;
  name: string;
}

export interface PlanInput {
  sheet: SheetRow[];
  hospitals: PlanHospital[];
  /** The year's interest forms, by hospital id. */
  interestForms: Map<string, { submitterName: string; submitterEmail: string }>;
  roster: Array<{ hospitalId: string; initiativeCode: string; name: string; email: string | null }>;
  /** `${hospitalId}:${code}` for forms already submitted this year. */
  filed: Set<string>;
  /** `${hospitalId}:${code}` → when the form was first sent this year. */
  sent: Map<string, string>;
  /** Hospital name → the hospital whose champions receive its forms. */
  sharedRoster: Record<string, string>;
}

export interface PlannedLink {
  code: FormInitiativeCode;
  hospitalId: string;
  hospitalName: string;
}

export interface PlannedRecipient {
  name: string;
  email: string;
}

export interface PlannedEmail {
  /** Everyone on the To line: the submitter, or an initiative's champions. */
  recipients: PlannedRecipient[];
  /** "Interest form", or the roster the addresses came from, e.g. "SOAR roster". */
  source: string;
  /** The hospitals the email is about; two when one roster covers both. */
  hospitals: PlanHospital[];
  links: PlannedLink[];
  /**
   * Everything those hospitals were accepted into. A team's email lists it
   * all, so no team wonders about the rest, but links only its own form.
   */
  accepted: FormInitiativeCode[];
  /** Sent to one initiative's team rather than to whoever filed the interest form. */
  forTeam: boolean;
  /** Something staff should know before sending, e.g. a sheet/tracker mismatch. */
  warning: string | null;
}

export interface PlanNote {
  hospital: string;
  initiative: FormInitiativeCode | null;
  reason: string;
}

export interface WelcomePlan {
  emails: PlannedEmail[];
  /** Couldn't be sent as things stand; staff need to act. */
  held: PlanNote[];
  /** Deliberately not sent: the decision, or it was filed or sent already. */
  skipped: PlanNote[];
}

const ORDER: FormInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];
const byOrder = (a: PlannedLink, b: PlannedLink) =>
  ORDER.indexOf(a.code) - ORDER.indexOf(b.code) || a.hospitalName.localeCompare(b.hospitalName);

export function planWelcomeEmails(input: PlanInput): WelcomePlan {
  const byName = new Map(input.hospitals.map((h) => [nameKey(h.name), h]));
  const shared = new Map(
    Object.entries(input.sharedRoster).map(([from, to]) => [nameKey(from), nameKey(to)]),
  );
  const emails = new Map<string, PlannedEmail>();
  const held: PlanNote[] = [];
  const skipped: PlanNote[] = [];

  const add = (
    key: string,
    base: Omit<PlannedEmail, 'links' | 'hospitals' | 'accepted'>,
    hospitals: PlanHospital[],
    link: PlannedLink,
    accepted: FormInitiativeCode[],
  ) => {
    const e = emails.get(key) ?? { ...base, hospitals: [], links: [], accepted: [] };
    for (const h of hospitals) if (!e.hospitals.some((x) => x.id === h.id)) e.hospitals.push(h);
    e.links.push(link);
    for (const c of accepted) if (!e.accepted.includes(c)) e.accepted.push(c);
    emails.set(key, e);
  };

  for (const row of input.sheet) {
    const hospital = byName.get(nameKey(row.hospital));
    if (!hospital) {
      if (row.send.length > 0) {
        held.push({
          hospital: row.hospital,
          initiative: null,
          reason: `Row ${row.rowNumber}: no hospital by this name in the tracker.`,
        });
      }
      continue;
    }
    for (const n of row.notSent) {
      skipped.push({ hospital: hospital.name, initiative: n.code, reason: `Marked ${n.decision}.` });
    }

    const codes = row.send.filter((code) => {
      const k = `${hospital.id}:${code}`;
      if (input.filed.has(k)) {
        skipped.push({ hospital: hospital.name, initiative: code, reason: 'Already submitted.' });
        return false;
      }
      const sentOn = input.sent.get(k);
      if (sentOn) {
        skipped.push({ hospital: hospital.name, initiative: code, reason: `Already sent on ${sentOn}.` });
        return false;
      }
      return true;
    });
    if (codes.length === 0) continue;

    const interest = input.interestForms.get(hospital.id) ?? null;
    const viaSubmitter = row.filedInterestForm === true || (row.filedInterestForm === null && interest);
    if (viaSubmitter) {
      if (!interest) {
        held.push({
          hospital: hospital.name,
          initiative: null,
          reason: 'The sheet says it filed an interest form, but the tracker has none this year.',
        });
        continue;
      }
      for (const code of codes) {
        add(
          `submitter:${interest.submitterEmail.toLowerCase()}:${hospital.id}`,
          {
            recipients: [{ name: interest.submitterName.trim(), email: interest.submitterEmail.trim() }],
            source: 'Interest form',
            warning: null,
            forTeam: false,
          },
          [hospital],
          { code, hospitalId: hospital.id, hospitalName: hospital.name },
          row.send,
        );
      }
      continue;
    }

    // No interest form: each initiative's own champions.
    const rosterName = shared.get(nameKey(hospital.name));
    const rosterHospital = rosterName ? byName.get(rosterName) ?? hospital : hospital;
    const warning = interest
      ? `The tracker has an interest form from ${interest.submitterName}, but the sheet says No form, so this goes to champions.`
      : null;
    for (const code of codes) {
      const seen = new Set<string>();
      const people = input.roster.filter((p) => {
        const email = p.email?.trim().toLowerCase();
        if (p.hospitalId !== rosterHospital.id || p.initiativeCode !== code || !email) return false;
        if (seen.has(email)) return false;
        seen.add(email);
        return true;
      });
      if (people.length === 0) {
        held.push({
          hospital: hospital.name,
          initiative: code,
          reason:
            rosterHospital.id === hospital.id
              ? `No one with an email address on its ${INITIATIVE_SHORT[code]} roster.`
              : `No one with an email address on ${rosterHospital.name}'s ${INITIATIVE_SHORT[code]} roster.`,
        });
        continue;
      }
      add(
        `champion:${rosterHospital.id}:${code}`,
        {
          recipients: people.map((p) => ({ name: p.name.trim(), email: p.email!.trim() })),
          source: `${INITIATIVE_SHORT[code]} roster`,
          warning,
          forTeam: true,
        },
        // The roster's own hospital first, then any whose links it carries.
        [rosterHospital, hospital],
        { code, hospitalId: hospital.id, hospitalName: hospital.name },
        row.send,
      );
    }
  }

  const planned = [...emails.values()].map((e) => ({
    ...e,
    links: [...e.links].sort(byOrder),
    accepted: ORDER.filter((c) => e.accepted.includes(c)),
  }));
  planned.sort(
    (a, b) =>
      a.hospitals[0]!.name.localeCompare(b.hospitals[0]!.name) ||
      ORDER.indexOf(a.links[0]!.code) - ORDER.indexOf(b.links[0]!.code) ||
      a.recipients[0]!.name.localeCompare(b.recipients[0]!.name),
  );
  return { emails: planned, held, skipped };
}
