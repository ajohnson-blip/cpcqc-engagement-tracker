/**
 * The welcome-to-enroll email.
 *
 * All of its wording lives here, in one place, so CPCQC can revise it without
 * hunting through modules. It goes out when staff upload the year's
 * acceptances, from the interest-form screen's accept, and as a single send
 * or resend from the enrollment-forms screen, so a hospital reads the same
 * email however it reaches them.
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

const ORDER: FormInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];

// -------- Rendering --------

/** A named link: the bare URL in the plain-text part, `label` in the HTML. */
interface LinkSegment {
  label: string;
  url: string;
}
type Line = Array<string | LinkSegment>;
/** An email as paragraphs of lines, so it can be written once and sent both ways. */
type Paragraph = Line[];

export interface RenderedEmail {
  subject: string;
  /** Plain text, with bare URLs, for mail programs that show only text. */
  body: string;
  /** The same email with each link named, e.g. "NEST Enrollment Form". */
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(subject: string, paragraphs: Paragraph[]): RenderedEmail {
  const text = (line: Line) => line.map((seg) => (typeof seg === 'string' ? seg : seg.url)).join('');
  const html = (line: Line) =>
    line
      .map((seg) =>
        typeof seg === 'string'
          ? escapeHtml(seg)
          : `<a href="${escapeHtml(seg.url)}" style="color:#6B529B;font-weight:bold;">${escapeHtml(seg.label)}</a>`,
      )
      .join('');
  return {
    subject,
    body: paragraphs.map((p) => p.map(text).join('\n')).join('\n\n'),
    html:
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#2a2536;">' +
      paragraphs.map((p) => `<p style="margin:0 0 14px;">${p.map(html).join('<br>')}</p>`).join('') +
      '</div>',
  };
}

/** "SPARK, SOAR and TtT", for sentences about initiatives. */
function listCodes(codes: FormInitiativeCode[]): string {
  const n = codes.map((c) => INITIATIVE_SHORT[c]);
  return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

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
  /**
   * Everything the hospital was accepted into, which a team's email lists in
   * full though it links only that team's form. Defaults to the linked ones.
   */
  accepted?: FormInitiativeCode[];
  /**
   * Sent to one initiative's team, whose colleagues get the other forms. The
   * greeting then names the team, "Hi Denver Health Medical Center NEST
   * champions", not a person: no one of them is the one who must file it.
   */
  forTeam?: boolean;
  /** The enrollment window's last day (ISO), or null when not yet set. */
  closesAt: string | null;
}

/**
 * "Welcome to enroll": the hospital's acceptances, with a link to each
 * enrollment form the reader is responsible for. A team's email names every
 * initiative the hospital was accepted into, so the NEST team isn't left
 * wondering about the rest, but links only NEST's form. A roster that covers
 * two sites (UCHealth Memorial Central and North, one hospital in 2026) gets
 * both sites' links in one email, and is told each site files its own form.
 */
export function welcomeEmail(input: WelcomeEmailInput): RenderedEmail {
  const hospitals = [...new Set(input.links.map((l) => l.hospitalName))];
  const who = hospitals.join(' and ');
  const several = hospitals.length > 1;
  const linked = ORDER.filter((c) => input.links.some((l) => l.code === c));
  const accepted = ORDER.filter((c) => (input.accepted ?? linked).includes(c) || linked.includes(c));
  const others = accepted.filter((c) => !linked.includes(c));
  const name = input.forTeam ? `${who} ${listCodes(linked)} champions` : input.recipientName?.trim();
  const acceptedList = accepted.map((c) => (c === 'TTT' ? 'TtT (continuing)' : INITIATIVE_SHORT[c])).join(', ');

  const paragraphs: Paragraph[] = [
    [[`Hi ${name || 'there'},`]],
    [
      [
        `Good news — ${who} ${several ? 'have' : 'has'} been accepted into the following ` +
          `initiative(s) for ${input.programYear}: ${acceptedList}.`,
      ],
    ],
    [
      [
        'Next step: complete an enrollment form for each initiative. Each initiative has its own form, and ' +
          `your hospital isn’t enrolled until each one is submitted. ${ONE_PERSON}`,
      ],
    ],
    ...(input.forTeam && others.length > 0
      ? [
          [
            [
              `This email has your ${listCodes(linked)} enrollment form${linked.length > 1 ? 's' : ''}. ` +
                (others.length === 1
                  ? `The ${listCodes(others)} form goes to that initiative’s team.`
                  : `The ${listCodes(others)} forms go to those initiatives’ teams.`),
            ],
          ],
        ]
      : []),
    input.links.map((l) => [
      `– ${INITIATIVE_NAMES[l.code]}${l.code === 'TTT' ? ' (continuation form)' : ''}` +
        `${several ? ` for ${l.hospitalName}` : ''}, `,
      {
        label: `${INITIATIVE_SHORT[l.code]} Enrollment Form${several ? `: ${l.hospitalName}` : ''}`,
        url: l.url,
      },
    ]),
    ...(several
      ? [
          [
            [
              `${who} enrolled together as one hospital in ${input.programYear - 1}. For ${input.programYear}, ` +
                'each needs its own enrollment form, so please submit one for each.',
            ],
          ],
        ]
      : []),
    ...(linked.includes('TTT') ? [[[TTT_REQUIRED]]] : []),
    [
      [
        input.closesAt
          ? `Enrollment forms must be submitted by ${longDate(input.closesAt)} to meet Colorado law.`
          : 'CPCQC will let you know when enrollment forms open.',
      ],
    ],
    [['If anything has changed or if you have additional questions, please contact qi@cpcqc.org.']],
  ];
  return render(
    `CPCQC ${input.programYear} — ${who} ${several ? 'have' : 'has'} been accepted`,
    paragraphs,
  );
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

export function acceptanceEmail(input: AcceptanceEmailInput): RenderedEmail {
  if (input.links.length > 0) {
    return welcomeEmail({
      recipientName: input.submitterName,
      programYear: input.programYear,
      links: input.links.map((l) => ({ ...l, hospitalName: input.hospitalName })),
      accepted: input.initiatives,
      closesAt: input.dates.closesAt,
    });
  }
  const accepted =
    input.initiatives.length > 0
      ? `into the following initiative(s) for ${input.programYear}: ${input.initiatives.join(', ')}`
      : `for ${input.programYear}`;
  return render(`CPCQC ${input.programYear} — ${input.hospitalName} has been accepted`, [
    [[`Hi ${input.submitterName.trim()},`]],
    [[`Good news — ${input.hospitalName} has been accepted ${accepted}.`]],
    [
      [
        "What's next: CPCQC will follow up with the detailed, initiative-specific " +
          'Enrollment Form(s) for each accepted initiative, along with onboarding ' +
          'details and key dates.',
      ],
    ],
    [['Questions? qi@cpcqc.org']],
  ]);
}

export interface ReceiptEmailInput {
  submitterName: string;
  hospitalName: string;
  initiativeCode: FormInitiativeCode;
  programYear: number;
  /** Reopens the submitted form for changes. */
  editUrl: string;
  /** The enrollment window's last day (ISO), or null when not yet set. */
  closesAt: string | null;
}

/**
 * The receipt a hospital gets the moment it submits. The enrollment counts
 * from then, so there is nothing more to click; the email carries the link
 * for making changes until the deadline. The first paragraph is CPCQC's own
 * wording.
 */
export function receiptEmail(input: ReceiptEmailInput): RenderedEmail {
  const code = INITIATIVE_SHORT[input.initiativeCode];
  return render(`${code} enrollment received — ${input.hospitalName}`, [
    [[`Hi ${input.submitterName.trim()},`]],
    [
      [
        'Your enrollment form has been received and the program manager will be in contact ' +
          'with next steps. If you need support, please contact qi@cpcqc.org',
      ],
    ],
    [[`Hospital: ${input.hospitalName}`], [`Initiative: ${INITIATIVE_NAMES[input.initiativeCode]}`], [`Program year: ${input.programYear}`]],
    [
      [
        `To change anything${input.closesAt ? ` before ${longDate(input.closesAt)}` : ''}, use this link: `,
        { label: 'Edit your enrollment form', url: input.editUrl },
      ],
    ],
    [
      [
        'Keep this email: the link is how you change this submission. ' +
          'If you didn’t submit this form, please let us know at qi@cpcqc.org.',
      ],
    ],
    [['Colorado Perinatal Care Quality Collaborative']],
  ]);
}
