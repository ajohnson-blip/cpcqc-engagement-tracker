'use client';

/**
 * Real production version of the 2027 annual interest form.
 *
 * Behavior:
 *   - Gated by hospital sign-in (lives under /portal which the layout
 *     guards).
 *   - Hospital identity comes from the server-side auth context, not the
 *     form — we don't even render a Hospital field.
 *   - Loads the acceptance window + current submission (if any) on mount.
 *     If a submission exists, the form is pre-filled and the submit button
 *     reads "Update submission" — editable through window close.
 *   - Window-closed state: form goes read-only with a banner explaining
 *     why; existing submission still displays.
 *   - TTT-aware intent: if the hospital is currently enrolled in TTT for
 *     the prior year, the dropdown asks for 0 or 1 ADDITIONAL initiatives
 *     (TTT continuation eats one of the 2 slots); otherwise 1 or 2.
 *   - Shows the hospital's current enrollments for the prior year at the
 *     top of the form for context ("you already have X, Y").
 *
 * Field validation matches the backend zod schema. Server-side is the
 * source of truth — the client just provides a smooth UX.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  CheckCircle2,
  AlertTriangle,
  CalendarDays,
  Clock,
  ArrowLeft,
  Pencil,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { daysUntilUtc, closesInLabel } from '@/lib/format';
import type {
  AnnualInterestForm,
  EnrollmentWindowResponse,
  MyEnrollment,
  RankableInitiativeCode,
} from '@/lib/types';

const COUNTDOWN_THRESHOLD_DAYS = 7;

const RANKABLE_INITIATIVES = [
  { code: 'SPARK', name: 'SPARK: Postpartum Discharge Transitions', emoji: '✨' },
  { code: 'SOAR',  name: 'SOAR: Primary Cesarean Reduction',         emoji: '🪁' },
  { code: 'NEST',  name: 'NEST: Infant Safe Sleep',                  emoji: '🐣' },
] as const;
const TOTAL_RANKS = RANKABLE_INITIATIVES.length;

type Rank = 1 | 2 | 3 | '';

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function AnnualInterestRealPage() {
  const params = useParams<{ year: string }>();
  const programYear = parseInt(params.year, 10);
  const { hospitalName } = useAuth();

  const [windowResp, setWindowResp] = useState<EnrollmentWindowResponse | null>(null);
  const [enrollments, setEnrollments] = useState<MyEnrollment[] | null>(null);
  const [existing, setExisting] = useState<AnnualInterestForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // ---------- Form state ----------
  const [submitterName, setSubmitterName] = useState('');
  const [submitterRole, setSubmitterRole] = useState('');
  const [submitterEmail, setSubmitterEmail] = useState('');
  const [intendedCount, setIntendedCount] = useState<0 | 1 | 2 | ''>('');
  const [ranks, setRanks] = useState<Record<RankableInitiativeCode, Rank>>({
    SPARK: '', SOAR: '', NEST: '',
  });
  const [whys, setWhys] = useState<Record<RankableInitiativeCode, string>>({
    SPARK: '', SOAR: '', NEST: '',
  });

  // ---------- Submit state ----------
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState<AnnualInterestForm | null>(null);

  // ---------- Load on mount ----------
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<EnrollmentWindowResponse>(
        `/portal/annual-interest-forms/window?programYear=${programYear}`,
      ),
      api.get<{ enrollments: MyEnrollment[] }>('/me/enrollments'),
      api
        .get<{ form: AnnualInterestForm | null }>(
          `/portal/annual-interest-forms?programYear=${programYear}`,
        )
        .catch(() => ({ form: null })),
    ])
      .then(([win, en, ex]) => {
        if (cancelled) return;
        setWindowResp(win);
        setEnrollments(en.enrollments);
        if (ex.form) {
          setExisting(ex.form);
          setSubmitterName(ex.form.submitterName);
          setSubmitterRole(ex.form.submitterRole);
          setSubmitterEmail(ex.form.submitterEmail);
          setIntendedCount(ex.form.intendedInitiativeCount as 0 | 1 | 2);
          const nextRanks: Record<RankableInitiativeCode, Rank> = {
            SPARK: '', SOAR: '', NEST: '',
          };
          for (const r of ex.form.rankedInitiatives) {
            nextRanks[r.code] = r.rank as Rank;
          }
          setRanks(nextRanks);
          setWhys({
            SPARK: ex.form.reasoning.SPARK ?? '',
            SOAR: ex.form.reasoning.SOAR ?? '',
            NEST: ex.form.reasoning.NEST ?? '',
          });
        }
        setLoaded(true);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setLoadError(err.message);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [programYear]);

  // ---------- Derived state ----------

  // Hospital's prior-year enrollments. Used to detect TTT continuation status
  // (drives the intent dropdown options) and to render the "you already have"
  // context panel at the top of the form.
  const priorYear = programYear - 1;
  const priorEnrollments = useMemo(() => {
    if (!enrollments) return [];
    // Show only initiatives the hospital was enrolled in for the prior year
    // (and is still enrolled, not withdrawn). The compliance engine handles
    // the cohort dates; we just filter on status here.
    return enrollments.filter((e) => e.status === 'enrolled');
  }, [enrollments]);
  const inTTT = useMemo(
    () => priorEnrollments.some((e) => e.initiative?.code === 'TTT'),
    [priorEnrollments],
  );

  // For TTT hospitals, the intent question is "how many ADDITIONAL initiatives
  // beyond your TTT continuation?" with options 0 or 1. For non-TTT hospitals,
  // it's 1 or 2 — the standard cap.
  const intentOptions = inTTT
    ? ([0, 1] as const)
    : ([1, 2] as const);
  const intentLabelSuffix = inTTT ? 'additional initiative(s)' : 'initiative(s)';

  const takenRanks = useMemo(() => {
    const taken = new Set<number>();
    for (const code of Object.keys(ranks) as RankableInitiativeCode[]) {
      const r = ranks[code];
      if (typeof r === 'number') taken.add(r);
    }
    return taken;
  }, [ranks]);

  const codeByRank = useMemo(() => {
    const m = new Map<number, RankableInitiativeCode>();
    for (const code of Object.keys(ranks) as RankableInitiativeCode[]) {
      const r = ranks[code];
      if (typeof r === 'number') m.set(r, code);
    }
    return m;
  }, [ranks]);

  const validationErrors: string[] = [];
  if (!submitterName.trim()) validationErrors.push('Your name is required.');
  if (!submitterRole.trim()) validationErrors.push('Your role is required.');
  if (!submitterEmail.trim()) validationErrors.push('Email is required.');
  if (intendedCount === '') validationErrors.push('Tell us how many initiatives you intend to enroll in.');
  const ranksFilled = (Object.values(ranks) as Rank[]).filter((r) => r !== '').length;
  if (ranksFilled < TOTAL_RANKS) {
    validationErrors.push(`Rank all ${TOTAL_RANKS} initiatives from 1 to ${TOTAL_RANKS}.`);
  }
  if (ranksFilled === TOTAL_RANKS && takenRanks.size !== TOTAL_RANKS) {
    validationErrors.push(`Each initiative needs a unique rank from 1 to ${TOTAL_RANKS}.`);
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
  const canSubmit = validationErrors.length === 0 && windowResp?.isOpen;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const topCode = codeByRank.get(1)!;
      const secondCode = codeByRank.get(2)!;
      const rankedInitiatives = (Object.keys(ranks) as RankableInitiativeCode[])
        .map((code) => ({ code, rank: ranks[code] as number }))
        .sort((a, b) => a.rank - b.rank);
      const reasoning = {
        [topCode]: whys[topCode].trim(),
        [secondCode]: whys[secondCode].trim(),
      };
      const res = await api.post<{ form: AnnualInterestForm; wasUpdate: boolean }>(
        '/portal/annual-interest-forms',
        {
          programYear,
          intendedInitiativeCount: intendedCount,
          rankedInitiatives,
          reasoning,
          submitterName: submitterName.trim(),
          submitterRole: submitterRole.trim(),
          submitterEmail: submitterEmail.trim(),
        },
      );
      setExisting(res.form);
      setJustSubmitted(res.form);
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err.message : 'Could not submit. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ---------- Render ----------

  if (!loaded) {
    return (
      <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
        Loading…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
        Couldn't load the interest form: {loadError}
      </div>
    );
  }

  if (!windowResp) {
    return (
      <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
        No enrollment window configured for {programYear}.
      </div>
    );
  }

  const windowState = windowResp.windowState;
  const windowBefore = windowState === 'before';
  const windowOpen = windowState === 'open';
  const windowAfter = windowState === 'after';
  // Form is read-only any time the window isn't open. Pre-window we still
  // show the full form so hospitals can preview what they'll be filling out.
  const formLocked = !windowOpen;
  // Countdown — only while open. Within the threshold the open-state banner
  // flips to urgency copy + orange styling.
  const daysLeft = daysUntilUtc(windowResp.window.closesAt);
  const closingSoon = windowOpen && daysLeft <= COUNTDOWN_THRESHOLD_DAYS;

  // Success screen after submit/update.
  if (justSubmitted) {
    return (
      <div>
        <Link
          href="/portal"
          className="mb-4 inline-flex items-center gap-1 text-sm text-cpcqc-purple hover:underline"
        >
          <ArrowLeft size={14} /> Back to portal
        </Link>
        <div className="overflow-hidden rounded-2xl bg-white shadow-card">
          <div className="h-1 w-full bg-cpcqc-teal-dark" />
          <div className="p-6">
            <CheckCircle2 className="mb-3 text-cpcqc-teal-dark" size={36} aria-hidden />
            <h1 className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
              Your {programYear} interest form is in.
            </h1>
            <p className="mt-2 text-cpcqc-purple-dark/80">
              CPCQC will review submissions in aggregate after the window closes on{' '}
              <strong>{fmtDate(windowResp.window.closesAt)}</strong> and follow up with the
              detailed initiative-specific Enrollment Forms for the cohorts you're accepted to.
              {windowResp.isOpen && ' You can update this submission anytime until the window closes.'}
            </p>

            <SubmissionSummary form={justSubmitted} />

            <div className="mt-6 flex flex-wrap gap-2">
              {windowResp.isOpen && (
                <button
                  type="button"
                  onClick={() => setJustSubmitted(null)}
                  className="inline-flex items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
                >
                  <Pencil size={14} /> Update submission
                </button>
              )}
              <Link
                href="/portal"
                className="inline-flex items-center gap-1 rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
              >
                Done
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link
        href="/portal"
        className="mb-4 inline-flex items-center gap-1 text-sm text-cpcqc-purple hover:underline"
      >
        <ArrowLeft size={14} /> Back to portal
      </Link>

      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          Express interest in {programYear} CPCQC initiatives
        </h1>
        <p className="mt-2 max-w-2xl text-cpcqc-purple-dark/80">
          This is step one of CPCQC's two-step annual enrollment. Tell us which initiatives
          you're considering for {programYear} and rank your preferences. CPCQC reviews all
          interest forms together to set cohort size and mix, then follows up with the
          detailed initiative-specific Enrollment Forms for the programs you're accepted into.
        </p>
      </header>

      <div
        className={
          'mb-6 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ' +
          (windowAfter
            ? 'bg-cpcqc-pink-dark/10 text-cpcqc-pink-dark'
            : windowBefore || closingSoon
              ? 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark'
              : 'bg-cpcqc-teal-dark/10 text-cpcqc-purple-dark')
        }
      >
        {closingSoon && !windowAfter ? (
          <Clock size={16} className="shrink-0 text-cpcqc-orange-dark" aria-hidden />
        ) : (
          <CalendarDays
            size={16}
            className={
              'shrink-0 ' +
              (windowAfter
                ? 'text-cpcqc-pink-dark'
                : windowBefore
                  ? 'text-cpcqc-orange-dark'
                  : 'text-cpcqc-teal-dark')
            }
            aria-hidden
          />
        )}
        <span>
          {windowBefore && (
            <>
              <strong>The {programYear} interest window opens</strong> on{' '}
              {fmtDate(windowResp.window.opensAt)} and runs through{' '}
              {fmtDate(windowResp.window.closesAt)}. You can preview the form below;
              we'll accept submissions when the window opens.
            </>
          )}
          {windowOpen && (
            closingSoon ? (
              <>
                <strong className="capitalize">{closesInLabel(daysLeft)}</strong> — the{' '}
                {programYear} interest window closes {fmtDate(windowResp.window.closesAt)}.
                {existing
                  ? ' You can still update your submission until then.'
                  : ' Submit before then to be considered.'}
              </>
            ) : (
              <>
                <strong>Interest forms are accepted</strong>{' '}
                {fmtDate(windowResp.window.opensAt)} through {fmtDate(windowResp.window.closesAt)}.
                {existing && ' You can update your submission until then.'}
              </>
            )
          )}
          {windowAfter && (
            <>
              <strong>The {programYear} interest window closed</strong> on{' '}
              {fmtDate(windowResp.window.closesAt)}. {existing
                ? 'Your submission is shown below; reach out to engagement@qi.cpcqc.org if you need to make a change.'
                : 'Contact CPCQC if you missed the window and need to submit late.'}
            </>
          )}
        </span>
      </div>

      {priorEnrollments.length > 0 && (
        <div className="mb-6 rounded-2xl bg-cpcqc-cream-dark/30 p-5">
          <h2 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
            Your current enrollments
          </h2>
          <p className="mt-1 text-xs text-cpcqc-purple-dark/70">
            For context — {hospitalName ?? 'your hospital'} is currently enrolled in:
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {priorEnrollments.map((e) => (
              <li
                key={e.enrollmentId}
                className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark shadow-sm"
              >
                <span aria-hidden>{e.initiative?.emoji ?? '•'}</span>
                {e.initiative?.code ?? '?'}
                {e.cohort?.track === 'sustainability' && (
                  <span className="text-cpcqc-purple-dark/60">· sustainability</span>
                )}
              </li>
            ))}
          </ul>
          {inTTT && (
            <p className="mt-3 text-sm text-cpcqc-purple-dark/80">
              Because you're in TTT, that continuation counts toward your{' '}
              <strong>2-initiative limit</strong> for {programYear} — you can add up to one
              more initiative below.
            </p>
          )}
        </div>
      )}

      <form
        onSubmit={onSubmit}
        className={'space-y-6 ' + (formLocked ? 'pointer-events-none opacity-60' : '')}
      >
        <fieldset disabled={formLocked} className="space-y-6">
          <Section title="About you">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name" required>
                <input
                  type="text"
                  required
                  autoComplete="name"
                  value={submitterName}
                  onChange={(e) => setSubmitterName(e.target.value)}
                  className="form-input"
                />
              </Field>
              <Field label="Hospital">
                <div className="form-input flex items-center justify-between bg-cpcqc-cream-dark/30 text-cpcqc-purple-dark">
                  <span>{hospitalName ?? 'Your hospital'}</span>
                  <span className="text-xs text-cpcqc-purple-dark/60">From your account</span>
                </div>
              </Field>
              <Field label="Your role" required>
                <input
                  type="text"
                  required
                  placeholder="e.g. OB Director, QI Lead"
                  value={submitterRole}
                  onChange={(e) => setSubmitterRole(e.target.value)}
                  className="form-input"
                />
              </Field>
              <Field label="Email" required>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={submitterEmail}
                  onChange={(e) => setSubmitterEmail(e.target.value)}
                  className="form-input"
                />
              </Field>
            </div>
          </Section>

          <Section
            title="Your enrollment intent"
            description={
              inTTT
                ? `Your existing TTT enrollment continues automatically. Tell us how many ADDITIONAL initiatives you intend to enroll in for ${programYear} (max 1 — your TTT continuation already uses one of your 2 slots).`
                : `Hospitals can enroll in up to 2 initiatives for ${programYear}.`
            }
          >
            <Field
              label={
                inTTT
                  ? `How many additional initiatives do you intend to enroll in for ${programYear}?`
                  : `How many initiatives do you intend to enroll in for ${programYear}?`
              }
              required
            >
              <select
                required
                value={intendedCount}
                onChange={(e) =>
                  setIntendedCount(
                    e.target.value === '' ? '' : (parseInt(e.target.value, 10) as 0 | 1 | 2),
                  )
                }
                className="form-input"
              >
                <option value="">Select…</option>
                {intentOptions.map((n) => (
                  <option key={n} value={n}>
                    {n} {intentLabelSuffix}
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
              TTT is a two-year cohort running 2026–{programYear}, and CPCQC is{' '}
              <strong>not enrolling new TTT hospitals</strong> for {programYear} — so it
              doesn't appear in the ranking below. If your hospital is currently enrolled
              in TTT, you'll continue through {programYear} to complete the cohort. CPCQC
              will send the {programYear} TTT Enrollment Form to all current TTT hospitals
              on {fmtDate(windowResp.window.closesAt)}.
            </p>
            <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
              Annual enrollment forms are a legal requirement even for multi-year cohorts.
            </p>
          </div>

          <Section
            title="Rank the initiatives"
            description={`Rank all ${TOTAL_RANKS} from 1 (your top choice) to ${TOTAL_RANKS} (lowest). Two of these will appear above the others — we ask for a brief "why" on your top two so the cohort review has the context it needs.`}
          >
            <div className="space-y-3">
              {RANKABLE_INITIATIVES.map((init) => {
                const code = init.code as RankableInitiativeCode;
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
                        <span aria-hidden className="text-xl">
                          {init.emoji}
                        </span>
                        <div>
                          <div className="font-rounded font-bold text-cpcqc-purple-dark">
                            {init.code}
                          </div>
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

          {submitError && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {submitError}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="w-full rounded-lg bg-cpcqc-purple px-4 py-2.5 font-rounded font-bold text-white shadow-sm transition hover:bg-cpcqc-purple/90 disabled:opacity-50"
          >
            {submitting
              ? 'Saving…'
              : existing
                ? 'Update submission'
                : 'Submit interest form'}
          </button>
        </fieldset>
      </form>

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

function SubmissionSummary({ form }: { form: AnnualInterestForm }) {
  const sortedRanks = [...form.rankedInitiatives].sort((a, b) => a.rank - b.rank);
  return (
    <div className="mt-5 rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/30 p-4">
      <div className="mb-2 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        Your submission
      </div>
      <dl className="space-y-2 text-sm text-cpcqc-purple-dark">
        <div>
          <dt className="inline font-bold">Intent:</dt>{' '}
          <dd className="inline">
            {form.intendedInitiativeCount === 0
              ? 'No additional initiatives requested'
              : `${form.intendedInitiativeCount} initiative(s)`}
          </dd>
        </div>
        <div>
          <dt className="font-bold">Rankings:</dt>
          <dd>
            <ol className="ml-5 list-decimal space-y-1">
              {sortedRanks.map((r) => (
                <li key={r.code}>
                  <strong>{r.code}</strong>
                  {form.reasoning[r.code] && (
                    <p className="mt-0.5 text-cpcqc-purple-dark/70">
                      {form.reasoning[r.code]}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </dd>
        </div>
      </dl>
    </div>
  );
}
