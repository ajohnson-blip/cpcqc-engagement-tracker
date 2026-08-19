'use client';

/**
 * READ-ONLY PREVIEW of the 2027 Enrollment Form (step 2) — a public link for the
 * team to review copy, layout and behaviour before the real form is built.
 *
 * Self-contained with mock data: it does NOT hit any API and saves nothing.
 * The real enrollment form does not exist yet; this is the design under review.
 *
 * Mirrors /interest-preview, which does the same job for step 1.
 *
 * Reviewer controls at the top switch initiative (to see the TtT continuation
 * variant, which replaces the whole form with an attestation) and window state.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CalendarDays, Eye, Copy, Info } from 'lucide-react';

const PROGRAM_YEAR = 2027;
const HOSPITAL_NAME = 'Sample Hospital';
const OPENS_AT = '2026-11-15';
const CLOSES_AT = '2026-12-01';

const INITIATIVES = [
  { code: 'SPARK', name: 'SPARK: Postpartum Discharge Transitions', emoji: '✨' },
  { code: 'SOAR', name: 'SOAR: Primary Cesarean Reduction', emoji: '🪁' },
  { code: 'NEST', name: 'NEST: Infant Safe Sleep', emoji: '🐣' },
  { code: 'TTT', name: 'Turning the Tide: Perinatal Substance Use', emoji: '🌅' },
] as const;

type Code = (typeof INITIATIVES)[number]['code'];
type WindowState = 'before' | 'open' | 'after';

const EHR_OPTIONS = ['Epic', 'Oracle Health (Cerner)', 'MEDITECH', 'Other…'];

/** Asterisked roles are required; "Other" is optional. */
const CHAMPION_ROLES = [
  {
    key: 'nurse',
    label: 'Nurse champion',
    required: true,
    description: 'This person is responsible for leading QI implementation using nursing perspective.',
  },
  {
    key: 'provider',
    label: 'Provider champion',
    required: true,
    description: 'This person is responsible for leading QI implementation using provider perspective.',
  },
  {
    key: 'data',
    label: 'Data champion',
    required: true,
    description: 'This person is responsible for collecting and submitting required data for this initiative.',
  },
  {
    key: 'csuite',
    label: 'C-suite sponsor',
    required: true,
    description: 'This person provides executive-level support for meeting CPCQC engagement requirements.',
  },
  { key: 'other', label: 'Other champion', required: false, description: '' },
] as const;

type RoleKey = (typeof CHAMPION_ROLES)[number]['key'];

interface Champion {
  name: string;
  email: string;
  title: string;
  redcap: boolean;
  dashboard: boolean;
}

const emptyChampion = (): Champion => ({ name: '', email: '', title: '', redcap: false, dashboard: false });

/** What a "copy from another initiative" prefill would pull in. */
const PREFILL_SOURCE: Record<RoleKey, Champion> = {
  nurse: { name: 'Dana Reyes, RN', email: 'dreyes@samplehospital.org', title: 'OB Nurse Manager', redcap: true, dashboard: true },
  provider: { name: 'Dr. Priya Shah', email: 'pshah@samplehospital.org', title: 'OB Hospitalist', redcap: false, dashboard: true },
  data: { name: 'Marcus Webb', email: 'mwebb@samplehospital.org', title: 'Clinical Data Analyst', redcap: true, dashboard: true },
  csuite: { name: 'Karen Liu', email: 'kliu@samplehospital.org', title: 'Chief Nursing Officer', redcap: false, dashboard: true },
  other: emptyChampion(),
};

function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function EnrollmentFormPreviewPage() {
  const [windowState, setWindowState] = useState<WindowState>('open');
  const [initiative, setInitiative] = useState<Code>('SOAR');
  const [ehr, setEhr] = useState('');
  const [ehrOther, setEhrOther] = useState('');
  const [champions, setChampions] = useState<Record<RoleKey, Champion>>({
    nurse: emptyChampion(),
    provider: emptyChampion(),
    data: emptyChampion(),
    csuite: emptyChampion(),
    other: emptyChampion(),
  });
  const [primary, setPrimary] = useState<RoleKey | ''>('');
  const [attested, setAttested] = useState(false);
  const [prefilled, setPrefilled] = useState(false);

  const isTTT = initiative === 'TTT';
  const formLocked = windowState !== 'open';
  const current = INITIATIVES.find((i) => i.code === initiative)!;

  function setChampion(role: RoleKey, patch: Partial<Champion>) {
    setChampions((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }));
  }

  /** Explicit, never automatic — hospitals often use different champions per
   *  initiative, so a silent prefill would produce a roster nobody chose. */
  function copyFromOtherInitiative() {
    setChampions({ ...PREFILL_SOURCE });
    setPrimary('nurse');
    setPrefilled(true);
  }

  const validationErrors = useMemo(() => {
    const errs: string[] = [];
    if (isTTT) {
      if (!attested) errs.push('Confirm the continuation attestation to submit.');
      return errs;
    }
    if (!ehr) errs.push('Select your hospital EHR.');
    if (ehr === 'Other…' && !ehrOther.trim()) errs.push('Tell us which EHR your hospital uses.');
    for (const role of CHAMPION_ROLES) {
      if (!role.required) continue;
      const c = champions[role.key];
      if (!c.name.trim() || !c.email.trim() || !c.title.trim()) {
        errs.push(`${role.label}: name, email and hospital title are all required.`);
      }
    }
    if (!primary) errs.push('Mark exactly one champion as the primary contact.');
    return errs;
  }, [isTTT, attested, ehr, ehrOther, champions, primary]);

  return (
    <div className="min-h-screen bg-cpcqc-cream">
      {/* Reviewer controls — not part of the real form */}
      <div className="border-b border-amber-300 bg-amber-50">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-amber-900">
            <Eye size={16} aria-hidden />
            Read-only preview — nothing is saved. Design under review; not yet built.
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-amber-900">
              Initiative
              <select
                value={initiative}
                onChange={(e) => setInitiative(e.target.value as Code)}
                className="rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-semibold text-amber-900"
              >
                {INITIATIVES.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.code}
                    {i.code === 'TTT' ? ' (continuation)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-amber-900">
              Window
              <select
                value={windowState}
                onChange={(e) => setWindowState(e.target.value as WindowState)}
                className="rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-semibold text-amber-900"
              >
                <option value="before">Before</option>
                <option value="open">Open</option>
                <option value="after">After (closed)</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6">
          <p className="font-rounded text-xs font-bold uppercase tracking-[0.15em] text-cpcqc-purple-dark/60">
            Step 2 of 2
          </p>
          <h1 className="mt-1 font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
            {PROGRAM_YEAR} Enrollment — {current.emoji} {current.code}
          </h1>
          <p className="mt-2 max-w-2xl text-cpcqc-purple-dark/80">
            {isTTT ? (
              <>
                Turning the Tide is a two-year cohort. Your hospital continues through{' '}
                {PROGRAM_YEAR} to complete it — confirm below rather than enrolling again.
              </>
            ) : (
              <>
                Complete this form to enroll {HOSPITAL_NAME} in {current.code} for {PROGRAM_YEAR}.
                Each initiative has its own enrollment form, so repeat this for any other
                initiative you were accepted into.
              </>
            )}
          </p>
        </header>

        {/* Window banner */}
        <div
          className={
            'mb-6 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ' +
            (windowState === 'after'
              ? 'bg-cpcqc-pink-dark/10 text-cpcqc-pink-dark'
              : windowState === 'before'
                ? 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark'
                : 'bg-cpcqc-teal-dark/10 text-cpcqc-purple-dark')
          }
        >
          <CalendarDays size={16} className="shrink-0" aria-hidden />
          <span>
            {windowState === 'before' && (
              <>
                <strong>Enrollment opens</strong> {fmtDate(OPENS_AT)} and closes{' '}
                {fmtDate(CLOSES_AT)}.
              </>
            )}
            {windowState === 'open' && (
              <>
                <strong>Enrollment is open</strong> through {fmtDate(CLOSES_AT)}.
              </>
            )}
            {windowState === 'after' && (
              <>
                <strong>Enrollment closed</strong> on {fmtDate(CLOSES_AT)}. Contact CPCQC if you
                still need to enroll.
              </>
            )}
          </span>
        </div>

        <div className="mb-6 flex gap-2 rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/20 px-4 py-3 text-sm text-cpcqc-purple-dark/80">
          <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
          <p>
            <strong className="text-cpcqc-purple-dark">
              Enrollment forms are due {fmtDate(CLOSES_AT)}.
            </strong>{' '}
            This is the step required under Colorado law — a hospital without a submitted
            enrollment form is not enrolled, regardless of what it ranked on the interest form.
          </p>
        </div>

        <form
          onSubmit={(e: FormEvent) => e.preventDefault()}
          className={'space-y-6 ' + (formLocked ? 'opacity-60' : '')}
        >
          <fieldset disabled={formLocked} className="space-y-6">
            {isTTT ? (
              <Section
                title="Continuation attestation"
                description="Turning the Tide runs 2026–2027 as a single cohort, so there's nothing to re-enroll — just confirm you're continuing."
              >
                <label className="flex cursor-pointer gap-3 rounded-xl border-2 border-cpcqc-purple/40 bg-white p-4">
                  <input
                    type="checkbox"
                    checked={attested}
                    onChange={(e) => setAttested(e.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span className="text-sm text-cpcqc-purple-dark/90">
                    Our hospital attests that it is continuing its participation in Turning the
                    Tide in {PROGRAM_YEAR} to complete the 2-year cohort. Any champion roster
                    updates should be communicated to{' '}
                    <a className="underline" href="mailto:turningthetide@cpcqc.org">
                      turningthetide@cpcqc.org
                    </a>
                    .
                  </span>
                </label>
              </Section>
            ) : (
              <>
                <Section title="Hospital">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Hospital">
                      <div className="form-input flex items-center bg-cpcqc-cream-dark/30 text-cpcqc-purple-dark">
                        {HOSPITAL_NAME}
                      </div>
                    </Field>
                    <Field label="Initiative">
                      <div className="form-input flex items-center bg-cpcqc-cream-dark/30 text-cpcqc-purple-dark">
                        {current.name}
                      </div>
                    </Field>
                  </div>
                  <div className="mt-4">
                    <Field label="Hospital EHR" required>
                      <select
                        value={ehr}
                        onChange={(e) => setEhr(e.target.value)}
                        className="form-input"
                      >
                        <option value="">Select…</option>
                        {EHR_OPTIONS.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {ehr === 'Other…' && (
                      <div className="mt-2">
                        <input
                          value={ehrOther}
                          onChange={(e) => setEhrOther(e.target.value)}
                          placeholder="Which EHR does your hospital use?"
                          className="form-input"
                        />
                      </div>
                    )}
                  </div>
                </Section>

                <Section
                  title="Key champions"
                  description="Name, email and hospital title are required for each starred role. Mark exactly one person as the primary contact — that's who CPCQC reaches first."
                >
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-cpcqc-cream-dark/30 px-3 py-2">
                    <Copy size={14} className="text-cpcqc-purple-dark/70" aria-hidden />
                    <span className="text-xs text-cpcqc-purple-dark/80">
                      Enrolling in more than one initiative?
                    </span>
                    <button
                      type="button"
                      onClick={copyFromOtherInitiative}
                      className="rounded-full border border-cpcqc-purple px-3 py-1 text-xs font-bold text-cpcqc-purple transition hover:bg-cpcqc-purple/10"
                    >
                      Copy champions from SPARK
                    </button>
                    <span className="text-xs text-cpcqc-purple-dark/60">
                      You can edit every field afterwards.
                    </span>
                  </div>
                  {prefilled && (
                    <p className="mb-3 text-xs text-cpcqc-teal-dark">
                      Champions copied from SPARK — please review, since roles often differ by
                      initiative.
                    </p>
                  )}

                  <div className="space-y-3">
                    {CHAMPION_ROLES.map((role) => {
                      const c = champions[role.key];
                      return (
                        <div
                          key={role.key}
                          className="rounded-xl border-2 border-cpcqc-purple-dark/15 bg-white p-3"
                        >
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <span className="font-rounded text-sm font-bold text-cpcqc-purple-dark">
                              {role.label}
                              {role.required ? (
                                <span className="ml-0.5 text-cpcqc-pink-dark">*</span>
                              ) : (
                                <span className="ml-1 text-xs font-normal text-cpcqc-purple-dark/50">
                                  (optional)
                                </span>
                              )}
                            </span>
                            <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-cpcqc-purple-dark/80">
                              <input
                                type="radio"
                                name="primary"
                                checked={primary === role.key}
                                onChange={() => setPrimary(role.key)}
                                className="h-3.5 w-3.5"
                              />
                              Primary contact
                            </label>
                          </div>
                          {role.description && (
                            <p className="mb-2 text-xs text-cpcqc-purple-dark/60">
                              {role.description}
                            </p>
                          )}
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            <input
                              value={c.name}
                              onChange={(e) => setChampion(role.key, { name: e.target.value })}
                              placeholder="Name"
                              className="form-input"
                            />
                            <input
                              type="email"
                              value={c.email}
                              onChange={(e) => setChampion(role.key, { email: e.target.value })}
                              placeholder="Email"
                              className="form-input"
                            />
                            <input
                              value={c.title}
                              onChange={(e) => setChampion(role.key, { title: e.target.value })}
                              placeholder="Hospital title"
                              className="form-input"
                            />
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                            <label className="inline-flex items-center gap-2 text-xs text-cpcqc-purple-dark/80">
                              <input
                                type="checkbox"
                                checked={c.redcap}
                                onChange={(e) => setChampion(role.key, { redcap: e.target.checked })}
                                className="h-3.5 w-3.5"
                              />
                              Needs REDCap access for data entry
                            </label>
                            <label className="inline-flex items-center gap-2 text-xs text-cpcqc-purple-dark/80">
                              <input
                                type="checkbox"
                                checked={c.dashboard}
                                onChange={(e) => setChampion(role.key, { dashboard: e.target.checked })}
                                className="h-3.5 w-3.5"
                              />
                              Needs access to your hospital&rsquo;s QI data dashboard
                            </label>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <p className="mt-3 text-xs text-cpcqc-purple-dark/60">
                    REDCap access is requested here and granted by CPCQC separately — we&rsquo;ll
                    follow up with anyone marked above.
                  </p>
                </Section>
              </>
            )}

            {validationErrors.length > 0 && !formLocked && (
              <div className="rounded-xl bg-cpcqc-orange-dark/10 p-4">
                <p className="flex items-center gap-2 text-sm font-bold text-cpcqc-orange-dark">
                  <AlertTriangle size={16} aria-hidden /> Before you can submit
                </p>
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-cpcqc-orange-dark">
                  {validationErrors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="submit"
              disabled
              className="w-full rounded-lg bg-cpcqc-purple px-4 py-2.5 font-rounded font-bold text-white opacity-60"
            >
              {isTTT ? 'Submit continuation attestation' : `Enroll in ${current.code}`} (disabled in
              preview)
            </button>
          </fieldset>
        </form>
      </main>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-1 font-rounded text-lg font-extrabold text-cpcqc-purple-dark">{title}</h2>
      {description && <p className="mb-3 text-sm text-cpcqc-purple-dark/70">{description}</p>}
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        {label}
        {required && <span className="ml-0.5 text-cpcqc-pink-dark">*</span>}
      </span>
      {children}
    </label>
  );
}
