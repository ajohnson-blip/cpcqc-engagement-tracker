'use client';

/**
 * Sends the year's welcome-to-enroll emails from the uploaded acceptances: the
 * Board tab of the enrollment-decisions sheet, as .xlsx or .csv.
 *
 * Preview first, always. It lists every email and who it goes to, and what is
 * held (needs staff action) or skipped (the decision, or already filed or
 * sent). A test copy of any email goes to the person sending; the real send
 * asks once more before it goes, then goes in batches, so no one request runs
 * long enough to time out. Uploading the same sheet again later sends only
 * what hasn't gone yet.
 */

import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ChevronDown, ChevronRight, Send, Upload } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import type { WelcomePreview, WelcomeSendResult } from '@/lib/types';

const SHORT: Record<string, string> = { SPARK: 'SPARK', SOAR: 'SOAR', NEST: 'NEST', TTT: 'TtT' };

async function postSheet<T>(path: string, file: File): Promise<T> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | { error?: { message?: string } }
    | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return body as T;
}

export function WelcomeUploadCard({
  programYear,
  onSent,
}: {
  programYear: number;
  onSent: (text: string, ok: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WelcomePreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'test' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const q = `programYear=${programYear}`;

  async function run<T>(step: 'preview' | 'test' | 'send', path: string): Promise<T | null> {
    if (!file) return null;
    setBusy(step);
    setError(null);
    try {
      return await postSheet<T>(path, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function doPreview() {
    setTestNote(null);
    setOpenIndex(null);
    const p = await run<WelcomePreview>('preview', `/api/staff/enrollment-forms/welcome/preview?${q}`);
    setPreview(p);
  }

  async function doTest(index: number) {
    const r = await run<{ sentTo: string; emailSent: boolean }>(
      'test',
      `/api/staff/enrollment-forms/welcome/test?${q}&index=${index}`,
    );
    if (r) {
      setTestNote(
        r.emailSent
          ? `Test copy sent to ${r.sentTo}.`
          : `Test copy logged for ${r.sentTo}, but not emailed (no email service on this server).`,
      );
    }
  }

  async function doSend() {
    if (!preview || !file) return;
    const n = preview.emails.length;
    if (!window.confirm(`Send ${n} welcome-to-enroll email${n === 1 ? '' : 's'} now? This can't be undone.`)) {
      return;
    }
    // Each call sends the next batch of what hasn't gone yet.
    setBusy('send');
    setError(null);
    setProgress({ done: 0, total: n });
    let sent = 0;
    const failed: WelcomeSendResult['failed'] = [];
    try {
      for (;;) {
        const r = await postSheet<WelcomeSendResult>(`/api/staff/enrollment-forms/welcome/send?${q}&max=20`, file);
        sent += r.sent;
        failed.push(...r.failed);
        setProgress({ done: sent + failed.length, total: n });
        if (r.remaining === 0 || r.sent + r.failed.length === 0) break;
      }
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : String(err)} ${sent} sent before it stopped. ` +
          'Preview again to see what is left; nothing already sent goes twice.',
      );
      return;
    } finally {
      setBusy(null);
      setProgress(null);
    }
    setPreview(null);
    setFile(null);
    onSent(
      failed.length === 0
        ? `Sent ${sent} welcome-to-enroll email${sent === 1 ? '' : 's'}.`
        : `Sent ${sent}; ${failed.length} failed (${failed
            .map((f) => `${f.hospital}: ${f.toEmail}`)
            .join('; ')}). Re-send those from the chase list.`,
      failed.length === 0,
    );
  }

  const hospitalCount = preview ? new Set(preview.emails.flatMap((e) => e.hospitals.map((h) => h.id))).size : 0;

  return (
    <section className="mb-6 rounded-2xl bg-white p-6 shadow-card">
      <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
        Welcome-to-enroll emails
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-cpcqc-purple-dark/70">
        Upload the Board tab of the {programYear} enrollment decisions sheet (.xlsx or .csv). Accept
        and Continuing send that initiative&rsquo;s form: to whoever filed the interest form, or, when
        there wasn&rsquo;t one, in one email to everyone on that initiative&rsquo;s roster. You&rsquo;ll
        see every email before anything is sent.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setError(null);
            setTestNote(null);
          }}
          className="text-sm text-cpcqc-purple-dark file:mr-3 file:rounded-full file:border-0 file:bg-cpcqc-purple/10 file:px-4 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-wide file:text-cpcqc-purple"
        />
        <button
          type="button"
          onClick={doPreview}
          disabled={!file || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple/30 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple hover:text-white disabled:opacity-50"
        >
          <Upload size={14} aria-hidden />
          {busy === 'preview' ? 'Reading…' : 'Preview emails'}
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
              <span>{preview.blocker} Nothing can be sent until the window is open.</span>
            </p>
          )}

          <p className="text-sm text-cpcqc-purple-dark">
            <strong>
              {preview.emails.length} email{preview.emails.length === 1 ? '' : 's'}
            </strong>{' '}
            to {hospitalCount} hospital{hospitalCount === 1 ? '' : 's'}
            {preview.window.closesAt && <>, forms due {fmtDate(preview.window.closesAt)}</>}.
          </p>

          {preview.held.length > 0 && (
            <div className="rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
              <p className="font-bold text-cpcqc-orange-dark">
                Held: {preview.held.length} that can&rsquo;t be sent as things stand
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
                    <th className="px-3 py-2">From</th>
                    <th className="px-3 py-2">Forms</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {preview.emails.map((e, i) => (
                    <EmailRow
                      key={`${e.recipients[0]?.email}-${i}`}
                      email={e}
                      open={openIndex === i}
                      onToggle={() => setOpenIndex(openIndex === i ? null : i)}
                      onTest={() => doTest(i)}
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
                Not sent ({preview.skipped.length})
              </summary>
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                {preview.skipped.map((s, i) => (
                  <li key={i}>
                    {s.hospital}
                    {s.initiative ? ` (${SHORT[s.initiative]})` : ''}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {testNote && <p className="text-sm text-cpcqc-teal-dark">{testNote}</p>}

          <div className="flex flex-wrap items-center gap-3 border-t border-cpcqc-purple-dark/10 pt-4">
            <button
              type="button"
              onClick={() => doTest(openIndex ?? 0)}
              disabled={preview.emails.length === 0 || busy !== null}
              className="rounded-full border border-cpcqc-purple/30 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple hover:text-white disabled:opacity-50"
            >
              {busy === 'test' ? 'Sending test…' : 'Send me a test copy'}
            </button>
            <button
              type="button"
              onClick={doSend}
              disabled={preview.emails.length === 0 || !!preview.blocker || busy !== null}
              className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              <Send size={14} aria-hidden />
              {busy === 'send'
                ? `Sending… ${progress ? `${progress.done} of ${progress.total}` : ''}`
                : `Send ${preview.emails.length} email${preview.emails.length === 1 ? '' : 's'}`}
            </button>
            <span className="text-xs text-cpcqc-purple-dark/60">
              The test copy is the open email, or the first one.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function EmailRow({
  email,
  open,
  onToggle,
  onTest,
  testing,
}: {
  email: WelcomePreview['emails'][number];
  open: boolean;
  onToggle: () => void;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <>
      <tr className={clsx('border-t border-cpcqc-purple-dark/10 align-top', open && 'bg-cpcqc-cream-dark/20')}>
        <td className="px-3 py-2 text-cpcqc-purple-dark">
          {email.hospitals.map((h) => h.name).join(' + ')}
          {email.warning && (
            <p className="mt-1 flex gap-1 text-xs text-cpcqc-orange-dark">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
              {email.warning}
            </p>
          )}
        </td>
        <td className="px-3 py-2">
          {email.recipients.map((r) => (
            <span key={r.email} className="block">
              <span className="text-cpcqc-purple-dark">{r.name}</span>{' '}
              <span className="text-xs text-cpcqc-purple-dark/60">{r.email}</span>
            </span>
          ))}
        </td>
        <td className="px-3 py-2 text-xs text-cpcqc-purple-dark/70">{email.source}</td>
        <td className="px-3 py-2 text-cpcqc-purple-dark">
          {[...new Set(email.links.map((l) => SHORT[l.code]))].join(', ')}
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
              title={`Email to ${email.recipients.map((r) => r.name).join(', ')}`}
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
