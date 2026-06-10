'use client';

/**
 * MOCK / PREVIEW — 2027 annual interest form (no backend wired yet).
 *
 * What this form is for:
 * Step 1 of CPCQC's 2-step annual enrollment flow. Hospitals submit this
 * single form to indicate which initiatives they want to be considered for
 * in the upcoming year and rank their preferences. CPCQC reviews the
 * submissions, decides cohort size + mix, then sends a separate, detailed,
 * initiative-specific Enrollment Form to each accepted hospital.
 *
 * Submit doesn't talk to any API yet — it dumps the structured payload
 * inline so PMs can review the data shape before we commit to a schema,
 * route, and persistence layer.
 *
 * Once approved, the plan would be:
 *   - move this to /interest (replacing the per-initiative form)
 *   - add a Drizzle model `annual_interest_forms` with the ranked array as JSONB
 *   - POST /interest-forms route with zod validation
 *   - notify qi@cpcqc.org via the existing notifications.service
 */

import { useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CheckCircle2, AlertTriangle, CalendarDays } from 'lucide-react';
import { Logo } from '@/components/logo';
import { useAuth } from '@/lib/auth-context';

// The 2027 ranking pool is SPARK / SOAR / NEST only. TTT is a 2-year cohort
// running 2026–2027, so we are NOT enrolling new TTT hospitals for 2027 —
// current TTT hospitals continue automatically (see the TTT continuation
// note in the form). When TTT reopens for new enrollment in a future year,
// add it back to RANKABLE_INITIATIVES.
const RANKABLE_INITIATIVES = [
  { code: 'SPARK', name: 'SPARK: Postpartum Discharge Transitions', emoji: '✨' },
  { code: 'SOAR',  name: 'SOAR: Primary Cesarean Reduction',         emoji: '🪁' },
  { code: 'NEST',  name: 'NEST: Infant Safe Sleep',                  emoji: '🐣' },
] as const;
const TOTAL_RANKS = RANKABLE_INITIATIVES.length;

const PROGRAM_YEAR = 2027;

// CPCQC caps hospitals at 2 initiatives for 2027 — they still rank all 3 so
// CPCQC has a fallback if their top choice is oversubscribed.
const MAX_INITIATIVES_PER_HOSPITAL = 2;

// MOCK acceptance window — when this form goes live, these dates move to a
// config row (one per program year) so PMs can edit them in the staff UI
// without a redeploy. Inclusive on both ends. The Overview-page banner and
// the inline "accepted from X to Y" label both read from here.
const INTEREST_WINDOW = {
  opensAt: '2026-09-15',
  closesAt: '2026-10-15',
} as const;

function fmtWindowDate(iso: string): string {
  // Render an ISO date as "Aug 1, 2026" without spinning up date-fns just
  // for this one line. UTC noon to dodge any timezone-edge weirdness.
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

type InitiativeCode = (typeof RANKABLE_INITIATIVES)[number]['code'];

// Empty-string rank means "not yet picked" so the dropdown can show a
// placeholder; once submitted, every value will be 1–TOTAL_RANKS.
type Rank = 1 | 2 | 3 | '';

export default function AnnualInterestPreviewPage() {
  // The real form will be hospital-sign-in-only, so Hospital comes from the
  // signed-in user's auth context rather than a free-text field. This mock
  // demonstrates that flow: if the visitor is signed in we lock the field
  // to their hospital; if not (browsing the public preview URL) we fall
  // back to a manual input so PMs can still review the form shape.
  const { hospitalName } = useAuth();
  const hospitalLocked = hospitalName !== null && hospitalName.trim() !== '';

  // About you
  const [name, setName] = useState('');
  const [hospital, setHospital] = useState(hospitalLocked ? hospitalName! : '');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');

  // Intent count is capped at MAX_INITIATIVES_PER_HOSPITAL (=2 for 2027).
  // Decoupled from the ranking: a hospital still ranks all 3 even if they
  // only intend to enroll in 1, so CPCQC has a fallback if the top choice
  // is oversubscribed during cohort planning.
  const [intendedCount, setIntendedCount] = useState<1 | 2 | ''>('');

  // Per-initiative rank. Initialized to '' so the placeholder shows.
  const [ranks, setRanks] = useState<Record<InitiativeCode, Rank>>({
    SPARK: '', SOAR: '', NEST: '',
  });

  // Per-initiative "why" — only required for whichever 2 are ranked 1 and 2.
  // Kept in state for all 3 so a user reordering their picks doesn't lose
  // typing, but only top-2 are validated / submitted.
  const [whys, setWhys] = useState<Record<InitiativeCode, string>>({
    SPARK: '', SOAR: '', NEST: '',
  });

  // Mock submission preview
  const [submittedPayload, setSubmittedPayload] = useState<unknown | null>(null);

  // Which ranks (1/2/3/4) are already taken by some initiative — used to
  // dim/disable already-taken options in other dropdowns so a user can't
  // create a duplicate-rank state. They CAN reuse a rank by un-picking the
  // first occurrence (set back to placeholder).
  const takenRanks = useMemo(() => {
    const taken = new Set<number>();
    for (const code of Object.keys(ranks) as InitiativeCode[]) {
      const r = ranks[code];
      if (typeof r === 'number') taken.add(r);
    }
    return taken;
  }, [ranks]);

  // Map rank → initiative code for top-2 why prompts.
  const codeByRank = useMemo(() => {
    const m = new Map<number, InitiativeCode>();
    for (const code of Object.keys(ranks) as InitiativeCode[]) {
      const r = ranks[code];
      if (typeof r === 'number') m.set(r, code);
    }
    return m;
  }, [ranks]);

  // Validation summary — drives a banner + disables submit until clean.
  const validationErrors: string[] = [];
  if (!name.trim()) validationErrors.push('Name is required.');
  if (!hospital.trim()) validationErrors.push('Hospital is required.');
  if (!role.trim()) validationErrors.push('Role is required.');
  if (!email.trim()) validationErrors.push('Email is required.');
  if (intendedCount === '') {
    validationErrors.push('Tell us how many initiatives you intend to enroll in.');
  }
  const ranksFilled = (Object.values(ranks) as Rank[]).filter((r) => r !== '').length;
  if (ranksFilled < TOTAL_RANKS) {
    validationErrors.push(
      `Rank all ${TOTAL_RANKS} initiatives from 1 (top choice) to ${TOTAL_RANKS}.`,
    );
  }
  // Verify ranks are exactly {1,…,TOTAL_RANKS}. The takenRanks disabled-option
  // nudge is a visual cue rather than a hard block (so keyboard nav stays
  // recoverable), so re-verify before submit.
  if (ranksFilled === TOTAL_RANKS && takenRanks.size !== TOTAL_RANKS) {
    validationErrors.push(
      `Each initiative needs a unique rank from 1 to ${TOTAL_RANKS}.`,
    );
  }
  if (ranksFilled === TOTAL_RANKS && takenRanks.size === TOTAL_RANKS) {
    const topCode = codeByRank.get(1);
    const secondCode = codeByRank.get(2);
    if (topCode && !whys[topCode].trim()) {
      validationErrors.push(`Tell us why ${topCode} is your top choice.`);
    }
    if (secondCode && !whys[secondCode].trim()) {
      validationErrors.push(`Tell us why ${secondCode} is your second choice.`);
    }
  }

  const canSubmit = validationErrors.length === 0;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    const topCode = codeByRank.get(1)!;
    const secondCode = codeByRank.get(2)!;
    const rankedInitiatives = (Object.keys(ranks) as InitiativeCode[])
      .map((code) => ({ code, rank: ranks[code] as number }))
      .sort((a, b) => a.rank - b.rank);
    setSubmittedPayload({
      programYear: PROGRAM_YEAR,
      contact: {
        name: name.trim(),
        hospital: hospital.trim(),
        role: role.trim(),
        email: email.trim(),
      },
      intendedInitiativeCount: intendedCount,
      rankedInitiatives,
      reasoning: {
        [topCode]: whys[topCode].trim(),
        [secondCode]: whys[secondCode].trim(),
      },
    });
  }

  // ---------- Submitted-preview screen (mock "thanks" + payload dump) ----------

  if (submittedPayload) {
    return (
      <div className="min-h-screen bg-cpcqc-cream px-4 py-12">
        <div className="mx-auto w-full max-w-2xl">
          <div className="mb-6 flex flex-col items-center">
            <Logo size="lg" />
          </div>
          <PreviewBanner />
          <div className="cpcqc-content-strip">
            <div className="rounded-b-2xl bg-white p-8 shadow-card">
              <CheckCircle2 className="mx-auto mb-3 text-cpcqc-teal-dark" size={40} aria-hidden />
              <h1 className="text-center font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
                Thanks — we got your interest form.
              </h1>
              <p className="mt-3 text-center text-cpcqc-purple-dark/80">
                A CPCQC program manager will review and follow up with the detailed
                initiative-specific Enrollment Form(s) for the {PROGRAM_YEAR} program year.
              </p>

              <div className="mt-6 rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/30 p-4">
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                  Mock — would-be submission payload
                </div>
                <pre className="overflow-auto text-xs leading-snug text-cpcqc-purple-dark/90">
{JSON.stringify(submittedPayload, null, 2)}
                </pre>
              </div>

              <button
                type="button"
                onClick={() => setSubmittedPayload(null)}
                className="mt-6 w-full rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
              >
                ← Back to form
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Form ----------

  return (
    <div className="min-h-screen bg-cpcqc-cream px-4 py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 flex flex-col items-center">
          <Logo size="lg" />
          <p className="mt-3 font-rounded text-sm uppercase tracking-[0.15em] text-cpcqc-purple-dark">
            {PROGRAM_YEAR} Interest Form
          </p>
        </div>

        <PreviewBanner />

        <div className="cpcqc-content-strip">
          <div className="rounded-b-2xl bg-white p-8 shadow-card">
            <h1 className="mb-2 font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
              Express interest in {PROGRAM_YEAR} CPCQC initiatives
            </h1>
            <p className="mb-4 text-cpcqc-purple-dark/80">
              This is step one of CPCQC's two-step annual enrollment. Tell us which initiatives
              you're considering for {PROGRAM_YEAR} and rank your preferences. CPCQC will review
              all interest forms together to set cohort size and mix, then follow up with the
              detailed initiative-specific Enrollment Forms for the programs you're accepted into.
            </p>

            <div className="mb-6 flex items-center gap-2 rounded-lg bg-cpcqc-teal-dark/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
              <CalendarDays size={16} className="shrink-0 text-cpcqc-teal-dark" aria-hidden />
              <span>
                <strong>Interest forms are accepted</strong>{' '}
                {fmtWindowDate(INTEREST_WINDOW.opensAt)} through{' '}
                {fmtWindowDate(INTEREST_WINDOW.closesAt)}.
              </span>
            </div>

            <form onSubmit={onSubmit} className="space-y-6">
              <Section title="About you">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Name" required>
                    <input
                      type="text"
                      required
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="form-input"
                    />
                  </Field>
                  <Field label="Hospital / facility" required>
                    {hospitalLocked ? (
                      <>
                        <div className="form-input flex items-center justify-between bg-cpcqc-cream-dark/30 text-cpcqc-purple-dark">
                          <span>{hospital}</span>
                          <span className="text-xs text-cpcqc-purple-dark/60">From your account</span>
                        </div>
                        <input type="hidden" value={hospital} readOnly />
                      </>
                    ) : (
                      <input
                        type="text"
                        required
                        value={hospital}
                        onChange={(e) => setHospital(e.target.value)}
                        className="form-input"
                      />
                    )}
                  </Field>
                  <Field label="Your role" required>
                    <input
                      type="text"
                      required
                      placeholder="e.g. OB Director, QI Lead"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      className="form-input"
                    />
                  </Field>
                  <Field label="Email" required>
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="form-input"
                    />
                  </Field>
                </div>
              </Section>

              <Section
                title="Your enrollment intent"
                description={`Hospitals can enroll in up to ${MAX_INITIATIVES_PER_HOSPITAL} initiatives for ${PROGRAM_YEAR}.`}
              >
                <Field
                  label={`How many initiatives do you intend to enroll in for ${PROGRAM_YEAR}?`}
                  required
                >
                  <select
                    required
                    value={intendedCount}
                    onChange={(e) =>
                      setIntendedCount(
                        e.target.value === '' ? '' : (parseInt(e.target.value, 10) as 1 | 2),
                      )
                    }
                    className="form-input"
                  >
                    <option value="">Select…</option>
                    <option value={1}>1 initiative</option>
                    <option value={2}>2 initiatives</option>
                  </select>
                </Field>
              </Section>

              <div className="rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/30 p-4">
                <h3 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
                  About Turning the Tide (TTT)
                </h3>
                <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
                  TTT is a two-year cohort running 2026–2027, and CPCQC is{' '}
                  <strong>not enrolling new TTT hospitals</strong> for {PROGRAM_YEAR} —
                  so it doesn't appear in the ranking below. If your hospital is
                  currently enrolled in TTT for 2026, you'll continue through{' '}
                  {PROGRAM_YEAR} to complete the cohort. CPCQC will send the {PROGRAM_YEAR}{' '}
                  TTT Enrollment Form to all current TTT hospitals on{' '}
                  {fmtWindowDate(INTEREST_WINDOW.closesAt)}.
                </p>
                <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
                  Annual enrollment forms are a legal requirement even for multi-year
                  cohorts.
                </p>
              </div>

              <Section
                title="Rank the initiatives"
                description={`Rank all ${TOTAL_RANKS} from 1 (your top choice) to ${TOTAL_RANKS} (lowest). Two of these will appear above the others — we ask for a brief "why" on your top two so the cohort review has the context it needs.`}
              >
                <div className="space-y-3">
                  {RANKABLE_INITIATIVES.map((init) => {
                    const code = init.code as InitiativeCode;
                    const rank = ranks[code];
                    const isTop2 = rank === 1 || rank === 2;
                    return (
                      <div
                        key={code}
                        className={
                          'rounded-xl border-2 p-3 transition ' +
                          (isTop2
                            ? 'border-cpcqc-purple bg-cpcqc-purple/5'
                            : 'border-cpcqc-purple-dark/15 bg-white')
                        }
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="flex flex-1 items-center gap-2">
                            <span aria-hidden className="text-xl">{init.emoji}</span>
                            <div>
                              <div className="font-rounded font-bold text-cpcqc-purple-dark">
                                {init.code}
                              </div>
                              <div className="text-xs text-cpcqc-purple-dark/70">
                                {init.name}
                              </div>
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-sm text-cpcqc-purple-dark/80">
                            Rank
                            <select
                              value={rank}
                              onChange={(e) =>
                                setRanks((prev) => ({
                                  ...prev,
                                  [code]:
                                    e.target.value === ''
                                      ? ''
                                      : (parseInt(e.target.value, 10) as 1 | 2 | 3),
                                }))
                              }
                              className="form-input w-24"
                              aria-label={`Rank for ${init.code}`}
                            >
                              <option value="">—</option>
                              {Array.from({ length: TOTAL_RANKS }, (_, i) => i + 1).map((n) => {
                                // Allow re-selecting our own current rank; nudge
                                // against picking ranks already taken by other
                                // initiatives by appending a marker (we don't
                                // hard-disable so the form remains keyboard-
                                // navigable and recoverable).
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
                              <textarea
                                rows={3}
                                required
                                value={whys[code]}
                                onChange={(e) =>
                                  setWhys((prev) => ({ ...prev, [code]: e.target.value }))
                                }
                                placeholder={
                                  rank === 1
                                    ? "What makes this the right top priority for your hospital this year?"
                                    : "Why is this also a high priority for you?"
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
                disabled={!canSubmit}
                className="w-full rounded-lg bg-cpcqc-purple px-4 py-2.5 font-rounded font-bold text-white shadow-sm transition hover:bg-cpcqc-purple/90 disabled:opacity-50"
              >
                Submit interest form (mock)
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-cpcqc-purple-dark/70">
              Already have an account?{' '}
              <Link className="text-cpcqc-purple underline underline-offset-2" href="/login">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>

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

// ---------- Pieces ----------

function PreviewBanner() {
  return (
    <div className="mb-3 rounded-lg border border-cpcqc-pink-dark/30 bg-cpcqc-pink-dark/10 px-4 py-2 text-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle
          size={16}
          className="mt-0.5 shrink-0 text-cpcqc-pink-dark"
          aria-hidden
        />
        <span className="text-cpcqc-pink-dark/90">
          <strong>Mock / preview.</strong> Nothing is saved to the database yet — the Submit
          button shows you the would-be payload. We'll wire it to the API once the design is
          approved.
        </span>
      </div>
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
      <h2 className="mb-1 font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
        {title}
      </h2>
      {description && (
        <p className="mb-3 text-sm text-cpcqc-purple-dark/70">{description}</p>
      )}
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
