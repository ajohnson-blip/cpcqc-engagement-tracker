'use client';

/**
 * PUBLIC interest form — no account required.
 *
 * Hospitals were previously required to sign in, which meant the form could
 * take the hospital from the auth context and never ask. Here the submitter
 * chooses their hospital, and identity rests on a verified email instead: we
 * send a link that confirms the submission and is the only way to edit it.
 *
 * The portal version at /portal/interest/[year] still exists for signed-in
 * users; this one is reachable by anyone with the link.
 */

import { Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { AlertTriangle, CalendarDays, MailCheck, Info } from 'lucide-react';
import { api, ApiError } from '@/lib/api';

type Code = 'SPARK' | 'SOAR' | 'NEST';
type Rank = 1 | 2 | 3 | '';
type WindowState = 'before' | 'open' | 'after';

const INITIATIVE_META: Record<Code, { name: string; emoji: string }> = {
  SPARK: { name: 'SPARK: Postpartum Discharge Transitions', emoji: '✨' },
  SOAR: { name: 'SOAR: Primary Cesarean Reduction', emoji: '🪁' },
  NEST: { name: 'NEST: Infant Safe Sleep', emoji: '🐣' },
};

interface WindowResp {
  window: { opensAt: string; closesAt: string } | null;
  state: WindowState;
}
interface HospitalCtx {
  hospitalId: string;
  hospitalName: string;
  currentlyEnrolledInTTT: boolean;
  currentlyInSoarSustainability: boolean;
  rankable: Code[];
  alreadySubmitted: boolean;
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

interface EditableForm {
  hospitalId: string;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  intendedInitiativeCount: number;
  rankedInitiatives: Array<{ code: Code; rank: number }>;
  reasoning: Partial<Record<Code, string>>;
  editable: boolean;
  closesAt: string | null;
}

export default function PublicInterestFormPage() {
  return (
    <Suspense fallback={<Shell><p className="text-sm text-cpcqc-purple-dark/70">Loading…</p></Shell>}>
      <InterestForm />
    </Suspense>
  );
}

function InterestForm() {
  const programYear = parseInt(useParams<{ year: string }>().year, 10);
  // Arriving with ?token= means "reopen what I sent" — the emailed link is the
  // only proof of being the original submitter, so it is what authorises editing.
  const editToken = useSearchParams().get('token');
  const [editing, setEditing] = useState<EditableForm | null>(null);
  const [editClosed, setEditClosed] = useState<string | null>(null);

  const [win, setWin] = useState<WindowResp | null>(null);
  const [hospitals, setHospitals] = useState<Array<{ id: string; name: string; system: string | null }>>([]);
  const [hospitalId, setHospitalId] = useState('');
  const [ctx, setCtx] = useState<HospitalCtx | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [intended, setIntended] = useState<1 | 2 | ''>('');
  const [ranks, setRanks] = useState<Record<Code, Rank>>({ SPARK: '', SOAR: '', NEST: '' });
  const [whys, setWhys] = useState<Record<Code, string>>({ SPARK: '', SOAR: '', NEST: '' });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Load an existing submission when editing, and prefill from it.
  useEffect(() => {
    if (!editToken) return;
    api
      .post<EditableForm>('/public/interest-forms/load', { token: editToken })
      .then((f) => {
        setEditing(f);
        setHospitalId(f.hospitalId);
        setName(f.submitterName);
        setRole(f.submitterRole);
        setEmail(f.submitterEmail);
        setIntended(f.intendedInitiativeCount as 1 | 2);
        const r: Record<Code, Rank> = { SPARK: '', SOAR: '', NEST: '' };
        for (const x of f.rankedInitiatives) r[x.code] = x.rank as Rank;
        setRanks(r);
        setWhys({ SPARK: '', SOAR: '', NEST: '', ...f.reasoning } as Record<Code, string>);
        if (!f.editable) {
          setEditClosed(
            f.closesAt
              ? `The window closed on ${fmtDate(f.closesAt)}, so this submission can no longer be changed. Contact qi@cpcqc.org if something needs correcting.`
              : 'This submission can no longer be changed.',
          );
        }
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [editToken]);

  useEffect(() => {
    Promise.all([
      api.get<WindowResp>(`/public/interest-forms/window?programYear=${programYear}`),
      api.get<{ hospitals: Array<{ id: string; name: string; system: string | null }> }>('/public/interest-forms/hospitals'),
    ])
      .then(([w, h]) => { setWin(w); setHospitals(h.hospitals); })
      .catch((e: Error) => setLoadError(e.message));
  }, [programYear]);

  // The hospital drives which initiatives can be ranked and what the banners
  // say, so it has to be chosen before the rest of the form means anything.
  const loadCtx = useCallback(async (id: string) => {
    setCtx(null);
    if (!id) return;
    try {
      setCtx(await api.get<HospitalCtx>(
        `/public/interest-forms/context?programYear=${programYear}&hospitalId=${encodeURIComponent(id)}`,
      ));
      setRanks({ SPARK: '', SOAR: '', NEST: '' });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load that hospital.');
    }
  }, [programYear]);

  // In edit mode the hospital comes from the submission, so its context has to
  // be fetched too — the ranking pool depends on it.
  useEffect(() => {
    if (editing?.hospitalId) void loadCtx(editing.hospitalId);
  }, [editing?.hospitalId, loadCtx]);

  const rankable = ctx?.rankable ?? [];
  const takenRanks = useMemo(() => {
    const t = new Set<number>();
    for (const c of rankable) if (typeof ranks[c] === 'number') t.add(ranks[c] as number);
    return t;
  }, [ranks, rankable]);

  const errors: string[] = [];
  if (!hospitalId) errors.push('Choose your hospital.');
  if (!name.trim()) errors.push('Your name is required.');
  if (!role.trim()) errors.push('Your role is required.');
  if (!email.trim()) errors.push('Email is required.');
  if (intended === '') errors.push('Tell us how many initiatives you intend to enroll in.');
  if (ctx) {
    const filled = rankable.filter((c) => ranks[c] !== '').length;
    if (filled < rankable.length) errors.push(`Rank all ${rankable.length} initiatives.`);
    else if (takenRanks.size !== rankable.length) errors.push('Each initiative needs a different rank.');
    else {
      const byRank = new Map<number, Code>();
      for (const c of rankable) if (typeof ranks[c] === 'number') byRank.set(ranks[c] as number, c);
      const top = byRank.get(1), second = byRank.get(2);
      if (top && !whys[top].trim()) errors.push(`Tell us why ${top} is your top choice.`);
      if (second && !whys[second].trim()) errors.push(`Tell us why ${second} is your second choice.`);
    }
  }

  const isOpen = win?.state === 'open';
  // Editing an existing submission doesn't trip the "already submitted" guard —
  // that guard exists to stop a stranger overwriting, and the token proves this
  // is the same person.
  const canSubmit =
    errors.length === 0 &&
    !submitting &&
    (editToken ? !editClosed : isOpen && !ctx?.alreadySubmitted);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (editToken) {
        await api.post('/public/interest-forms/update', {
          token: editToken,
          submitterName: name,
          submitterRole: role,
          submitterEmail: email,
          intendedInitiativeCount: intended,
          rankedInitiatives: rankable
            .filter((c) => typeof ranks[c] === 'number')
            .map((c) => ({ code: c, rank: ranks[c] as number })),
          reasoning: Object.fromEntries(rankable.map((c) => [c, whys[c]])),
        });
        setSentTo('__updated__');
        return;
      }
      const res = await api.post<{ sentTo: string }>('/public/interest-forms', {
        programYear,
        hospitalId,
        submitterName: name,
        submitterRole: role,
        submitterEmail: email,
        intendedInitiativeCount: intended,
        rankedInitiatives: rankable
          .filter((c) => typeof ranks[c] === 'number')
          .map((c) => ({ code: c, rank: ranks[c] as number })),
        reasoning: Object.fromEntries(rankable.map((c) => [c, whys[c]])),
      });
      setSentTo(res.sentTo);
    } catch (e) {
      setSubmitError(
        e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) {
    return <Shell><p className="text-sm text-cpcqc-pink-dark">{loadError}</p></Shell>;
  }
  if (!win) return <Shell><p className="text-sm text-cpcqc-purple-dark/70">Loading…</p></Shell>;

  if (sentTo === '__updated__') {
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-8 text-center shadow-card">
          <MailCheck className="mx-auto h-10 w-10 text-cpcqc-teal-dark" />
          <h2 className="mt-3 font-rounded text-xl font-bold text-cpcqc-purple-dark">
            Your changes are saved
          </h2>
          <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
            {editing?.closesAt
              ? `You can keep changing this until ${fmtDate(editing.closesAt)} using the link in your confirmation email.`
              : 'You can keep changing this using the link in your confirmation email.'}
          </p>
        </div>
      </Shell>
    );
  }

  if (sentTo) {
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-8 text-center shadow-card">
          <MailCheck className="mx-auto h-10 w-10 text-cpcqc-teal-dark" />
          <h2 className="mt-3 font-rounded text-xl font-bold text-cpcqc-purple-dark">
            One more step — check your email
          </h2>
          <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
            We&rsquo;ve sent a confirmation link to <strong>{sentTo}</strong>. Your interest form
            isn&rsquo;t final until you open it.
          </p>
          <p className="mt-3 text-xs text-cpcqc-purple-dark/60">
            Keep that email — the same link is how you edit your submission while the window is
            open. Nothing arrived after a few minutes? Check your junk folder, or contact{' '}
            <a className="underline" href="mailto:qi@cpcqc.org">qi@cpcqc.org</a>.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {editToken && (
        <div
          className={
            'mb-6 rounded-xl px-4 py-3 text-sm ' +
            (editClosed
              ? 'bg-cpcqc-pink-dark/10 text-cpcqc-pink-dark'
              : 'bg-cpcqc-teal-dark/10 text-cpcqc-purple-dark')
          }
        >
          {editClosed ?? (
            <>
              <strong>Editing your submission.</strong> Change anything below and save — your
              earlier answers are already filled in
              {editing?.closesAt ? <>, and you can keep editing until {fmtDate(editing.closesAt)}</> : ''}.
            </>
          )}
        </div>
      )}

      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          {editToken ? `Edit your ${programYear} interest form` : `Express interest in ${programYear} CPCQC initiatives`}
        </h1>
        <p className="mt-2 max-w-2xl text-cpcqc-purple-dark/80">
          Step one of CPCQC&rsquo;s two-step annual enrollment. No account needed — tell us which
          initiatives you&rsquo;re considering and rank your preferences. CPCQC reviews all interest
          forms together, then follows up with the initiative-specific Enrollment Forms in November.
        </p>
        {/* Said before they start, not after: the duplicate guard already
            refuses a second submission, but discovering that at the end means
            filling the whole form for nothing. */}
        <p className="mt-3 max-w-2xl rounded-lg bg-cpcqc-cream-dark/30 px-4 py-2 text-sm text-cpcqc-purple-dark/80">
          <strong className="text-cpcqc-purple-dark">One form per hospital.</strong> If a colleague
          has already submitted for your hospital, you don&rsquo;t need to submit again — one
          response covers the whole hospital. Choose your hospital below and we&rsquo;ll tell you
          straight away if it&rsquo;s already been submitted.
        </p>
      </header>

      <div className="mb-6 space-y-2 rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/20 px-4 py-3 text-sm text-cpcqc-purple-dark/80">
        <p>
          <strong className="text-cpcqc-purple-dark">New for {programYear}:</strong> CPCQC is
          limiting enrollment to two QI initiatives per hospital each year — to protect hospital
          staff and CPCQC&rsquo;s capacity to support high-quality QI implementation.
        </p>
        <p>
          Under Colorado law (C.R.S. § 25-52-106.5(6)(a)(II)), hospitals are only required to
          actively engage in one QI initiative per year. Ranking additional initiatives is optional.
        </p>
      </div>

      <div
        className={
          'mb-6 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ' +
          (win.state === 'after'
            ? 'bg-cpcqc-pink-dark/10 text-cpcqc-pink-dark'
            : win.state === 'before'
              ? 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark'
              : 'bg-cpcqc-teal-dark/10 text-cpcqc-purple-dark')
        }
      >
        <CalendarDays size={16} className="shrink-0" aria-hidden />
        <span>
          {win.state === 'open' && win.window && (
            <><strong>Interest forms are open</strong> through {fmtDate(win.window.closesAt)}.</>
          )}
          {win.state === 'before' && (
            <>
              <strong>The {programYear} interest window isn&rsquo;t open yet</strong>
              {win.window ? <> — it opens {fmtDate(win.window.opensAt)}.</> : '.'} You can look
              around, but submissions aren&rsquo;t accepted yet.
            </>
          )}
          {win.state === 'after' && win.window && (
            <>
              <strong>The {programYear} interest window closed</strong> on{' '}
              {fmtDate(win.window.closesAt)}. Contact qi@cpcqc.org if you need to submit late.
            </>
          )}
        </span>
      </div>

      <form onSubmit={onSubmit} className={'space-y-6 ' + (isOpen ? '' : 'opacity-60')}>
        <fieldset disabled={!isOpen} className="space-y-6">
          <Section title="Your hospital">
            <Field label="Hospital" required>
              <select
                value={hospitalId}
                onChange={(e) => { setHospitalId(e.target.value); void loadCtx(e.target.value); }}
                className="form-input"
              >
                <option value="">Select your hospital…</option>
                {hospitals.map((h) => (
                  <option key={h.id} value={h.id}>{hospitalLabel(h)}</option>
                ))}
              </select>
            </Field>
          </Section>

          {ctx?.alreadySubmitted && (
            <div className="flex gap-2 rounded-xl bg-cpcqc-orange-dark/10 px-4 py-3 text-sm text-cpcqc-orange-dark">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <p>
                An interest form for <strong>{ctx.hospitalName}</strong> has already been submitted
                for {programYear}. To change it, use the link in the confirmation email, or contact{' '}
                <a className="underline" href="mailto:qi@cpcqc.org">qi@cpcqc.org</a> — we won&rsquo;t
                overwrite an existing submission.
              </p>
            </div>
          )}

          {ctx && !ctx.alreadySubmitted && (
            <>
              <div className="flex gap-2 rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/20 px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
                <div>
                  <p>
                    <strong className="text-cpcqc-purple-dark">
                      Current enrollments do not carry over automatically.
                    </strong>{' '}
                    SPARK, SOAR and NEST run one year at a time — to take part in {programYear},
                    rank the initiative below and submit its enrollment form in November.
                  </p>
                  {ctx.currentlyEnrolledInTTT && (
                    <p className="mt-2">
                      {ctx.hospitalName} is in Turning the Tide, a two-year cohort, so that
                      continues into {programYear} automatically and counts as one of your two
                      initiatives. That means you can <strong>enrol in at most one more</strong>{' '}
                      — or none at all, if Turning the Tide is enough for {programYear}. Please
                      still rank all {rankable.length} initiatives below: ranking is a
                      preference, not a commitment, and it tells us where to place you if a
                      space opens.
                    </p>
                  )}
                  {ctx.currentlyInSoarSustainability && (
                    <p className="mt-2">
                      {ctx.hospitalName} is completing its SOAR sustainability year, which is capped
                      at one year — so SOAR isn&rsquo;t a ranking option below. Hospitals that meet
                      their sustainability metrics graduate from SOAR.
                    </p>
                  )}
                </div>
              </div>

              <Section title="About you">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Name" required>
                    <input value={name} onChange={(e) => setName(e.target.value)} className="form-input" />
                  </Field>
                  <Field label="Your role" required>
                    <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. OB Director, QI Lead" className="form-input" />
                  </Field>
                  <Field label="Email" required>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="form-input" />
                  </Field>
                  <Field label={`How many initiatives do you intend to enroll in for ${programYear}?`} required>
                    <select
                      value={intended}
                      onChange={(e) => setIntended(e.target.value === '' ? '' : (parseInt(e.target.value, 10) as 1 | 2))}
                      className="form-input"
                    >
                      <option value="">Select…</option>
                      <option value={1}>
                        {ctx.currentlyEnrolledInTTT
                          ? '1 — Turning the Tide only, no additional initiative'
                          : '1 initiative'}
                      </option>
                      <option value={2}>
                        {ctx.currentlyEnrolledInTTT
                          ? '2 — Turning the Tide plus one more'
                          : '2 initiatives'}
                      </option>
                    </select>
                  </Field>
                </div>
                <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
                  We&rsquo;ll email this address a link to confirm your submission — it&rsquo;s also
                  how you edit it later, so use one you can access.
                </p>
              </Section>

              <Section
                title="Rank the initiatives"
                description={`Rank all ${rankable.length} from 1 (your top choice) to ${rankable.length} (lowest). Your ranking helps CPCQC understand which initiatives are the highest priority for your hospital and supports planning for the upcoming enrollment year. We ask for a brief "why" on your top two.`}
              >
                <div className="space-y-3">
                  {rankable.map((code) => {
                    const rank = ranks[code];
                    const isTop2 = rank === 1 || rank === 2;
                    return (
                      <div key={code} className={'rounded-xl border-2 p-3 transition ' + (isTop2 ? 'border-cpcqc-purple bg-cpcqc-purple/5' : 'border-cpcqc-purple-dark/15 bg-white')}>
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="flex flex-1 items-center gap-2">
                            <span aria-hidden className="text-xl">{INITIATIVE_META[code].emoji}</span>
                            <div>
                              <div className="font-rounded font-bold text-cpcqc-purple-dark">{code}</div>
                              <div className="text-xs text-cpcqc-purple-dark/70">{INITIATIVE_META[code].name}</div>
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-sm text-cpcqc-purple-dark/80">
                            Rank
                            <select
                              value={rank}
                              onChange={(e) => setRanks((p) => ({ ...p, [code]: e.target.value === '' ? '' : (parseInt(e.target.value, 10) as Rank) }))}
                              className="rounded-lg border border-cpcqc-purple-dark/20 px-2 py-1"
                            >
                              <option value="">—</option>
                              {Array.from({ length: rankable.length }, (_, i) => i + 1).map((n) => (
                                <option key={n} value={n} disabled={takenRanks.has(n) && rank !== n}>{n}</option>
                              ))}
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
                              <span className="mb-1 block text-xs text-cpcqc-purple-dark/60">
                                If you can point to data that supports your choice, please share it.
                              </span>
                              <textarea
                                rows={3}
                                value={whys[code]}
                                onChange={(e) => setWhys((p) => ({ ...p, [code]: e.target.value }))}
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

              {errors.length > 0 && isOpen && (
                <div className="rounded-xl bg-cpcqc-orange-dark/10 p-4">
                  <p className="flex items-center gap-2 text-sm font-bold text-cpcqc-orange-dark">
                    <AlertTriangle size={16} aria-hidden /> Before you can submit
                  </p>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-cpcqc-orange-dark">
                    {errors.map((e) => <li key={e}>{e}</li>)}
                  </ul>
                </div>
              )}
              {submitError && <p className="text-sm text-cpcqc-pink-dark">{submitError}</p>}

              <button
                type="submit"
                disabled={!canSubmit}
                className="w-full rounded-lg bg-cpcqc-purple px-4 py-2.5 font-rounded font-bold text-white shadow-sm transition hover:bg-cpcqc-purple/90 disabled:opacity-60"
              >
                {submitting
                  ? 'Saving…'
                  : editToken
                    ? 'Save changes'
                    : 'Submit interest form'}
              </button>
            </>
          )}
        </fieldset>
      </form>
    </Shell>
  );
}

/** "East Morgan County Hospital (Banner)" — but not "Banner Fort Collins
 *  Medical Center (Banner)", which would just be noise. */
function hospitalLabel(h: { name: string; system: string | null }): string {
  if (!h.system) return h.name;
  return h.name.toLowerCase().includes(h.system.toLowerCase()) ? h.name : `${h.name} (${h.system})`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-cpcqc-cream">
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-1 font-rounded text-lg font-extrabold text-cpcqc-purple-dark">{title}</h2>
      {description && <p className="mb-3 text-sm text-cpcqc-purple-dark/70">{description}</p>}
      {children}
    </section>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        {label}{required && <span className="ml-0.5 text-cpcqc-pink-dark">*</span>}
      </span>
      {children}
    </label>
  );
}
