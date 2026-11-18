'use client';

/**
 * Staff view of step 2 — the legally mandated enrollment forms.
 *
 * The window is short (Nov 15 – Dec 1) and the question CPCQC asks throughout
 * it is not "what came in" but "who hasn't sent one yet". So the chase list
 * comes first and the submissions table second, rather than the other way
 * round: outstanding hospitals are the work, filed ones are the receipt.
 *
 * Read-only. Enrollment is the record that satisfies the statute — a
 * correction has to come from the hospital, through their own edit link, or
 * the distinction between what CPCQC was told and what CPCQC decided is gone.
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Mail,
  Send,
  UserMinus,
} from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import type {
  EnrollableInitiativeCode,
  EnrollmentCoverage,
  SendEnrollmentFormsResult,
  StaffEnrollmentForm,
  StaffEnrollmentFormSent,
  StaffEnrollmentOverview,
  StaffEnrollmentWithdrawal,
} from '@/lib/types';
import { fmtDate } from '@/lib/format';
import { SendEnrollmentFormDialog } from '@/components/send-enrollment-form-dialog';
import { WelcomeUploadCard } from '@/components/welcome-upload-card';
import { EnrollmentRemindersCard } from '@/components/enrollment-reminders-card';
import { EnrollmentOnboardingCard } from '@/components/enrollment-onboarding-card';

const PROGRAM_YEAR = 2027;

const INITIATIVE_ORDER: EnrollableInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];

const ROLE_LABEL: Record<string, string> = {
  nurse: 'Nurse champion',
  provider: 'Provider champion',
  data: 'Data champion',
  csuite: 'C-suite sponsor',
  other: 'Other champion',
};

type InitiativeFilter = EnrollableInitiativeCode | 'all';

/**
 * A card used once a year, folded to one line so the cards PMs use day to
 * day come first. Closed, it isn't loaded at all; opening it shows the card
 * exactly as before.
 */
function OnceAYear({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mb-2 inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:underline"
      >
        <ChevronDown size={14} aria-hidden /> Hide {title.toLowerCase()}
      </button>
      {children}
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-expanded={false}
      className="mb-6 flex w-full items-center justify-between gap-3 rounded-2xl bg-white px-6 py-3 text-left shadow-card hover:bg-cpcqc-purple/5"
    >
      <span>
        <span className="font-rounded text-sm font-extrabold text-cpcqc-purple-dark">{title}</span>
        <span className="ml-2 text-xs text-cpcqc-purple-dark/60">{summary}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
        Show <ChevronRight size={14} aria-hidden />
      </span>
    </button>
  );
}

export default function StaffEnrollmentFormsPage() {
  const [data, setData] = useState<StaffEnrollmentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<InitiativeFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sendFor, setSendFor] = useState<{
    hospitalId?: string;
    initiative?: EnrollableInitiativeCode;
    /** Set for a resend: the person it went to. */
    toEmail?: string;
    toName?: string | null;
  } | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get<StaffEnrollmentOverview>(`/staff/enrollment-forms?programYear=${PROGRAM_YEAR}`)
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const forms = useMemo(() => {
    if (!data) return [];
    return filter === 'all'
      ? data.forms
      : data.forms.filter((f) => f.initiativeCode === filter);
  }, [data, filter]);

  const filedByHospital = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const f of data?.forms ?? []) {
      if (!m.has(f.hospital.id)) m.set(f.hospital.id, new Set());
      m.get(f.hospital.id)!.add(f.initiativeCode);
    }
    return m;
  }, [data]);

  function handleSent(result: SendEnrollmentFormsResult, hospitalName: string) {
    setSendFor(null);
    const what = `${hospitalName}'s ${result.initiatives.join(', ')} enrollment form${result.initiatives.length === 1 ? '' : 's'}`;
    setNotice({
      ok: result.emailSent,
      text: result.emailSent
        ? `Sent ${what} to ${result.sentTo}.`
        : `Recorded ${what} for ${result.sentTo}, but the email did not go out${result.error ? ` (${result.error})` : ''}. Send it again, or email the link by hand.`,
    });
    setReloadKey((k) => k + 1);
  }

  async function downloadXlsx() {
    try {
      const res = await apiFetch(
        `/api/staff/enrollment-forms/export?programYear=${PROGRAM_YEAR}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cpcqc-${PROGRAM_YEAR}-enrollment-forms.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    }
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          Enrollment Forms
        </h1>
        <p className="mt-1 max-w-3xl text-cpcqc-purple-dark/70">
          Step two of {PROGRAM_YEAR} enrollment — the forms that satisfy the statute.
          Who owes one is worked out from the interest-form acceptances (and, for TtT,
          from the hospitals already in a cohort), so accepting a hospital for an
          initiative is what puts it on this list. Sending a hospital its form from
          here does too, which is how one with no interest form gets on it.
        </p>
        {data?.window.opensAt && data.window.closesAt && (
          <p className="mt-2 text-sm text-cpcqc-purple-dark/60">
            Window: {fmtDate(data.window.opensAt)} – {fmtDate(data.window.closesAt)}
          </p>
        )}
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {notice && (
        <div
          className={clsx(
            'mb-4 flex items-start justify-between gap-3 rounded-xl p-4 text-sm',
            notice.ok
              ? 'bg-cpcqc-teal-dark/10 text-cpcqc-teal-dark'
              : 'bg-cpcqc-orange-dark/10 text-cpcqc-orange-dark',
          )}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs font-bold uppercase tracking-wide hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <OnceAYear title="Welcome-to-enroll emails" summary="Sent once a year, when the acceptance sheet is ready.">
        <WelcomeUploadCard
          programYear={PROGRAM_YEAR}
          onSent={(text, ok) => {
            setNotice({ text, ok });
            setReloadKey((k) => k + 1);
          }}
        />
      </OnceAYear>

      <EnrollmentRemindersCard
        programYear={PROGRAM_YEAR}
        onSent={(text, ok) => setNotice({ text, ok })}
      />

      <EnrollmentOnboardingCard
        programYear={PROGRAM_YEAR}
        onSent={(text, ok) => setNotice({ text, ok })}
      />

      {!data ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {INITIATIVE_ORDER.map((code) => {
              const c = data.coverage.find((x) => x.initiativeCode === code);
              return c ? (
                <CoverageCard
                  key={code}
                  coverage={c}
                  sent={data.sent}
                  withdrawals={data.withdrawals ?? []}
                  onSend={(hospitalId) => setSendFor({ hospitalId, initiative: code })}
                  onChanged={(text, ok) => {
                    setNotice({ text, ok });
                    if (ok) setReloadKey((k) => k + 1);
                  }}
                />
              ) : null;
            })}
          </div>

          {data.sent.length > 0 && (
            <SentList
              sent={data.sent}
              onResend={(s) =>
                setSendFor({
                  hospitalId: s.hospital.id,
                  initiative: s.initiativeCode,
                  toEmail: s.toEmail,
                  toName: s.toName,
                })
              }
            />
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Initiative
            </span>
            {(['all', ...INITIATIVE_ORDER] as InitiativeFilter[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setFilter(v)}
                className={clsx(
                  'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition',
                  filter === v
                    ? 'bg-cpcqc-purple text-white'
                    : 'bg-white text-cpcqc-purple-dark ring-1 ring-cpcqc-purple-dark/15 hover:bg-cpcqc-purple/10',
                )}
              >
                {v === 'all' ? 'All' : v}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSendFor({})}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
            >
              <Send size={12} aria-hidden /> Send enrollment form
            </button>
            <button
              type="button"
              onClick={() => void downloadXlsx()}
              className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
            >
              <Download size={12} aria-hidden /> Export XLSX
            </button>
          </div>

          {forms.length === 0 ? (
            <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
              {data.forms.length === 0
                ? `No enrollment forms submitted yet for ${PROGRAM_YEAR}.`
                : `No ${filter} enrollment forms yet.`}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
              <table className="w-full text-left">
                <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                  <tr>
                    <th className="w-px px-4 py-3" />
                    <th className="px-4 py-3">Hospital</th>
                    <th className="px-4 py-3">Initiative</th>
                    <th className="px-4 py-3">Submitter</th>
                    <th className="px-4 py-3">EHR</th>
                    <th className="px-4 py-3">Champions</th>
                    <th className="px-4 py-3">Confirmed</th>
                    <th className="px-4 py-3">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {forms.map((f) => (
                    <FormRows
                      key={f.id}
                      form={f}
                      expanded={expandedId === f.id}
                      onToggle={() => setExpandedId(expandedId === f.id ? null : f.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {sendFor && (
        <SendEnrollmentFormDialog
          programYear={PROGRAM_YEAR}
          initialHospitalId={sendFor.hospitalId}
          initialInitiative={sendFor.initiative}
          initialToEmail={sendFor.toEmail}
          initialToName={sendFor.toName}
          filed={filedByHospital}
          onCancel={() => setSendFor(null)}
          onSent={handleSent}
        />
      )}
    </div>
  );
}

/**
 * One initiative's chase list.
 *
 * Names, not just a count: "3 outstanding" sends a PM to another screen to
 * find out which three, and in the last week of the window that round trip is
 * the difference between chasing them and not. Each name says when its form
 * was last sent, and sends it (again) in one click.
 *
 * A hospital that won't be enrolling after all — say it switched initiatives
 * before submitting — can be taken off the list, so it stops counting and
 * stops getting reminders. It is listed underneath with an undo.
 */
function CoverageCard({
  coverage,
  sent,
  withdrawals,
  onSend,
  onChanged,
}: {
  coverage: EnrollmentCoverage;
  sent: StaffEnrollmentFormSent[];
  withdrawals: StaffEnrollmentWithdrawal[];
  onSend: (hospitalId: string) => void;
  onChanged: (text: string, ok: boolean) => void;
}) {
  const { initiativeCode, expected, submittedCount, outstanding, unexpectedCount } = coverage;
  const withdrawn = coverage.withdrawn ?? [];
  const done = expected.length > 0 && outstanding.length === 0;
  // `sent` is newest first, so the first match is the latest send.
  const lastSent = (hospitalId: string) =>
    sent.find((s) => s.hospital.id === hospitalId && s.initiativeCode === initiativeCode);
  const withdrawalFor = (hospitalId: string) =>
    withdrawals.find((w) => w.hospital.id === hospitalId && w.initiativeCode === initiativeCode);

  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function takeOff(h: { id: string; name: string }) {
    setBusy(true);
    try {
      await api.post('/staff/enrollment-forms/withdrawals', {
        programYear: PROGRAM_YEAR,
        hospitalId: h.id,
        initiativeCode,
        reason: reason.trim() || undefined,
      });
      setRemoving(null);
      setReason('');
      onChanged(`Took ${h.name} off the ${initiativeCode} list.`, true);
    } catch (err) {
      onChanged((err as Error).message, false);
    } finally {
      setBusy(false);
    }
  }

  async function putBack(h: { id: string; name: string }) {
    const w = withdrawalFor(h.id);
    if (!w) return;
    if (
      !window.confirm(
        `Put ${h.name} back on the ${initiativeCode} list?\n\n` +
          `It will count toward ${initiativeCode} again and get ${initiativeCode} reminders until it submits the form.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.del(`/staff/enrollment-forms/withdrawals/${w.id}`);
      onChanged(`Put ${h.name} back on the ${initiativeCode} list.`, true);
    } catch (err) {
      onChanged((err as Error).message, false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={clsx(
        'rounded-2xl bg-white p-4 shadow-card ring-1',
        done ? 'ring-cpcqc-teal-dark/30' : 'ring-cpcqc-purple-dark/5',
      )}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
          {initiativeCode}
        </h2>
        <span className="text-sm font-semibold text-cpcqc-purple-dark/70">
          {submittedCount} / {expected.length}
        </span>
      </div>

      {expected.length === 0 ? (
        <p className="mt-2 text-xs text-cpcqc-purple-dark/50">
          {initiativeCode === 'TTT'
            ? 'No hospitals continuing TtT this year.'
            : 'Nobody accepted for this initiative yet.'}
        </p>
      ) : done ? (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-cpcqc-teal-dark">
          <CheckCircle2 size={13} aria-hidden /> All expected forms received
        </p>
      ) : (
        <div className="mt-2">
          <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-orange-dark">
            <AlertTriangle size={12} aria-hidden /> {outstanding.length} outstanding
          </p>
          <ul className="mt-1.5 space-y-1 text-sm text-cpcqc-purple-dark/80">
            {outstanding.map((h) => {
              const last = lastSent(h.id);
              return (
                <li key={h.id}>
                  <div className="flex items-start justify-between gap-2">
                    <span>
                      {h.name}
                      {last && (
                        <span className="block text-xs text-cpcqc-purple-dark/50">
                          {last.emailSent ? 'Sent' : 'Send failed'} {fmtDate(last.sentAt)} to{' '}
                          {last.toEmail}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0">
                      <button
                        type="button"
                        onClick={() => onSend(h.id)}
                        title={`Send ${h.name} its ${initiativeCode} enrollment form`}
                        className="rounded-full p-1 text-cpcqc-purple-dark/50 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark"
                        aria-label={`Send ${h.name} its ${initiativeCode} enrollment form`}
                      >
                        <Send size={13} aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoving(removing === h.id ? null : h.id);
                          setReason('');
                        }}
                        title={`Take ${h.name} off the ${initiativeCode} list`}
                        className="rounded-full p-1 text-cpcqc-purple-dark/50 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark"
                        aria-label={`Take ${h.name} off the ${initiativeCode} list`}
                        aria-expanded={removing === h.id}
                      >
                        <UserMinus size={13} aria-hidden />
                      </button>
                    </span>
                  </div>
                  {removing === h.id && (
                    <div className="mt-1.5 rounded-lg bg-cpcqc-purple-dark/5 p-2.5 text-xs text-cpcqc-purple-dark/80">
                      <p>
                        Take {h.name} off the {initiativeCode} list? It won&rsquo;t count toward{' '}
                        {initiativeCode} or get {initiativeCode} reminders. No email is sent, and you can
                        undo this.
                      </p>
                      <label className="mt-2 block">
                        <span className="sr-only">Reason (optional)</span>
                        <input
                          type="text"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={500}
                          placeholder="Reason (optional), e.g. switched to NEST"
                          className="w-full rounded-md border border-cpcqc-purple-dark/15 bg-white px-2 py-1 text-xs"
                        />
                      </label>
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void takeOff(h)}
                          className="rounded-full bg-cpcqc-purple px-3 py-1 font-bold text-white hover:bg-cpcqc-purple-dark disabled:opacity-50"
                        >
                          {busy ? 'Taking off…' : 'Take off list'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRemoving(null)}
                          className="rounded-full px-3 py-1 font-bold text-cpcqc-purple hover:underline"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {withdrawn.length > 0 && (
        <div className="mt-3 border-t border-cpcqc-purple-dark/5 pt-2">
          <p className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/50">
            Taken off this list
          </p>
          <ul className="mt-1 space-y-1 text-xs text-cpcqc-purple-dark/60">
            {withdrawn.map((h) => {
              const w = withdrawalFor(h.id);
              return (
                <li key={h.id} className="flex items-start justify-between gap-2">
                  <span>
                    {h.name}
                    {w && (
                      <span className="block text-cpcqc-purple-dark/50">
                        {w.reason ? `${w.reason} · ` : ''}
                        {fmtDate(w.withdrawnAt)}
                        {w.withdrawnBy ? ` by ${w.withdrawnBy}` : ''}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void putBack(h)}
                    className="shrink-0 font-bold text-cpcqc-purple hover:underline disabled:opacity-50"
                  >
                    Undo
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {unexpectedCount > 0 && (
        <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
          + {unexpectedCount} filed by {unexpectedCount === 1 ? 'a hospital' : 'hospitals'} not
          on the expected list
        </p>
      )}
    </div>
  );
}

/**
 * Every form sent from this screen, newest first: what a PM checks when a
 * hospital says its link never arrived.
 */
/**
 * Every form sent this year, one row per person per form. Resend opens the
 * send dialog filled in from the row, for a champion who asks for it again.
 */
function SentList({
  sent,
  onResend,
}: {
  sent: StaffEnrollmentFormSent[];
  onResend: (s: StaffEnrollmentFormSent) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-6 rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-bold text-cpcqc-purple-dark"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        Sent ({sent.length})
      </button>
      {open && (
        <table className="w-full text-left text-sm">
          <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
            <tr>
              <th className="px-4 py-2">Hospital</th>
              <th className="px-4 py-2">Initiative</th>
              <th className="px-4 py-2">To</th>
              <th className="px-4 py-2">Sent</th>
              <th className="px-4 py-2">By</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {sent.map((s, i) => (
              <tr key={`${s.hospital.id}-${s.initiativeCode}-${s.sentAt}-${i}`} className="border-t border-cpcqc-purple-dark/5">
                <td className="px-4 py-2">{s.hospital.name}</td>
                <td className="px-4 py-2">{s.initiativeCode}</td>
                <td className="px-4 py-2">
                  {s.toName ? `${s.toName} · ` : ''}
                  {s.toEmail}
                </td>
                <td className="px-4 py-2">
                  {fmtDate(s.sentAt)}
                  {!s.emailSent && (
                    <span className="ml-1 text-xs font-semibold text-cpcqc-pink-dark">email failed</span>
                  )}
                </td>
                <td className="px-4 py-2">{s.sentBy ?? '—'}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onResend(s)}
                    className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:underline"
                  >
                    <Send size={12} aria-hidden /> Resend
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Sends a fresh edit link, for a hospital that asks to change its form but no
 * longer has its receipt, or wants someone else to make the change. The
 * hospital still makes the change itself; its earlier link stops working.
 */
function NewEditLinkForm({ form }: { form: StaffEnrollmentForm }) {
  const [toEmail, setToEmail] = useState(form.submitterEmail);
  const [toName, setToName] = useState(form.submitterName);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.trim());

  async function send() {
    const to = toEmail.trim();
    if (!window.confirm(`Send a new edit link to ${to}? The hospital's earlier edit link will stop working.`)) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await api.post<{ sentTo: string; emailSent: boolean }>(
        `/staff/enrollment-forms/${form.id}/edit-link`,
        { toEmail: to, ...(toName.trim() ? { toName: toName.trim() } : {}) },
      );
      setNote({
        ok: true,
        text: r.emailSent
          ? `New edit link sent to ${r.sentTo}.`
          : `New edit link logged for ${r.sentTo}, but not emailed (no email service on this server).`,
      });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const input =
    'rounded-lg border border-cpcqc-purple-dark/20 bg-white px-2.5 py-1.5 text-sm text-cpcqc-purple-dark';
  return (
    <div className="mb-4 rounded-xl border border-cpcqc-purple-dark/10 bg-white p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        Send a new edit link
      </p>
      <p className="mt-0.5 text-xs text-cpcqc-purple-dark/60">
        For a hospital that needs to change this form. They make the change themselves, and their
        earlier link stops working.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={toName}
          onChange={(e) => setToName(e.target.value)}
          placeholder="Name"
          aria-label="Recipient name"
          className={clsx(input, 'w-44')}
        />
        <input
          type="email"
          value={toEmail}
          onChange={(e) => setToEmail(e.target.value)}
          placeholder="Email"
          aria-label="Recipient email"
          className={clsx(input, 'w-64')}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!valid || busy}
          className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
        >
          <Send size={12} aria-hidden />
          {busy ? 'Sending…' : 'Send new edit link'}
        </button>
      </div>
      {note && (
        <p className={clsx('mt-2 text-xs', note.ok ? 'text-cpcqc-teal-dark' : 'text-cpcqc-pink-dark')}>
          {note.text}
        </p>
      )}
    </div>
  );
}

function FormRows({
  form,
  expanded,
  onToggle,
}: {
  form: StaffEnrollmentForm;
  expanded: boolean;
  onToggle: () => void;
}) {
  const ehr =
    form.ehr === 'Other…' && form.ehrOther ? `Other: ${form.ehrOther}` : (form.ehr ?? '—');

  return (
    <>
      <tr
        className={clsx(
          'cursor-pointer border-t border-cpcqc-purple-dark/10 hover:bg-cpcqc-cream-dark/15',
          expanded && 'bg-cpcqc-cream-dark/20',
        )}
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} details for ${form.hospital.name} ${form.initiativeCode}`}
            className="text-cpcqc-purple-dark/60"
          >
            {expanded ? (
              <ChevronDown size={16} aria-hidden />
            ) : (
              <ChevronRight size={16} aria-hidden />
            )}
          </button>
        </td>
        <td className="px-4 py-3 font-semibold text-cpcqc-purple-dark">
          {form.hospital.name}
        </td>
        <td className="px-4 py-3">
          <span className="inline-flex items-center rounded-full bg-cpcqc-purple/15 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
            {form.initiativeCode}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="text-sm text-cpcqc-purple-dark">{form.submitterName}</div>
          <div className="text-xs text-cpcqc-purple-dark/70">{form.submitterRole}</div>
        </td>
        <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">{ehr}</td>
        <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
          {form.tttContinuationAttested && form.champions.length === 0 ? (
            <span className="italic text-cpcqc-purple-dark/60">attestation</span>
          ) : (
            form.champions.length
          )}
        </td>
        <td className="px-4 py-3">
          {form.verifiedAt ? (
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-cpcqc-teal-dark">
              <CheckCircle2 size={12} aria-hidden /> {fmtDate(form.verifiedAt)}
            </span>
          ) : (
            // An unconfirmed form still occupies this hospital's slot for the
            // year, so it is worth a PM's attention rather than a blank cell.
            <span className="inline-flex items-center gap-1 rounded-full bg-cpcqc-orange-dark/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-orange-dark">
              <AlertTriangle size={10} aria-hidden /> Unconfirmed
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
          {fmtDate(form.createdAt)}
        </td>
      </tr>

      {expanded && (
        <tr className="border-t border-cpcqc-purple-dark/10 bg-cpcqc-cream-dark/10">
          <td colSpan={8} className="px-6 py-4">
            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-cpcqc-purple-dark/80">
              <span>
                <strong className="text-cpcqc-purple-dark">Submitted by:</strong>{' '}
                {form.submitterName} ({form.submitterEmail})
              </span>
              <span>
                <strong className="text-cpcqc-purple-dark">Via:</strong>{' '}
                {form.submittedVia === 'portal' ? 'Portal login' : 'Public link'}
              </span>
              {form.updatedAt !== form.createdAt && (
                <span>
                  <strong className="text-cpcqc-purple-dark">Last edited:</strong>{' '}
                  {fmtDate(form.updatedAt)}
                </span>
              )}
            </div>

            <NewEditLinkForm form={form} />

            {form.tttContinuationAttested && form.champions.length === 0 ? (
              <p className="text-sm text-cpcqc-purple-dark/80">
                TtT continuation attested. Champions carry over from the existing cohort,
                so no roster is collected on this form.
              </p>
            ) : form.champions.length === 0 ? (
              <p className="text-sm italic text-cpcqc-purple-dark/60">
                No champions listed.
              </p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                  <tr>
                    <th className="py-1.5 pr-4">Role</th>
                    <th className="py-1.5 pr-4">Name</th>
                    <th className="py-1.5 pr-4">Title</th>
                    <th className="py-1.5 pr-4">Email</th>
                    <th className="py-1.5 pr-4">Access requested</th>
                  </tr>
                </thead>
                <tbody>
                  {form.champions.map((c, i) => (
                    <tr key={`${c.email}-${c.role}-${i}`} className="align-top">
                      <td className="py-1.5 pr-4 text-cpcqc-purple-dark">
                        {ROLE_LABEL[c.role] ?? c.role}
                        {c.isPrimary && (
                          <span className="ml-1.5 rounded-full bg-cpcqc-purple/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cpcqc-purple">
                            Primary
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-4 font-semibold text-cpcqc-purple-dark">
                        {c.name}
                      </td>
                      <td className="py-1.5 pr-4 text-cpcqc-purple-dark/80">{c.title}</td>
                      <td className="py-1.5 pr-4">
                        <a
                          href={`mailto:${c.email}`}
                          className="inline-flex items-center gap-1 text-cpcqc-purple hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Mail size={11} aria-hidden /> {c.email}
                        </a>
                      </td>
                      <td className="py-1.5 pr-4 text-cpcqc-purple-dark/80">
                        {[c.redcapAccess && 'REDCap', c.dashboardAccess && 'Dashboard']
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
