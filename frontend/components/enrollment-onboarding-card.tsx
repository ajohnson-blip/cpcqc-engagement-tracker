'use client';

/**
 * Onboarding messages, per initiative.
 *
 * Each initiative's PM writes its onboarding message here, starting from a
 * template: the tracker adds only the greeting and first line naming the
 * hospital, and CPCQC's sign-off. Once saved, every new enrollment receipt for
 * that initiative carries the message, and the champions the form names get it
 * too. Hospitals that submitted before then get it from the send below, which
 * covers only the initiative whose tab is selected, as each PM sends their
 * own: preview first, a test copy to yourself, then the send, in batches.
 * Nobody gets the same version twice. Saving a change makes a new version, and
 * hospitals sent the earlier one are listed so the PM can choose to send it.
 */

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CalendarDays, ChevronDown, ChevronRight, Link2, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import type { OnboardingDetails, OnboardingPreview, OnboardingSendResult, WelcomePlanNote } from '@/lib/types';

type Code = OnboardingDetails['initiativeCode'];
const CODES: Code[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];
const LABEL: Record<Code, string> = { SPARK: 'SPARK', SOAR: 'SOAR', NEST: 'NEST', TTT: 'Turning the Tide' };
const SHORT: Record<string, string> = { SPARK: 'SPARK', SOAR: 'SOAR', NEST: 'NEST', TTT: 'TtT' };
const KIND: Record<OnboardingPreview['emails'][number]['kind'], string> = {
  new: 'New',
  update: 'Update',
  retry: 'Retry',
};

/**
 * What the box starts with: the saved message, or, before one is saved, the
 * template, so a PM sees where to begin without hunting for a button. Not an
 * unsaved change: nothing is lost by leaving it, and the {placeholders} keep
 * it from being saved as is.
 */
function startingText(saved: OnboardingDetails | undefined, template: Template | undefined): string {
  if (saved?.message.trim()) return saved.message;
  return template?.startsFilledIn ? template.text : '';
}

/** Each initiative's starting point, from the server. */
interface Template {
  text: string;
  /** False for Turning the Tide, whose PM decides whether to send anything. */
  startsFilledIn: boolean;
}

export function EnrollmentOnboardingCard({
  programYear,
  onSent,
}: {
  programYear: number;
  onSent: (text: string, ok: boolean) => void;
}) {
  const [details, setDetails] = useState<OnboardingDetails[] | null>(null);
  const [templates, setTemplates] = useState<Partial<Record<Code, Template>>>({});
  const [active, setActive] = useState<Code>('SPARK');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSample, setShowSample] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const q = `programYear=${programYear}`;

  useEffect(() => {
    api
      .get<{ details: OnboardingDetails[]; templates?: Partial<Record<Code, Template>> }>(
        `/staff/enrollment-forms/onboarding/details?${q}`,
      )
      .then((r) => {
        setDetails(r.details);
        setTemplates(r.templates ?? {});
        setMessage(startingText(r.details.find((d) => d.initiativeCode === 'SPARK'), r.templates?.SPARK));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [q]);

  const current = details?.find((d) => d.initiativeCode === active);

  function choose(code: Code) {
    if (code === active) return;
    if (dirty && !window.confirm(`Discard your unsaved changes to the ${LABEL[active]} message?`)) return;
    setActive(code);
    setMessage(startingText(details?.find((d) => d.initiativeCode === code), templates[code]));
    setDirty(false);
    setSaved(null);
    setError(null);
    setShowSample(false);
  }

  function change(text: string) {
    setMessage(text);
    setDirty(true);
    setSaved(null);
  }

  const template = templates[active]?.text ?? '';

  function useTemplate() {
    if (!template) {
      setError("The template didn't load. Refresh the page and try again.");
      return;
    }
    if (message.trim() && message !== template && !window.confirm('Replace what you have written with the template?')) {
      return;
    }
    change(template);
    box.current?.focus();
  }

  /** Puts a named link where the cursor is, so nobody has to remember the format. */
  function addLink() {
    const text = window.prompt('Link text, e.g. "Register for option 1"');
    if (!text?.trim()) return;
    const url = window.prompt('Web address, starting with https://');
    if (!url?.trim()) return;
    const el = box.current;
    const at = el ? el.selectionStart : message.length;
    const end = el ? el.selectionEnd : message.length;
    const link = `[${text.trim()}](${url.trim()})`;
    change(message.slice(0, at) + link + message.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + link.length, at + link.length);
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.put<{ details: OnboardingDetails }>(
        `/staff/enrollment-forms/onboarding/details/${active}?${q}`,
        { message },
      );
      setDetails((all) => (all ?? []).map((d) => (d.initiativeCode === active ? r.details : d)));
      setMessage(r.details.message);
      setDirty(false);
      setSaved(
        r.details.sample
          ? `Saved. New ${LABEL[active]} receipts now include this message.`
          : 'Saved. The message is empty, so receipts say the PM will be in touch.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded-2xl bg-white p-6 shadow-card">
      <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">Onboarding message</h2>
      <p className="mt-1 max-w-3xl text-sm text-cpcqc-purple-dark/70">
        Each initiative&rsquo;s PM writes what hospitals need for onboarding, starting from the template. Once
        saved, every new enrollment receipt for that initiative includes it, and the champions named on the
        form get it too. Hospitals that have already submitted get it from the send below, one initiative at a
        time.
      </p>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {CODES.map((code) => {
          const d = details?.find((x) => x.initiativeCode === code);
          return (
            <button
              key={code}
              type="button"
              role="tab"
              aria-selected={active === code}
              onClick={() => choose(code)}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wide',
                active === code
                  ? 'bg-cpcqc-purple text-white'
                  : 'border border-cpcqc-purple/30 text-cpcqc-purple hover:bg-cpcqc-purple/10',
              )}
            >
              {LABEL[code]}
              <span
                className={clsx(
                  'h-2 w-2 rounded-full',
                  d?.sample ? 'bg-cpcqc-teal-dark' : active === code ? 'bg-white/50' : 'bg-cpcqc-purple-dark/20',
                )}
                aria-label={d?.sample ? 'message saved' : 'no message yet'}
              />
            </button>
          );
        })}
      </div>

      {!details ? (
        <p className="mt-4 text-sm text-cpcqc-purple-dark/60">{error ?? 'Loading…'}</p>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={useTemplate}
              className="rounded-full border border-cpcqc-purple/30 px-3 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple/10"
            >
              Start from the template
            </button>
            <button
              type="button"
              onClick={addLink}
              className="inline-flex items-center gap-1 rounded-full border border-cpcqc-purple/30 px-3 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple/10"
            >
              <Link2 size={14} aria-hidden /> Add a link
            </button>
          </div>

          <label className="block text-xs font-bold text-cpcqc-purple-dark/70">
            {LABEL[active]} onboarding message
            <textarea
              ref={box}
              value={message}
              onChange={(e) => change(e.target.value)}
              rows={13}
              maxLength={6000}
              placeholder="Click Start from the template, or write your own."
              className="mt-1 w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm font-normal leading-relaxed text-cpcqc-purple-dark"
            />
          </label>
          <p className="text-xs text-cpcqc-purple-dark/60">
            Replace everything in {'{curly brackets}'}; the message can&rsquo;t be saved until you do. A link is
            written <code>[link text](https://…)</code>, which hospitals see as just the link text; use{' '}
            <strong>Add a link</strong> to insert one. A bare web address becomes a link too. Hospitals see a
            greeting and a line naming their hospital above your message, and CPCQC&rsquo;s name below it.
          </p>

          {error && <p className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">{error}</p>}
          {saved && <p className="text-sm text-cpcqc-teal-dark">{saved}</p>}
          {!current?.sample && !dirty && message === template && template && (
            <p className="text-sm text-cpcqc-purple-dark/70">
              This is the template. Replace everything in {'{curly brackets}'}, then save.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : `Save ${LABEL[active]} message`}
            </button>
            {current?.sample && (
              <button
                type="button"
                onClick={() => setShowSample((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:underline"
              >
                {showSample ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                {showSample ? 'Hide the email' : 'See the email'}
              </button>
            )}
            <span className="text-xs text-cpcqc-purple-dark/60">
              {current?.updatedAt
                ? `Last saved ${fmtDate(current.updatedAt)}${current.updatedBy ? ` by ${current.updatedBy}` : ''}.`
                : 'Not saved yet: receipts say the PM will be in touch.'}
              {dirty && ' You have unsaved changes.'}
            </span>
          </div>

          {showSample && current?.sample && (
            <div>
              <p className="text-xs font-bold text-cpcqc-purple-dark/70">
                Subject: {current.sample.subject}
                {dirty && ' (as last saved)'}
              </p>
              <EmailFrame title={`${LABEL[active]} onboarding email`} html={current.sample.html} />
            </div>
          )}
        </div>
      )}

      <OnboardingSend programYear={programYear} code={active} dirty={dirty} onSent={onSent} />
    </section>
  );
}

function EmailFrame({ title, html }: { title: string; html: string }) {
  return (
    // As recipients see it. Sandboxed (no scripts), and the HTML is built
    // server-side with every value escaped.
    <iframe
      title={title}
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={(e) => {
        const doc = e.currentTarget.contentDocument;
        if (doc) e.currentTarget.style.height = `${doc.documentElement.scrollHeight + 8}px`;
      }}
      className="mt-1 h-80 w-full rounded-lg border border-cpcqc-purple-dark/10 bg-white p-1"
    />
  );
}

function OnboardingSend({
  programYear,
  code,
  dirty,
  onSent,
}: {
  programYear: number;
  /** The initiative whose tab is selected: the send covers it alone. */
  code: Code;
  /** Unsaved edits above: the send uses the message as last saved. */
  dirty: boolean;
  onSent: (text: string, ok: boolean) => void;
}) {
  const [preview, setPreview] = useState<OnboardingPreview | null>(null);
  const [includeUpdated, setIncludeUpdated] = useState(false);
  const [includeFailed, setIncludeFailed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'test' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // A preview belongs to one initiative: switching tabs starts over.
  useEffect(() => {
    setPreview(null);
    setIncludeUpdated(false);
    setIncludeFailed(false);
    setError(null);
    setTestNote(null);
    setOpenIndex(null);
  }, [code]);

  const query = (updated = includeUpdated, failed = includeFailed) =>
    `programYear=${programYear}&initiative=${code}&includeUpdated=${updated}&includeFailed=${failed}`;

  async function load(updated = includeUpdated, failed = includeFailed) {
    setBusy('preview');
    setError(null);
    setTestNote(null);
    setOpenIndex(null);
    try {
      const r = await api.get<{ preview: OnboardingPreview }>(
        `/staff/enrollment-forms/onboarding?${query(updated, failed)}`,
      );
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
      const r = await api.post<{ sentTo: string; emailSent: boolean }>(
        `/staff/enrollment-forms/onboarding/test?${query()}&index=${index}`,
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
    if (!window.confirm(`Send ${n} ${LABEL[code]} onboarding email${n === 1 ? '' : 's'} now? This can't be undone.`)) {
      return;
    }
    setBusy('send');
    setError(null);
    setProgress({ done: 0, total: n });
    let sent = 0;
    let since: string | null = null;
    const failed: OnboardingSendResult['failed'] = [];
    try {
      // Each call sends the next batch; `since` keeps a run from trying a form twice.
      for (;;) {
        const r: OnboardingSendResult = await api.post<OnboardingSendResult>(
          `/staff/enrollment-forms/onboarding/send?${query()}&max=20${since ? `&since=${encodeURIComponent(since)}` : ''}`,
        );
        since = r.since;
        sent += r.sent;
        failed.push(...r.failed);
        setProgress({ done: sent + failed.length, total: n });
        if (r.remaining === 0 || r.sent + r.failed.length === 0) break;
      }
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : String(err)} ${sent} sent before it stopped. ` +
          'Preview again to see what is left; nobody gets the same message twice.',
      );
      return;
    } finally {
      setBusy(null);
      setProgress(null);
    }
    setIncludeUpdated(false);
    setIncludeFailed(false);
    void load(false, false);
    onSent(
      failed.length === 0
        ? `Sent ${sent} ${LABEL[code]} onboarding email${sent === 1 ? '' : 's'}.`
        : `Sent ${sent} ${LABEL[code]} onboarding emails; ${failed.length} didn't go through (${failed
            .map((f) => `${f.hospital}: ${f.toEmail}`)
            .join('; ')}). They're listed under "Didn't go through" to retry.`,
      failed.length === 0,
    );
  }

  const waiting = preview ? waitingByInitiative(preview.held) : null;

  return (
    <div className="mt-6 border-t border-cpcqc-purple-dark/10 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
            Send {LABEL[code]} onboarding message
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-cpcqc-purple-dark/70">
            To hospitals that have already submitted a {LABEL[code]} enrollment form: one email per form, to
            the person who submitted it and the champions it names. Only {LABEL[code]} is included; choose
            another initiative&rsquo;s tab above to send theirs. You&rsquo;ll see every email before anything
            is sent, and nobody gets the same message twice.
          </p>
          {dirty && (
            <p className="mt-1 text-xs font-bold text-cpcqc-orange-dark">
              You have unsaved changes above. The send uses the message as last saved.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple/30 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:bg-cpcqc-purple hover:text-white disabled:opacity-50"
        >
          <CalendarDays size={14} aria-hidden />
          {busy === 'preview' ? 'Checking…' : preview ? 'Refresh' : `Preview ${LABEL[code]} emails`}
        </button>
      </div>

      {error && <p className="mt-3 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">{error}</p>}

      {preview && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-cpcqc-purple-dark">
            <strong>
              {preview.emails.length} email{preview.emails.length === 1 ? '' : 's'}
            </strong>{' '}
            ready to send for {LABEL[code]}.
          </p>

          {waiting && (waiting.counts.length > 0 || waiting.other.length > 0) && (
            <div className="rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
              <p className="flex gap-2 font-bold text-cpcqc-orange-dark">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                Held back
              </p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {waiting.counts.map(([code, n]) => (
                  <li key={code}>
                    {n} {SHORT[code]} form{n === 1 ? '' : 's'}: no {LABEL[code as Code]} message saved yet.
                  </li>
                ))}
                {waiting.other.map((h, i) => (
                  <li key={i}>
                    {h.hospital}
                    {h.initiative ? ` (${SHORT[h.initiative]})` : ''}: {h.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <OptIn
            notes={preview.updated}
            checked={includeUpdated}
            onChange={(v) => {
              setIncludeUpdated(v);
              void load(v, includeFailed);
            }}
            label={(n) => `Also send the updated message to ${n} form${n === 1 ? '' : 's'} sent an earlier version`}
            title="Sent before the message changed"
          />
          <OptIn
            notes={preview.failed}
            checked={includeFailed}
            onChange={(v) => {
              setIncludeFailed(v);
              void load(includeUpdated, v);
            }}
            label={(n) => `Try again for ${n} that didn't go through`}
            title="Didn't go through"
          />

          {preview.emails.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-cpcqc-purple-dark/10">
              <table className="w-full text-left text-sm">
                <thead className="bg-cpcqc-cream-dark/40 text-xs uppercase tracking-wide text-cpcqc-purple-dark/70">
                  <tr>
                    <th className="px-3 py-2">Hospital</th>
                    <th className="px-3 py-2">Initiative</th>
                    <th className="px-3 py-2">To</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {preview.emails.map((e, i) => (
                    <SendRow
                      key={e.formId}
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
                Already sent ({preview.skipped.length})
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
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
              >
                <Send size={14} aria-hidden />
                {busy === 'send'
                  ? `Sending… ${progress ? `${progress.done} of ${progress.total}` : ''}`
                  : `Send ${preview.emails.length} email${preview.emails.length === 1 ? '' : 's'}`}
              </button>
              <span className="text-xs text-cpcqc-purple-dark/60">The test copy is the open email, or the first one.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Forms held only because their initiative has no message, counted per initiative. */
function waitingByInitiative(held: WelcomePlanNote[]) {
  const counts = new Map<string, number>();
  const other: WelcomePlanNote[] = [];
  for (const h of held) {
    if (h.initiative && /onboarding message yet/.test(h.reason)) {
      counts.set(h.initiative, (counts.get(h.initiative) ?? 0) + 1);
    } else other.push(h);
  }
  return { counts: CODES.filter((c) => counts.has(c)).map((c) => [c, counts.get(c)!] as const), other };
}

function OptIn({
  notes,
  checked,
  onChange,
  label,
  title,
}: {
  notes: WelcomePlanNote[];
  checked: boolean;
  onChange: (v: boolean) => void;
  label: (n: number) => string;
  title: string;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="rounded-lg bg-cpcqc-cream-dark/30 px-3 py-2 text-sm text-cpcqc-purple-dark">
      <label className="flex items-center gap-2 font-bold">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        {label(notes.length)}
      </label>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
          {title} ({notes.length})
        </summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-cpcqc-purple-dark/80">
          {notes.map((n, i) => (
            <li key={i}>
              {n.hospital}
              {n.initiative ? ` (${SHORT[n.initiative]})` : ''}: {n.reason}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function SendRow({
  email,
  open,
  onToggle,
  onTest,
  testing,
}: {
  email: OnboardingPreview['emails'][number];
  open: boolean;
  onToggle: () => void;
  onTest: () => void;
  testing: boolean;
}) {
  return (
    <>
      <tr className={clsx('border-t border-cpcqc-purple-dark/10 align-top', open && 'bg-cpcqc-cream-dark/20')}>
        <td className="px-3 py-2 text-cpcqc-purple-dark">{email.hospital.name}</td>
        <td className="px-3 py-2 text-cpcqc-purple-dark">{SHORT[email.code]}</td>
        <td className="px-3 py-2">
          {email.recipients.map((r) => (
            <span key={r.email} className="block">
              {r.name && <span className="text-cpcqc-purple-dark">{r.name} </span>}
              <span className="text-xs text-cpcqc-purple-dark/60">{r.email}</span>
            </span>
          ))}
        </td>
        <td className="px-3 py-2 text-xs text-cpcqc-purple-dark/70">{KIND[email.kind]}</td>
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
            <EmailFrame title={`Onboarding email to ${email.hospital.name}`} html={email.html} />
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
