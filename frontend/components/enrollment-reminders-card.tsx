'use client';

/**
 * Reminds hospitals that still owe an enrollment form. Each reminder goes to
 * whoever the form was sent to: one email per hospital per set of people,
 * with a named link to each form still owed.
 *
 * Preview first, always: it lists every reminder, when each hospital was last
 * reminded, and what is held (a form no email ever reached). A test copy of
 * any reminder goes to the person sending; the send asks once more, then goes
 * in batches. Anything reminded today is left out, so sending again the same
 * day sends nothing twice.
 */

import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, BellRing, ChevronDown, ChevronRight, Send } from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import type { ReminderPreview, WelcomeSendResult } from '@/lib/types';

const SHORT: Record<string, string> = { SPARK: 'SPARK', SOAR: 'SOAR', NEST: 'NEST', TTT: 'TtT' };

async function post<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: 'POST' });
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | { error?: { message?: string } }
    | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return body as T;
}

export function EnrollmentRemindersCard({
  programYear,
  onSent,
}: {
  programYear: number;
  onSent: (text: string, ok: boolean) => void;
}) {
  const [preview, setPreview] = useState<ReminderPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'test' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const q = `programYear=${programYear}`;

  async function load() {
    setBusy('preview');
    setError(null);
    setTestNote(null);
    setOpenIndex(null);
    try {
      const r = await api.get<{ preview: ReminderPreview }>(`/staff/enrollment-forms/reminders?${q}`);
      setPreview(r.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function doTest(index: number) {
    setBusy('test');
    setError(null);
    try {
      const r = await post<{ sentTo: string; emailSent: boolean }>(
        `/api/staff/enrollment-forms/reminders/test?${q}&index=${index}`,
      );
      setTestNote(
        r.emailSent
          ? `Test copy sent to ${r.sentTo}.`
          : `Test copy logged for ${r.sentTo}, but not emailed (no email service on this server).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function doSend() {
    if (!preview) return;
    const n = preview.emails.length;
    if (!window.confirm(`Send ${n} reminder${n === 1 ? '' : 's'} now? This can't be undone.`)) return;
    // Each call sends the next batch of what hasn't been reminded today.
    setBusy('send');
    setError(null);
    setProgress({ done: 0, total: n });
    let sent = 0;
    const failed: WelcomeSendResult['failed'] = [];
    try {
      for (;;) {
        const r = await post<WelcomeSendResult>(`/api/staff/enrollment-forms/reminders/send?${q}&max=20`);
        sent += r.sent;
        failed.push(...r.failed);
        setProgress({ done: sent + failed.length, total: n });
        if (r.remaining === 0 || r.sent + r.failed.length === 0) break;
      }
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : String(err)} ${sent} sent before it stopped. ` +
          'Preview again to see what is left; nothing reminded today goes twice.',
      );
      return;
    } finally {
      setBusy(null);
      setProgress(null);
    }
    void load();
    onSent(
      failed.length === 0
        ? `Sent ${sent} reminder${sent === 1 ? '' : 's'}.`
        : `Sent ${sent} reminders; ${failed.length} failed (${failed
            .map((f) => `${f.hospital}: ${f.toEmail}`)
            .join('; ')}). Resend those forms from the Sent list.`,
      failed.length === 0,
    );
  }

  const hospitalCount = preview ? new Set(preview.emails.flatMap((e) => e.hospitals.map((h) => h.id))).size : 0;

  return (
    <section className="mb-6 rounded-2xl bg-white p-6 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">Enrollment reminders</h2>
          <p className="mt-1 max-w-3xl text-sm text-cpcqc-purple-dark/70">
            Reminds every hospital that still owes a form, by email to whoever the form was sent to.
            You&rsquo;ll see every reminder before anything is sent, and anything already reminded today
            is left out.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple/30 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple hover:text-white disabled:opacity-50"
        >
          <BellRing size={14} aria-hidden />
          {busy === 'preview' ? 'Checking…' : preview ? 'Refresh' : 'Preview reminders'}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">{error}</p>
      )}

      {preview && (
        <div className="mt-5 space-y-4">
          {preview.blocker && (
            <p className="flex gap-2 rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-orange-dark">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>{preview.blocker}</span>
            </p>
          )}

          <p className="text-sm text-cpcqc-purple-dark">
            <strong>
              {preview.emails.length} reminder{preview.emails.length === 1 ? '' : 's'}
            </strong>{' '}
            to {hospitalCount} hospital{hospitalCount === 1 ? '' : 's'}
            {preview.window.closesAt && <>, forms due {fmtDate(preview.window.closesAt)}</>}.
          </p>

          {preview.held.length > 0 && (
            <div className="rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
              <p className="font-bold text-cpcqc-orange-dark">
                Held: {preview.held.length} with no one to remind yet
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {preview.held.map((h, i) => (
                  <li key={i}>
                    {h.hospital}
                    {h.initiative ? ` (${SHORT[h.initiative]})` : ''}: {h.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.emails.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-cpcqc-purple-dark/10">
              <table className="w-full text-left text-sm">
                <thead className="bg-cpcqc-cream-dark/40 text-xs uppercase tracking-wide text-cpcqc-purple-dark/70">
                  <tr>
                    <th className="px-3 py-2">Hospital</th>
                    <th className="px-3 py-2">To</th>
                    <th className="px-3 py-2">Forms owed</th>
                    <th className="px-3 py-2">Last reminded</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {preview.emails.map((e, i) => (
                    <ReminderRow
                      key={`${e.recipients[0]?.email}-${i}`}
                      email={e}
                      open={openIndex === i}
                      onToggle={() => setOpenIndex(openIndex === i ? null : i)}
                      onTest={() => void doTest(i)}
                      testing={busy === 'test'}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.skipped.length > 0 && (
            <details className="text-sm text-cpcqc-purple-dark/80">
              <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                Already reminded today ({preview.skipped.length})
              </summary>
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                {preview.skipped.map((s, i) => (
                  <li key={i}>
                    {s.hospital}
                    {s.initiative ? ` (${SHORT[s.initiative]})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {testNote && <p className="text-sm text-cpcqc-teal-dark">{testNote}</p>}

          {preview.emails.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-t border-cpcqc-purple-dark/10 pt-4">
              <button
                type="button"
                onClick={() => void doTest(openIndex ?? 0)}
                disabled={busy !== null}
                className="rounded-full border border-cpcqc-purple/30 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple hover:text-white disabled:opacity-50"
              >
                {busy === 'test' ? 'Sending test…' : 'Send me a test copy'}
              </button>
              <button
                type="button"
                onClick={() => void doSend()}
                disabled={!!preview.blocker || busy !== null}
                className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
              >
                <Send size={14} aria-hidden />
                {busy === 'send'
                  ? `Sending… ${progress ? `${progress.done} of ${progress.total}` : ''}`
                  : `Send ${preview.emails.length} reminder${preview.emails.length === 1 ? '' : 's'}`}
              </button>
              <span className="text-xs text-cpcqc-purple-dark/60">
                The test copy is the open reminder, or the first one.
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ReminderRow({
  email,
  open,
  onToggle,
  onTest,
  testing,
}: {
  email: ReminderPreview['emails'][number];
  open: boolean;
  onToggle: () => void;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <>
      <tr className={clsx('border-t border-cpcqc-purple-dark/10 align-top', open && 'bg-cpcqc-cream-dark/20')}>
        <td className="px-3 py-2 text-cpcqc-purple-dark">{email.hospitals.map((h) => h.name).join(' + ')}</td>
        <td className="px-3 py-2">
          {email.recipients.map((r) => (
            <span key={r.email} className="block">
              <span className="text-cpcqc-purple-dark">{r.name}</span>{' '}
              <span className="text-xs text-cpcqc-purple-dark/60">{r.email}</span>
            </span>
          ))}
        </td>
        <td className="px-3 py-2 text-cpcqc-purple-dark">
          {[...new Set(email.links.map((l) => SHORT[l.code]))].join(', ')}
        </td>
        <td className="px-3 py-2 text-xs text-cpcqc-purple-dark/70">
          {email.lastReminded ? fmtDate(email.lastReminded) : 'Not yet'}
        </td>
        <td className="px-3 py-2 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:underline"
          >
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {open ? 'Hide' : 'View'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="bg-cpcqc-cream-dark/20">
          <td colSpan={5} className="px-3 pb-3">
            <p className="text-xs font-bold text-cpcqc-purple-dark/70">Subject: {email.subject}</p>
            {/* As recipients see it. Sandboxed (no scripts), and the HTML is
                built server-side with every value escaped. */}
            <iframe
              title={`Reminder to ${email.recipients.map((r) => r.name).join(', ')}`}
              sandbox="allow-same-origin"
              srcDoc={email.html}
              onLoad={(e) => {
                const doc = e.currentTarget.contentDocument;
                if (doc) e.currentTarget.style.height = `${doc.documentElement.scrollHeight + 8}px`;
              }}
              className="mt-1 h-80 w-full rounded-lg border-0 bg-white p-1"
            />
            <button
              type="button"
              onClick={onTest}
              disabled={testing}
              className="mt-2 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:underline disabled:opacity-50"
            >
              Send me this one as a test
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
