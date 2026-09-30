'use client';

/**
 * Staff engagement assistant.
 *
 * Conversation state lives here and is posted back in full each turn — the
 * backend is stateless. The tool trace is shown under each answer rather than
 * hidden: these figures go into grant reports, and a reader should be able to
 * see which query produced a number without asking anyone.
 */
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';

interface ToolTrace {
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
}

interface Reply {
  text: string;
  trace: ToolTrace[];
  stopReason: string;
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  trace?: ToolTrace[];
}

const EXAMPLES = [
  'What percent of hospitals in SPARK attended a 1:1 in Q3 2026?',
  "What is SOAR's data submission rate for Q2 2026?",
  'In Turning the Tide, which months had the highest and lowest data submission rates?',
  'Give me the 2026 engagement numbers for a grant report.',
];

export default function AssistantPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<{ available: boolean }>('/staff/assistant/status')
      .then((r) => setAvailable(r.available))
      .catch(() => setAvailable(false));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, busy]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setError(null);
    setDraft('');
    const next: Turn[] = [...turns, { role: 'user', content: question }];
    setTurns(next);
    setBusy(true);
    try {
      const reply = await api.post<Reply>('/staff/assistant/chat', {
        messages: next.map((t) => ({ role: t.role, content: t.content })),
      });
      setTurns([...next, { role: 'assistant', content: reply.text, trace: reply.trace }]);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.status === 503
            ? 'The assistant is not configured on this environment yet.'
            : err.message
          : 'Something went wrong.';
      setError(message);
      setTurns(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="font-rounded text-2xl font-bold text-cpcqc-purple-dark">
          Engagement assistant
        </h1>
        <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
          Ask about engagement metrics across all four initiatives. Figures come from the same
          definitions as the grant report — late submissions are excluded from reported rates.
        </p>
      </header>

      {available === false && (
        <div className="mb-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          The assistant is not configured on this environment. An{' '}
          <code className="font-mono text-xs">ANTHROPIC_API_KEY</code> needs to be set for the
          backend service.
        </div>
      )}

      {turns.length === 0 && (
        <div className="mb-6 space-y-2">
          <p className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
            Try
          </p>
          {EXAMPLES.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void send(q)}
              disabled={busy || available === false}
              className="block w-full rounded-xl border-2 border-cpcqc-purple/30 bg-white p-3 text-left text-sm text-cpcqc-purple-dark transition hover:border-cpcqc-purple hover:bg-cpcqc-purple/5 disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-4">
        {turns.map((t, i) => (
          <div key={i}>
            {t.role === 'user' ? (
              <div className="ml-auto max-w-[85%] rounded-2xl bg-cpcqc-purple px-4 py-2.5 text-sm text-white">
                {t.content}
              </div>
            ) : (
              <div className="max-w-[95%]">
                <div className="whitespace-pre-wrap rounded-2xl border-2 border-cpcqc-purple/20 bg-white px-4 py-3 text-sm text-cpcqc-purple-dark">
                  {t.content}
                </div>
                {t.trace && t.trace.length > 0 && <Trace trace={t.trace} />}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="text-sm text-cpcqc-purple-dark/60">Querying the tracker…</div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="mt-4 rounded-xl border-2 border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      )}

      <form
        className="mt-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about engagement…"
          disabled={busy || available === false}
          className="flex-1 rounded-xl border-2 border-cpcqc-purple/30 px-4 py-2.5 text-sm outline-none focus:border-cpcqc-purple disabled:bg-gray-50"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim() || available === false}
          className="rounded-xl bg-cpcqc-purple px-5 py-2.5 font-rounded text-sm font-bold text-white transition hover:bg-cpcqc-purple-dark disabled:opacity-40"
        >
          Ask
        </button>
      </form>
    </div>
  );
}

/** Which queries produced the answer, so a number can be checked. */
function Trace({ trace }: { trace: ToolTrace[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/50 hover:text-cpcqc-purple"
      >
        {open ? 'Hide' : 'Show'} how this was calculated ({trace.length})
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 rounded-xl bg-cpcqc-purple/5 p-3">
          {trace.map((t, i) => (
            <div key={i} className="font-mono text-[11px] leading-relaxed text-cpcqc-purple-dark/80">
              <span className={t.ok ? 'font-bold' : 'font-bold text-red-700'}>{t.tool}</span>(
              {JSON.stringify(t.input)}) → {t.summary}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
