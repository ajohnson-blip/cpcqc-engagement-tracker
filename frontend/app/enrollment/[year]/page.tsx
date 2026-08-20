'use client';

/**
 * PUBLIC enrollment form (step 2) — the legally mandated step. No account
 * required; identity rests on an emailed confirmation link, as with the
 * interest form.
 *
 * Hospital and initiative are chosen first because everything downstream
 * depends on them: TtT replaces the whole form with a continuation attestation,
 * and an already-enrolled pairing must be refused rather than overwritten.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, CalendarDays, MailCheck, Info, Copy } from 'lucide-react';
import { api, ApiError } from '@/lib/api';

type Code = 'SPARK' | 'SOAR' | 'NEST' | 'TTT';
type RoleKey = 'nurse' | 'provider' | 'data' | 'csuite' | 'other';

interface ChampionRole {
  key: RoleKey;
  label: string;
  required: boolean;
  description: string;
}
interface Champion {
  role: RoleKey;
  name: string;
  email: string;
  title: string;
  isPrimary: boolean;
  redcapAccess: boolean;
  dashboardAccess: boolean;
}
interface Config {
  initiatives: Code[];
  ehrOptions: string[];
  championRoles: ChampionRole[];
}
interface WindowState {
  opensAt: string | null;
  closesAt: string | null;
  state: 'before' | 'open' | 'after';
}
interface Ctx {
  hospitalId: string;
  hospitalName: string;
  initiativeCode: Code;
  isTttContinuation: boolean;
  alreadySubmitted: boolean;
  copyableFrom: Array<{ initiativeCode: string; championCount: number }>;
}

const INITIATIVE_NAME: Record<Code, string> = {
  SPARK: 'SPARK: Postpartum Discharge Transitions',
  SOAR: 'SOAR: Primary Cesarean Reduction',
  NEST: 'NEST: Infant Safe Sleep',
  TTT: 'Turning the Tide: Perinatal Substance Use',
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

const emptyChampion = (role: RoleKey): Champion => ({
  role, name: '', email: '', title: '', isPrimary: false, redcapAccess: false, dashboardAccess: false,
});

export default function PublicEnrollmentFormPage() {
  const programYear = parseInt(useParams<{ year: string }>().year, 10);

  const [config, setConfig] = useState<Config | null>(null);
  const [win, setWin] = useState<WindowState | null>(null);
  const [hospitals, setHospitals] = useState<Array<{ id: string; name: string }>>([]);
  const [hospitalId, setHospitalId] = useState('');
  const [initiative, setInitiative] = useState<Code | ''>('');
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [ehr, setEhr] = useState('');
  const [ehrOther, setEhrOther] = useState('');
  const [champions, setChampions] = useState<Champion[]>([]);
  const [attested, setAttested] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<Config>('/public/enrollment-forms/config'),
      api.get<WindowState>(`/public/enrollment-forms/window?programYear=${programYear}`),
      api.get<{ hospitals: Array<{ id: string; name: string }> }>('/public/enrollment-forms/hospitals'),
    ])
      .then(([c, w, h]) => {
        setConfig(c);
        setWin(w);
        setHospitals(h.hospitals);
        setChampions(c.championRoles.map((r) => emptyChampion(r.key)));
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [programYear]);

  const loadCtx = useCallback(async (hid: string, code: Code | '') => {
    setCtx(null);
    setCopyNote(null);
    if (!hid || !code) return;
    try {
      setCtx(await api.get<Ctx>(
        `/public/enrollment-forms/context?programYear=${programYear}&hospitalId=${encodeURIComponent(hid)}&initiativeCode=${code}`,
      ));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load that combination.');
    }
  }, [programYear]);

  function setChampion(roleKey: RoleKey, patch: Partial<Champion>) {
    setChampions((prev) =>
      prev.map((c) => {
        if (c.role !== roleKey) {
          // Exactly one primary: selecting a new one clears the others.
          return patch.isPrimary ? { ...c, isPrimary: false } : c;
        }
        return { ...c, ...patch };
      }),
    );
  }

  /** Explicit, never automatic — champions legitimately differ per initiative. */
  async function copyChampions(from: string) {
    try {
      const res = await api.get<{ champions: Champion[] }>(
        `/public/enrollment-forms/champions-to-copy?programYear=${programYear}&hospitalId=${encodeURIComponent(hospitalId)}&fromInitiative=${from}`,
      );
      const byRole = new Map(res.champions.map((c) => [c.role, c]));
      setChampions((prev) => prev.map((c) => byRole.get(c.role) ?? c));
      setCopyNote(`Champions copied from ${from} — please review, since roles often differ by initiative.`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Could not copy champions.');
    }
  }

  const isTtt = initiative === 'TTT';
  const isOpen = win?.state === 'open';

  const errors: string[] = [];
  if (!hospitalId) errors.push('Choose your hospital.');
  if (!initiative) errors.push('Choose the initiative.');
  if (!name.trim()) errors.push('Your name is required.');
  if (!role.trim()) errors.push('Your role is required.');
  if (!email.trim()) errors.push('Email is required.');
  if (ctx && !isTtt) {
    if (!ehr) errors.push('Select your hospital EHR.');
    if (ehr === 'Other…' && !ehrOther.trim()) errors.push('Tell us which EHR your hospital uses.');
    for (const r of config?.championRoles ?? []) {
      if (!r.required) continue;
      const c = champions.find((x) => x.role === r.key);
      if (!c?.name.trim() || !c?.email.trim() || !c?.title.trim()) {
        errors.push(`${r.label}: name, email and hospital title are all required.`);
      }
    }
    if (champions.filter((c) => c.isPrimary && c.name.trim()).length !== 1) {
      errors.push('Mark exactly one champion as the primary contact.');
    }
  }
  if (ctx && isTtt && !attested) errors.push('Confirm the continuation attestation to submit.');

  const canSubmit = errors.length === 0 && isOpen && !ctx?.alreadySubmitted && !submitting;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ sentTo: string }>('/public/enrollment-forms', {
        programYear,
        hospitalId,
        initiativeCode: initiative,
        submitterName: name,
        submitterRole: role,
        submitterEmail: email,
        ...(isTtt
          ? { tttContinuationAttested: attested }
          : { ehr, ehrOther, champions: champions.filter((c) => c.name.trim() || c.isPrimary) }),
      });
      setSentTo(res.sentTo);
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <Shell><p className="text-sm text-cpcqc-pink-dark">{loadError}</p></Shell>;
  if (!config || !win) return <Shell><p className="text-sm text-cpcqc-purple-dark/70">Loading…</p></Shell>;

  if (sentTo) {
    return (
      <Shell>
        <div className="rounded-2xl bg-white p-8 text-center shadow-card">
          <MailCheck className="mx-auto h-10 w-10 text-cpcqc-teal-dark" />
          <h2 className="mt-3 font-rounded text-xl font-bold text-cpcqc-purple-dark">
            One more step — check your email
          </h2>
          <p className="mt-2 text-sm text-cpcqc-purple-dark/80">
            We&rsquo;ve sent a confirmation link to <strong>{sentTo}</strong>. Enrollment
            isn&rsquo;t complete until you open it.
          </p>
          <p className="mt-3 text-xs text-cpcqc-purple-dark/60">
            Keep that email — the same link is how you edit this submission while the window is
            open.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-6">
        <p className="font-rounded text-xs font-bold uppercase tracking-[0.15em] text-cpcqc-purple-dark/60">
          Step 2 of 2
        </p>
        <h1 className="mt-1 font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          {programYear} CPCQC Enrollment
        </h1>
        <p className="mt-2 max-w-2xl text-cpcqc-purple-dark/80">
          This is the step required under Colorado law — a hospital without a submitted enrollment
          form is not enrolled, regardless of what it ranked on the interest form. Each initiative
          has its own form, so repeat this for any other initiative you were accepted into.
        </p>
      </header>

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
          {win.state === 'open' && win.closesAt && (
            <><strong>Enrollment is open</strong> through {fmtDate(win.closesAt)}.</>
          )}
          {win.state === 'before' && (
            <>
              <strong>Enrollment isn&rsquo;t open yet</strong>
              {win.opensAt ? <> — it opens {fmtDate(win.opensAt)}.</> : '.'} You can look around,
              but submissions aren&rsquo;t accepted yet.
            </>
          )}
          {win.state === 'after' && win.closesAt && (
            <>
              <strong>Enrollment closed</strong> on {fmtDate(win.closesAt)}. Contact qi@cpcqc.org
              if you still need to enroll.
            </>
          )}
        </span>
      </div>

      <form onSubmit={onSubmit} className={'space-y-6 ' + (isOpen ? '' : 'opacity-60')}>
        <fieldset disabled={!isOpen} className="space-y-6">
          <Section title="Hospital and initiative">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Hospital" required>
                <select
                  value={hospitalId}
                  onChange={(e) => { setHospitalId(e.target.value); void loadCtx(e.target.value, initiative); }}
                  className="form-input"
                >
                  <option value="">Select your hospital…</option>
                  {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              </Field>
              <Field label="Initiative" required>
                <select
                  value={initiative}
                  onChange={(e) => { const v = e.target.value as Code | ''; setInitiative(v); void loadCtx(hospitalId, v); }}
                  className="form-input"
                >
                  <option value="">Select…</option>
                  {config.initiatives.map((c) => (
                    <option key={c} value={c}>{INITIATIVE_NAME[c]}</option>
                  ))}
                </select>
              </Field>
            </div>
          </Section>

          {ctx?.alreadySubmitted && (
            <div className="flex gap-2 rounded-xl bg-cpcqc-orange-dark/10 px-4 py-3 text-sm text-cpcqc-orange-dark">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <p>
                <strong>{ctx.hospitalName}</strong> has already submitted a {programYear}{' '}
                {ctx.initiativeCode} enrollment form. To change it, use the link in your
                confirmation email, or contact{' '}
                <a className="underline" href="mailto:qi@cpcqc.org">qi@cpcqc.org</a> — we
                won&rsquo;t overwrite an existing enrollment.
              </p>
            </div>
          )}

          {ctx && !ctx.alreadySubmitted && (
            <>
              <Section title="About you">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label="Name" required>
                    <input value={name} onChange={(e) => setName(e.target.value)} className="form-input" />
                  </Field>
                  <Field label="Your role" required>
                    <input value={role} onChange={(e) => setRole(e.target.value)} className="form-input" />
                  </Field>
                  <Field label="Email" required>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="form-input" />
                  </Field>
                </div>
                <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
                  We&rsquo;ll email this address a link to confirm — it&rsquo;s also how you edit
                  this submission later.
                </p>
              </Section>

              {isTtt ? (
                <Section
                  title="Continuation attestation"
                  description="Turning the Tide runs as a single two-year cohort, so there's nothing to re-enroll — just confirm you're continuing."
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
                      Tide in {programYear} to complete the 2-year cohort. Any champion roster
                      updates should be communicated to{' '}
                      <a className="underline" href="mailto:turningthetide@cpcqc.org">
                        turningthetide@cpcqc.org
                      </a>.
                    </span>
                  </label>
                </Section>
              ) : (
                <>
                  <Section title="Hospital EHR">
                    <Field label="Hospital EHR" required>
                      <select value={ehr} onChange={(e) => setEhr(e.target.value)} className="form-input">
                        <option value="">Select…</option>
                        {config.ehrOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </Field>
                    {ehr === 'Other…' && (
                      <input
                        value={ehrOther}
                        onChange={(e) => setEhrOther(e.target.value)}
                        placeholder="Which EHR does your hospital use?"
                        className="form-input mt-2"
                      />
                    )}
                  </Section>

                  <Section
                    title="Key champions"
                    description="Name, email and hospital title are required for each starred role. Mark exactly one person as the primary contact — this is the individual the CPCQC team will consider the first line of contact for communication."
                  >
                    {ctx.copyableFrom.length > 0 && (
                      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-cpcqc-cream-dark/30 px-3 py-2">
                        <Copy size={14} className="text-cpcqc-purple-dark/70" aria-hidden />
                        <span className="text-xs text-cpcqc-purple-dark/80">Already enrolled elsewhere?</span>
                        {ctx.copyableFrom.map((o) => (
                          <button
                            key={o.initiativeCode}
                            type="button"
                            onClick={() => void copyChampions(o.initiativeCode)}
                            className="rounded-full border border-cpcqc-purple px-3 py-1 text-xs font-bold text-cpcqc-purple transition hover:bg-cpcqc-purple/10"
                          >
                            Copy champions from {o.initiativeCode}
                          </button>
                        ))}
                      </div>
                    )}
                    {copyNote && <p className="mb-3 text-xs text-cpcqc-teal-dark">{copyNote}</p>}

                    <div className="space-y-3">
                      {config.championRoles.map((r) => {
                        const c = champions.find((x) => x.role === r.key) ?? emptyChampion(r.key);
                        return (
                          <div key={r.key} className="rounded-xl border-2 border-cpcqc-purple-dark/15 bg-white p-3">
                            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                              <span className="font-rounded text-sm font-bold text-cpcqc-purple-dark">
                                {r.label}
                                {r.required
                                  ? <span className="ml-0.5 text-cpcqc-pink-dark">*</span>
                                  : <span className="ml-1 text-xs font-normal text-cpcqc-purple-dark/50">(optional)</span>}
                              </span>
                              <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-cpcqc-purple-dark/80">
                                <input
                                  type="radio"
                                  name="primary"
                                  checked={c.isPrimary}
                                  onChange={() => setChampion(r.key, { isPrimary: true })}
                                  className="h-3.5 w-3.5"
                                />
                                Primary contact
                              </label>
                            </div>
                            {r.description && (
                              <p className="mb-2 text-xs text-cpcqc-purple-dark/60">{r.description}</p>
                            )}
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                              <input value={c.name} onChange={(e) => setChampion(r.key, { name: e.target.value })} placeholder="Name" className="form-input" />
                              <input type="email" value={c.email} onChange={(e) => setChampion(r.key, { email: e.target.value })} placeholder="Email" className="form-input" />
                              <input value={c.title} onChange={(e) => setChampion(r.key, { title: e.target.value })} placeholder="Hospital title" className="form-input" />
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                              <label className="inline-flex items-center gap-2 text-xs text-cpcqc-purple-dark/80">
                                <input type="checkbox" checked={c.redcapAccess} onChange={(e) => setChampion(r.key, { redcapAccess: e.target.checked })} className="h-3.5 w-3.5" />
                                Needs REDCap access for data entry
                              </label>
                              <label className="inline-flex items-center gap-2 text-xs text-cpcqc-purple-dark/80">
                                <input type="checkbox" checked={c.dashboardAccess} onChange={(e) => setChampion(r.key, { dashboardAccess: e.target.checked })} className="h-3.5 w-3.5" />
                                Needs access to your hospital&rsquo;s QI data dashboard
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-3 text-xs text-cpcqc-purple-dark/60">
                      Access is requested here and granted by CPCQC separately — we&rsquo;ll follow
                      up with anyone marked above.
                    </p>
                  </Section>
                </>
              )}

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
                {submitting ? 'Submitting…' : isTtt ? 'Submit continuation attestation' : `Enroll in ${initiative}`}
              </button>
            </>
          )}

          {!ctx && (
            <div className="flex gap-2 rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/20 px-4 py-3 text-sm text-cpcqc-purple-dark/80">
              <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
              <p>Choose your hospital and initiative to continue.</p>
            </div>
          )}
        </fieldset>
      </form>
    </Shell>
  );
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
