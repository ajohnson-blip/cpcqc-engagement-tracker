/**
 * The other CPCQC systems hospitals sign in to, linked from the portal.
 *
 * Each has its own login: CPCQC hasn't been able to put these behind a single
 * sign-on, so the portal at least gets hospitals to the right front door and
 * says what each one is for.
 *
 * A tool shows only once it has a URL. Power BI waits for January, when all
 * four initiatives' dashboards are on it rather than split with Tableau; to
 * turn it on, set its url below.
 */

export interface DataTool {
  key: string;
  name: string;
  /** Null hides the tool everywhere. */
  url: string | null;
  /** One line on what hospitals use it for. */
  purpose: string;
  /** How a hospital gets access. The card already says each has its own login. */
  access: string;
}

export const DATA_TOOLS: DataTool[] = [
  {
    key: 'redcap',
    name: 'REDCap',
    url: 'https://redcap.vumc.org/',
    purpose:
      'Where your team enters QI data for each initiative and completes Hospital Readiness Assessments.',
    access: 'CPCQC grants REDCap access. For access or help, email data@cpcqc.org.',
  },
  {
    key: 'powerbi',
    name: 'Power BI',
    url: null,
    purpose: "Your hospital's QI data dashboards.",
    access: 'CPCQC grants dashboard access. For access or help, email data@cpcqc.org.',
  },
];

export const LIVE_DATA_TOOLS = DATA_TOOLS.filter(
  (t): t is DataTool & { url: string } => t.url !== null,
);
