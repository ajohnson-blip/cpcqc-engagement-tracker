'use client';

/**
 * READ-ONLY PREVIEW of the annual interest form — a distinct, public link for
 * reviewing the form's copy + layout without signing in as a hospital or
 * opening the enrollment window. Self-contained with mock data; it does NOT
 * import the real form, hit any API, or save anything. Not linked from the app.
 *
 * The real form lives at /portal/interest/[year] (hospital-gated). This mirrors
 * its content so CPCQC can review "as is." Toggle the window state to see the
 * before / open / after banners.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, CalendarDays, Eye } from 'lucide-react';

const PROGRAM_YEAR = 2027;
const HOSPITAL_NAME = 'Sample Hospital';
const OPENS_AT = '2026-09-15';
const CLOSES_AT = '2026-10-15';

const RANKABLE_INITIATIVES = [
  { code: 'SPARK', name: 'SPARK: Postpartum Discharge Transitions', emoji: '✨' },
  { code: 'SOAR', name: 'SOAR: Primary Cesarean Reduction', emoji: '🪁' },
  { code: 'NEST', name: 'NEST: Infant Safe Sleep', emoji: '🐣' },
] as const;

type Code = (typeof RANKABLE_INITIATIVES)[number]['code'];
type Rank = 1 | 2 | 3 | '';
type WindowState = 'before' | 'open' | 'after';

function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function InterestFormPreviewPage() {
  const [windowState, setWindowState] = useState<WindowState>('open');
  const [submitterName, setSubmitterName] = useState('');
  const [submitterRole, setSubmitterRole] = useState('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  const [intendedCount, setIntendedCount] = useState<1 | 2 | ''>('');
  const [ranks, setRanks] = useState<Record<Code, Rank>>({ SPARK: '', SOAR: '', NEST: '' });
  const [whys, setWhys] = useState<Record<Code, string>>({ SPARK: '', SOAR: '', NEST: '' });

  const formLocked = windowState !== 'open';

  const takenRanks = useMemo(() => {
    const t = new Set<number>();
    for (const c of Object.keys(ranks) as Code[]) {
      const r = ranks[c];
      if (typeof r === 'number') t.add(r);
    }
    return t;
  }, [ranks]);

  const validationErrors: string[] = [];
  if (!submitterName.trim()) validationErrors.push('Your name is required.');
  if (!submitterRole.trim()) validationErrors.push('Your role is required.');
  if (!submitterEmail.trim()) validationErrors.push('Email is required.');
  if (intendedCount === '') validationErrors.push('Tell us how many initiatives you intend to enroll in.');
  // Mirrors the live form: all three ranked, each rank unique, and a "why" for
  // the top two. Without this the preview let reviewers submit with a single
  // rank, which made the real form look far more permissive than it is.
  const ranksFilled = (Object.keys(ranks) as Code[]).filter((c) => ranks[c] !== '').length;
  if (ranksFilled < RANKABLE_INITIATIVES.length) {
    validationErrors.push(`Rank all ${RANKABLE_INITIATIVES.length} initiatives from 1 to ${RANKABLE_INITIATIVES.length}.`);
  }
  if (ranksFilled === RANKABLE_INITIATIVES.length && takenRanks.size !== RANKABLE_INITIATIVES.length) {
    validationErrors.push(`Each initiative needs a unique rank from 1 to ${RANKABLE_INITIATIVES.length}.`);
  }
  if (ranksFilled === RANKABLE_INITIATIVES.length && takenRanks.size === RANKABLE_INITIATIVES.length) {
    const byRank = new Map<number, Code>();
    for (const c of Object.keys(ranks) as Code[]) {
      const r = ranks[c];
      if (typeof r === 'number') byRank.set(r, c);
    }
    const top = byRank.get(1);
    const second = byRank.get(2);
    if (top && !whys[top].trim()) validationErrors.push(`Tell us why ${top} is your top choice.`);
    if (second && !whys[second].trim()) {
      validationErrors.push(`Tell us why ${second} is your second choice.`);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Preview only — no-op.
  }

  return (
    <div className="min-h-screen bg-cpcqc-cream">
      {/* Preview banner (not part of the real form) */}
      <div className="border-b border-amber-300 bg-amber-50">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-amber-900">
            <Eye size={16} aria-hidden />
            Read-only preview — nothing is saved. Not linked from the app.
          </div>
          <label className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-amber-900">
            Window state
            <select
              value={windowState}
              onChange={(e) => setWindowState(e.target.value as WindowState)}
              className="rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-semibold text-amber-900"
            >
              <option value="before">Before (not open yet)</option>
              <option value="open">Open</option>
              <option value="after">After (closed)</option>
            </select>
          </label>
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6">
          <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
            Express interest in {PROGRAM_YEAR} CPCQC initiatives
          </h1>
          <p className="mt-2 max-w-2xl text-cpcqc-purple-dark/80">
            This is step one of CPCQC&rsquo;s two-step annual enrollment. Tell us which initiatives
            you&rsquo;re considering for {PROGRAM_YEAR} and rank your preferences. CPCQC reviews all
            interest forms together to set cohort size and mix, then follows up with the detailed
            initiative-specific Enrollment Forms for the programs you&rsquo;re accepted into.
          </p>
        </header>

        <div className="mb-6 space-y-2 rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/20 px-4 py-3 text-sm text-cpcqc-purple-dark/80">
          <p>
            <strong className="text-cpcqc-purple-dark">New for {PROGRAM_YEAR}:</strong> CPCQC is
            limiting enrollment to two QI initiatives per hospital each year — to protect hospital
            staff and CPCQC&rsquo;s capacity to support high-quality QI implementation.
          </p>
          <p>
            Under Colorado law (C.R.S. § 25-52-106.5(6)(a)(II)), hospitals are only required to
            actively engage in one QI initiative per year. Ranking additional initiatives below is
            optional — it helps CPCQC plan cohort sizes, but you&rsquo;re not obligated to
            participate in more than one.
          </p>
          {/* In the real form this appears beside the hospital's current
              enrollments; shown here so reviewers can see the wording. */}
          <p>
            <strong className="text-cpcqc-purple-dark">
              Current enrollments do not carry over automatically.
            </strong>{' '}
            SPARK, SOAR and NEST run one year at a time. To take part in {PROGRAM_YEAR}, rank the
            initiative below and submit its enrollment form in November — even if you&rsquo;re
            enrolled in it today. Turning the Tide is the exception, as a two-year cohort.
          </p>
        </div>

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
                <strong>The {PROGRAM_YEAR} interest window opens</strong> on {fmtDate(OPENS_AT)} and
                runs through {fmtDate(CLOSES_AT)}. You can preview the form below; we&rsquo;ll accept
                submissions when the window opens.
              </>
            )}
            {windowState === 'open' && (
              <>
                <strong>Interest forms are accepted</strong> {fmtDate(OPENS_AT)} through{' '}
                {fmtDate(CLOSES_AT)}.
              </>
            )}
            {windowState === 'after' && (
              <>
                <strong>The {PROGRAM_YEAR} interest window closed</strong> on {fmtDate(CLOSES_AT)}.
                Contact CPCQC if you missed the window and need to submit late.
              </>
            )}
          </span>
        </div>

        <form onSubmit={onSubmit} className={'space-y-6 ' + (formLocked ? 'opacity-60' : '')}>
          <fieldset disabled={formLocked} className="space-y-6">
            <Section title="About you">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Name" required>
                  <input
                    type="text"
                    value={submitterName}
                    onChange={(e) => setSubmitterName(e.target.value)}
                    className="form-input"
                  />
                </Field>
                <Field label="Hospital">
                  <div className="form-input flex items-center justify-between bg-cpcqc-cream-dark/30 text-cpcqc-purple-dark">
                    <span>{HOSPITAL_NAME}</span>
                    <span className="text-xs text-cpcqc-purple-dark/60">From your account</span>
                  </div>
                </Field>
                <Field label="Your role" required>
                  <input
                    type="text"
                    placeholder="e.g. OB Director, QI Lead"
                    value={submitterRole}
                    onChange={(e) => setSubmitterRole(e.target.value)}
                    className="form-input"
                  />
                </Field>
                <Field label="Email" required>
                  <input
                    type="email"
                    value={submitterEmail}
                    onChange={(e) => setSubmitterEmail(e.target.value)}
                    className="form-input"
                  />
                </Field>
              </div>
            </Section>

            <Section
              title="Your enrollment intent"
              description={`Hospitals can enroll in up to 2 initiatives for ${PROGRAM_YEAR}.`}
            >
              <Field label={`How many initiatives do you intend to enroll in for ${PROGRAM_YEAR}?`} required>
                <select
                  value={intendedCount}
                  onChange={(e) =>
                    setIntendedCount(e.target.value === '' ? '' : (parseInt(e.target.value, 10) as 1 | 2))
                  }
                  className="form-input"
                >
                  <option value="">Select…</option>
                  {[1, 2].map((n) => (
                    <option key={n} value={n}>
                      {n} initiative(s)
                    </option>
                  ))}
                </select>
              </Field>
            </Section>

            <div className="rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/30 p-4">
              <h3 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
                About Turning the Tide (TTT)
              </h3>
              <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
                TTT is a two-year cohort running 2026–{PROGRAM_YEAR}, and CPCQC is{' '}
                <strong>not enrolling new TTT hospitals</strong> for {PROGRAM_YEAR} — so it
                doesn&rsquo;t appear in the ranking below. If your hospital is currently enrolled in
                TTT, you&rsquo;ll continue through {PROGRAM_YEAR} to complete the cohort. CPCQC will
                send the {PROGRAM_YEAR} TTT Enrollment Continuation Form to all current TTT
                hospitals in mid-November, at the same time as every other enrollment form.
              </p>
              <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
                Annual enrollment forms are a legal requirement even for multi-year cohorts.
              </p>
            </div>

            <Section
              title="Rank the initiatives"
              description={`Rank all 3 from 1 (your top choice) to 3 (lowest). Your ranking helps CPCQC understand which initiatives are the highest priority for your hospital and supports planning for the upcoming enrollment year. The top two will be highlighted — we ask for a brief "why" on your top two so the cohort review has the context it needs.`}
            >
              <div className="space-y-3">
                {RANKABLE_INITIATIVES.map((init) => {
                  const code = init.code;
                  const rank = ranks[code];
                  const isTop2 = rank === 1 || rank === 2;
                  return (
                    <div
                      key={code}
                      className={
                        'rounded-xl border-2 p-3 transition ' +
                        (isTop2 ? 'border-cpcqc-purple bg-cpcqc-purple/5' : 'border-cpcqc-purple-dark/15 bg-white')
                      }
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex flex-1 items-center gap-2">
                          <span aria-hidden className="text-xl">
                            {init.emoji}
                          </span>
                          <div>
                            <div className="font-rounded font-bold text-cpcqc-purple-dark">{init.code}</div>
                            <div className="text-xs text-cpcqc-purple-dark/70">{init.name}</div>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-cpcqc-purple-dark/80">
                          Rank
                          <select
                            value={rank}
                            onChange={(e) =>
                              setRanks((prev) => ({
                                ...prev,
                                [code]: e.target.value === '' ? '' : (parseInt(e.target.value, 10) as 1 | 2 | 3),
                              }))
                            }
                            className="form-input w-24"
                            aria-label={`Rank for ${init.code}`}
                          >
                            <option value="">—</option>
                            {[1, 2, 3].map((n) => {
                              const takenByOther = takenRanks.has(n) && rank !== n;
                              return (
                                <option key={n} value={n} disabled={takenByOther}>
                                  {n}
                                  {takenByOther ? ' (taken)' : ''}
                                </option>
                              );
                            })}
                          </select>
                        </label>
                      </div>
                      {isTop2 && (
                        <div className="mt-3">
                          <label className="block">
                            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                              Why is {code} your {rank === 1 ? 'top' : 'second'} choice?{' '}
                              <span className="text-cpcqc-pink-dark">*</span>
                            </span>
                            <span className="mb-1 block text-xs font-normal normal-case text-cpcqc-purple-dark/60">
                              If you can point to data that supports your choice, please share it —
                              it helps us understand your needs.
                            </span>
                            <textarea
                              rows={3}
                              value={whys[code]}
                              onChange={(e) => setWhys((prev) => ({ ...prev, [code]: e.target.value }))}
                              placeholder={
                                rank === 1
                                  ? 'What makes this the right top priority for your hospital this year?'
                                  : 'Why is this also a high priority for you?'
                              }
                              className="form-input"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>

            {validationErrors.length > 0 && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark"
              >
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <ul className="list-disc pl-4">
                  {validationErrors.map((msg) => (
                    <li key={msg}>{msg}</li>
                  ))}
                </ul>
              </div>
            )}

            <button
              type="submit"
              disabled
              title="Disabled in preview"
              className="w-full rounded-lg bg-cpcqc-purple px-4 py-2.5 font-rounded font-bold text-white opacity-50"
            >
              Submit interest form (disabled in preview)
            </button>
          </fieldset>
        </form>
      </main>

      <style jsx>{`
        :global(.form-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(106, 101, 135, 0.2);
          background-color: white;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: rgb(46, 39, 87);
        }
        :global(.form-input:focus) {
          outline: none;
          border-color: rgb(106, 101, 135);
          box-shadow: 0 0 0 3px rgba(106, 101, 135, 0.15);
        }
      `}</style>
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
