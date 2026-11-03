'use client';

/**
 * A QI 1:1's call notes and its aims with their PDSA tests — the advisors'
 * QI Advising Sheet, cut to what they asked to keep: three short notes, the
 * open aims, and for each test of change its stage and one line of learning.
 * A completed aim folds into a one-line list, where it can be reopened.
 *
 * Shared by the staff Manage modal and the hospital's task view, since both
 * edit the same content.
 */

import { format } from 'date-fns';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import type { PdsaStage, PdsaTest, QiAdvisingContent, QiAim } from '@/lib/types';
import {
  DECISIONS,
  DECISION_LABEL,
  MAX_ACTIVE_AIMS,
  MAX_AIMS,
  MAX_TESTS_PER_AIM,
  PDSA_STAGES,
  STAGE_LABEL,
} from '@/lib/qi-advising';
import { fmtDate, fmtPeriod } from '@/lib/format';

// Width is left to each use: full for text boxes, natural for the inline selects.
const FIELD =
  'rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2 text-sm focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30';
const INPUT = `${FIELD} w-full`;
const LABEL = 'mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70';

const NOTE_FIELDS: Array<{ key: 'progress' | 'challenges' | 'priorities'; label: string }> = [
  { key: 'progress', label: 'Progress and successes' },
  { key: 'challenges', label: 'Challenges' },
  { key: 'priorities', label: 'Priority areas before the next 1:1' },
];

interface Props {
  value: QiAdvisingContent;
  onChange: (next: QiAdvisingContent) => void;
  /** The period the aims were carried over from, when this session has none of its own yet. */
  carriedFrom?: string | null;
}

export function QiAdvisingEditor({ value, onChange, carriedFrom }: Props) {
  const aims = value.aims ?? [];
  const set = (patch: Partial<QiAdvisingContent>) => onChange({ ...value, ...patch });
  const setAim = (i: number, aim: QiAim) => set({ aims: aims.map((a, j) => (j === i ? aim : a)) });
  const removeAim = (i: number) => set({ aims: aims.filter((_, j) => j !== i) });
  // Indexes into `aims` are kept so edits land on the right one.
  const indexed = aims.map((aim, i) => ({ aim, i }));
  const active = indexed.filter((a) => !a.aim.completedOn);
  const completed = indexed.filter((a) => a.aim.completedOn);

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">Call notes</h3>
        {NOTE_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className={LABEL}>{f.label}</span>
            <textarea
              rows={2}
              maxLength={2000}
              value={value[f.key] ?? ''}
              onChange={(e) => set({ [f.key]: e.target.value })}
              className={INPUT}
            />
          </label>
        ))}
        {value.notes !== undefined && value.notes !== '' && (
          <label className="block">
            <span className={LABEL}>Other notes</span>
            <textarea
              rows={2}
              maxLength={5000}
              value={value.notes}
              onChange={(e) => set({ notes: e.target.value })}
              className={INPUT}
            />
          </label>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="font-rounded text-base font-extrabold text-cpcqc-purple-dark">
            Aims and PDSA tests
          </h3>
          {carriedFrom && (
            <p className="mt-0.5 text-xs text-cpcqc-purple-dark/60">
              Carried over from the {fmtPeriod(carriedFrom)} 1:1. Update them as the work moves on.
            </p>
          )}
        </div>

        {active.map(({ aim, i }, n) => (
          <ActiveAim
            key={i}
            aim={aim}
            number={n + 1}
            onChange={(next) => setAim(i, next)}
            onComplete={() => setAim(i, { ...aim, completedOn: format(new Date(), 'yyyy-MM-dd') })}
            onRemove={() => removeAim(i)}
          />
        ))}

        {active.length < MAX_ACTIVE_AIMS && aims.length < MAX_AIMS && (
          <button
            type="button"
            onClick={() => set({ aims: [...aims, { statement: '', tests: [] }] })}
            className="inline-flex items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
          >
            <Plus size={13} aria-hidden /> Add an aim
          </button>
        )}

        {completed.length > 0 && (
          <div>
            <h4 className={LABEL}>Completed aims</h4>
            <ul className="space-y-1.5">
              {completed.map(({ aim, i }) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-lg bg-cpcqc-teal/10 px-3 py-2 text-sm text-cpcqc-purple-dark"
                >
                  <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-cpcqc-teal-dark" aria-hidden />
                  <span className="flex-1">
                    {aim.statement}
                    <span className="block text-xs text-cpcqc-purple-dark/60">
                      Completed {fmtDate(aim.completedOn)}
                      {aim.tests.length > 0 &&
                        ` · ${aim.tests.length} PDSA ${aim.tests.length === 1 ? 'test' : 'tests'}`}
                    </span>
                  </span>
                  {active.length < MAX_ACTIVE_AIMS && (
                    <button
                      type="button"
                      onClick={() => setAim(i, { ...aim, completedOn: undefined })}
                      className="shrink-0 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:underline"
                    >
                      Reopen
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeAim(i)}
                    className="shrink-0 rounded-full p-1 text-cpcqc-purple-dark/50 hover:bg-cpcqc-pink-dark/10 hover:text-cpcqc-pink-dark"
                    aria-label={`Remove completed aim: ${aim.statement}`}
                  >
                    <Trash2 size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

/** One open aim: its statement and its PDSA tests. */
function ActiveAim({
  aim,
  number,
  onChange,
  onComplete,
  onRemove,
}: {
  aim: QiAim;
  number: number;
  onChange: (next: QiAim) => void;
  onComplete: () => void;
  onRemove: () => void;
}) {
  const setTest = (k: number, patch: Partial<PdsaTest>) =>
    onChange({ ...aim, tests: aim.tests.map((x, m) => (m === k ? { ...x, ...patch } : x)) });

  return (
    <div className="rounded-xl border border-cpcqc-purple-dark/15 p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <label htmlFor={`aim-${number}`} className={`${LABEL} mb-0`}>
          Aim {number}
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onComplete}
            disabled={!aim.statement.trim()}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-teal-dark hover:bg-cpcqc-teal/15 disabled:opacity-40"
          >
            <CheckCircle2 size={13} aria-hidden /> Mark complete
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-full p-1.5 text-cpcqc-purple-dark/50 hover:bg-cpcqc-pink-dark/10 hover:text-cpcqc-pink-dark"
            aria-label={`Remove aim ${number}`}
          >
            <Trash2 size={15} aria-hidden />
          </button>
        </div>
      </div>
      <textarea
        id={`aim-${number}`}
        rows={2}
        maxLength={500}
        value={aim.statement}
        onChange={(e) => onChange({ ...aim, statement: e.target.value })}
        placeholder="e.g. Increase … from …% to …% by June 2027"
        className={INPUT}
      />

      <div className="mt-3 space-y-2">
        {aim.tests.map((t, k) => (
          <div key={k} className="rounded-lg bg-cpcqc-cream-dark/30 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                maxLength={300}
                value={t.change}
                onChange={(e) => setTest(k, { change: e.target.value })}
                placeholder={`Test ${k + 1}: the change being tried`}
                aria-label={`Aim ${number}, test ${k + 1}: change`}
                className={`${FIELD} min-w-[12rem] flex-1`}
              />
              <select
                value={t.stage}
                onChange={(e) => setTest(k, { stage: e.target.value as PdsaStage })}
                aria-label={`Aim ${number}, test ${k + 1}: PDSA stage`}
                className={FIELD}
              >
                {PDSA_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </select>
              {t.stage === 'act' && (
                <select
                  value={t.decision ?? ''}
                  onChange={(e) =>
                    setTest(k, { decision: (e.target.value || undefined) as PdsaTest['decision'] })
                  }
                  aria-label={`Aim ${number}, test ${k + 1}: decision`}
                  className={FIELD}
                >
                  <option value="">Decision…</option>
                  {DECISIONS.map((d) => (
                    <option key={d} value={d}>
                      {DECISION_LABEL[d]}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => onChange({ ...aim, tests: aim.tests.filter((_, m) => m !== k) })}
                className="rounded-full p-1.5 text-cpcqc-purple-dark/50 hover:bg-cpcqc-pink-dark/10 hover:text-cpcqc-pink-dark"
                aria-label={`Remove aim ${number}, test ${k + 1}`}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
            <input
              type="text"
              maxLength={600}
              value={t.learning ?? ''}
              onChange={(e) => setTest(k, { learning: e.target.value })}
              placeholder="What you learned, or the next step"
              aria-label={`Aim ${number}, test ${k + 1}: learning`}
              className={`${INPUT} mt-2`}
            />
          </div>
        ))}
        {aim.tests.length < MAX_TESTS_PER_AIM && (
          <button
            type="button"
            onClick={() => onChange({ ...aim, tests: [...aim.tests, { change: '', stage: 'plan' }] })}
            className="inline-flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple hover:underline"
          >
            <Plus size={13} aria-hidden /> Add a test
          </button>
        )}
      </div>
    </div>
  );
}

/** Stage pill, also used by the initiative page's summary. */
export function StagePill({ stage }: { stage: PdsaStage }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-cpcqc-purple-dark">
      {STAGE_LABEL[stage]}
    </span>
  );
}

/** Aims and their tests as text; completed aims fold away under their own heading. */
export function AimsList({ aims }: { aims: QiAim[] }) {
  const active = aims.filter((a) => !a.completedOn);
  const completed = aims.filter((a) => a.completedOn);
  if (aims.length === 0) {
    return <p className="text-sm text-cpcqc-purple-dark/60">No aims recorded yet.</p>;
  }
  return (
    <div className="space-y-3">
      {active.length === 0 && (
        <p className="text-sm text-cpcqc-purple-dark/60">No open aims. Add one at the next 1:1.</p>
      )}
      <ol className="space-y-3">
        {active.map((a, i) => (
          <li key={i}>
            <p className="text-sm font-semibold text-cpcqc-purple-dark">
              Aim {i + 1}: {a.statement}
            </p>
            {a.tests.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {a.tests.map((t, k) => (
                  <li key={k} className="flex items-start gap-2 text-sm text-cpcqc-purple-dark/85">
                    <StagePill stage={t.stage} />
                    <span>
                      {t.change}
                      {t.decision && (
                        <span className="font-semibold"> · {DECISION_LABEL[t.decision]}</span>
                      )}
                      {t.learning && (
                        <span className="block text-xs text-cpcqc-purple-dark/60">{t.learning}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      {completed.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70 hover:text-cpcqc-purple">
            Completed aims ({completed.length})
          </summary>
          <ul className="mt-2 space-y-1.5">
            {completed.map((a, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-cpcqc-purple-dark/85">
                <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-cpcqc-teal-dark" aria-hidden />
                <span>
                  {a.statement}
                  <span className="block text-xs text-cpcqc-purple-dark/60">
                    Completed {fmtDate(a.completedOn)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
