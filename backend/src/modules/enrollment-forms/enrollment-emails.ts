/**
 * The welcome-to-enroll email and the enrollment-form email.
 *
 * All of their wording lives here, in one place, so CPCQC can revise it
 * without hunting through modules. The welcome email goes out when staff
 * upload the year's acceptances (and from the interest-form screen's accept);
 * the enrollment-form email is a single send or re-send from the
 * enrollment-forms screen. Both carry the same per-initiative links, so they
 * cannot drift apart in where they send a hospital.
 *
 * Pure, so it is testable without a database (the `@/` alias does not resolve
 * under vitest).
 */

export type FormInitiativeCode = 'SPARK' | 'SOAR' | 'NEST' | 'TTT';

/** How the emails write each initiative's code. */
export const INITIATIVE_SHORT: Record<FormInitiativeCode, string> = {
  SPARK: 'SPARK',
  SOAR: 'SOAR',
  NEST: 'NEST',
  TTT: 'TtT',
};

/** Matches the labels on the public enrollment form. */
export const INITIATIVE_NAMES: Record<FormInitiativeCode, string> = {
  SPARK: 'SPARK: Postpartum Discharge Transitions',
  SOAR: 'SOAR: Primary Cesarean Reduction',
  NEST: 'NEST: Infant Safe Sleep',
  TTT: 'Turning the Tide: Perinatal Substance Use',
};

export interface EnrollmentLink {
  code: FormInitiativeCode;
  url: string;
}

/** Enrollment-step dates, as stored: ISO dates, or null when not yet set. */
export interface EnrollmentDates {
  opensAt: string | null;
  closesAt: string | null;
}

/**
 * The public enrollment form, opened with the hospital and initiative already
 * chosen. Each initiative is its own form, so a hospital in two gets two links.
 * The page treats both values as a starting choice the hospital can change.
 */
export function enrollmentFormUrl(
  baseUrl: string,
  programYear: number,
  hospitalId: string,
  code: FormInitiativeCode,
): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base}/enrollment/${programYear}?hospital=${encodeURIComponent(hospitalId)}&initiative=${code}`;
}

/** "December 1, 2026" from an ISO date. */
export const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

function datesLine(dates: EnrollmentDates): string {
  if (!dates.opensAt || !dates.closesAt) {
    return 'CPCQC will let you know when enrollment forms open.';
  }
  return `Enrollment forms can be submitted from ${longDate(dates.opensAt)} to ${longDate(dates.closesAt)}.`;
}

function linkLines(links: EnrollmentLink[]): string[] {
  return links.flatMap((l) => [`- ${INITIATIVE_NAMES[l.code]}`, `  ${l.url}`]);
}

const ORDER: FormInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];

/**
 * Who the greeting names: one person, two or three by name, or a whole team
 * as "everyone".
 */
export function greetingFor(names: string[]): string | null {
  const n = names.map((x) => x.trim()).filter(Boolean);
  if (n.length === 0) return null;
  if (n.length > 3) return 'everyone';
  return n.length === 1 ? n[0]! : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

/** Said in every email that carries a form link. */
const ONE_PERSON = 'Each form should be completed by one team member.';

const TTT_REQUIRED =
  'Turning the Tide continues into its second year, so its form is a short continuation form. ' +
  'Submitting it is still required by Colorado law.';

export interface WelcomeLink extends EnrollmentLink {
  hospitalName: string;
}

export interface WelcomeEmailInput {
  /** Blank when only an address is known. */
  recipientName: string | null;
  programYear: number;
  /** One per initiative per hospital; usually one hospital. */
  links: WelcomeLink[];
  /** The enrollment window's last day (ISO), or null when not yet set. */
  closesAt: string | null;
}

/**
 * "Welcome to enroll": the hospital's acceptances, with a link to each
 * initiative's enrollment form. A roster that covers two sites (UCHealth
 * Memorial Central and North, one hospital in 2026) gets both sites' links in
 * one email, and is told each site files its own form.
 */
export function welcomeEmail(input: WelcomeEmailInput): { subject: string; body: string } {
  const hospitals = [...new Set(input.links.map((l) => l.hospitalName))];
  const who = hospitals.join(' and ');
  const several = hospitals.length > 1;
  const codes = ORDER.filter((c) => input.links.some((l) => l.code === c));
  const accepted = codes.map((c) => (c === 'TTT' ? 'TtT (continuing)' : INITIATIVE_SHORT[c])).join(', ');
  const name = input.recipientName?.trim();
  const lines = input.links.map(
    (l) =>
      `– ${INITIATIVE_NAMES[l.code]}${l.code === 'TTT' ? ' (continuation form)' : ''}` +
      `${several ? ` for ${l.hospitalName}` : ''}, ${l.url}`,
  );
  return {
    subject: `CPCQC ${input.programYear} — ${who} ${several ? 'have' : 'has'} been accepted`,
    body: [
      `Hi ${name || 'there'},`,
      '',
      `Good news — ${who} ${several ? 'have' : 'has'} been accepted into the following initiative(s) for ${input.programYear}: ${accepted}.`,
      '',
      'Next step: complete an enrollment form for each initiative. Each initiative has its own form, and ' +
        `your hospital isn’t enrolled until each one is submitted and confirmed. ${ONE_PERSON}`,
      '',
      ...lines,
      '',
      ...(several
        ? [
            `${who} enrolled together as one hospital in ${input.programYear - 1}. For ${input.programYear}, ` +
              'each needs its own enrollment form, so please submit one for each.',
            '',
          ]
        : []),
      ...(codes.includes('TTT') ? [TTT_REQUIRED, ''] : []),
      input.closesAt
        ? `Enrollment forms must be submitted by ${longDate(input.closesAt)} to meet Colorado law.`
        : 'CPCQC will let you know when enrollment forms open.',
      '',
      'If anything has changed or if you have additional questions, please contact qi@cpcqc.org.',
    ].join('\n'),
  };
}


export interface AcceptanceEmailInput {
  submitterName: string;
  hospitalName: string;
  programYear: number;
  /** The initiatives CPCQC accepted the hospital into, in display order. */
  initiatives: FormInitiativeCode[];
  links: EnrollmentLink[];
  dates: EnrollmentDates;
}

export function acceptanceEmail(input: AcceptanceEmailInput): { subject: string; body: string } {
  if (input.links.length > 0) {
    return welcomeEmail({
      recipientName: input.submitterName,
      programYear: input.programYear,
      links: input.links.map((l) => ({ ...l, hospitalName: input.hospitalName })),
      closesAt: input.dates.closesAt,
    });
  }
  const accepted =
    input.initiatives.length > 0
      ? `into the following initiative(s) for ${input.programYear}: ${input.initiatives.join(', ')}`
      : `for ${input.programYear}`;
  const next =
    input.links.length > 0
      ? [
          'Next step: complete an enrollment form for each initiative. Each initiative has ' +
            "its own form, and your hospital isn't enrolled until each one is submitted and confirmed.",
          '',
          ...linkLines(input.links),
          '',
          datesLine(input.dates),
          '',
          'CPCQC will follow up with onboarding details and key dates.',
        ]
      : [
          "What's next: CPCQC will follow up with the detailed, initiative-specific " +
            'Enrollment Form(s) for each accepted initiative, along with onboarding ' +
            'details and key dates.',
        ];
  return {
    subject: `CPCQC ${input.programYear} — ${input.hospitalName} has been accepted`,
    body: [
      `Hi ${input.submitterName.trim()},`,
      '',
      `Good news — ${input.hospitalName} has been accepted ${accepted}.`,
      '',
      ...next,
      '',
      'Questions? qi@cpcqc.org',
    ].join('\n'),
  };
}

export interface EnrollmentFormEmailInput {
  /** Blank when staff typed only an address. */
  recipientName: string | null;
  hospitalName: string;
  programYear: number;
  links: EnrollmentLink[];
  dates: EnrollmentDates;
}

export function enrollmentFormEmail(input: EnrollmentFormEmailInput): {
  subject: string;
  body: string;
} {
  const one = input.links.length === 1;
  const name = input.recipientName?.trim();
  return {
    subject: one
      ? `${input.hospitalName}: CPCQC ${input.programYear} ${input.links[0]!.code} enrollment form`
      : `${input.hospitalName}: CPCQC ${input.programYear} enrollment forms`,
    body: [
      `Hi ${name || 'there'},`,
      '',
      one
        ? `Here is ${input.hospitalName}'s ${input.programYear} CPCQC enrollment form. ` +
          `Your hospital isn't enrolled until it is submitted and confirmed. ${ONE_PERSON}`
        : `Here are ${input.hospitalName}'s ${input.programYear} CPCQC enrollment forms, one for each initiative. ` +
          `Your hospital isn't enrolled in an initiative until its form is submitted and confirmed. ${ONE_PERSON}`,
      '',
      ...linkLines(input.links),
      '',
      ...(input.links.some((l) => l.code === 'TTT')
        ? [
            TTT_REQUIRED,
            '',
          ]
        : []),
      datesLine(input.dates),
      '',
      'Questions? qi@cpcqc.org',
      '',
      'Colorado Perinatal Care Quality Collaborative',
    ].join('\n'),
  };
}
