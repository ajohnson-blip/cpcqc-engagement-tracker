'use client';

import { useRef, useState } from 'react';
import {
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Database,
} from 'lucide-react';
import { getAccessToken } from '@/lib/api';
import type {
  SparkSyncResult,
  SparkSyncRow,
  SparkSyncCategory,
  NestSyncResult,
  NestSyncRow,
  NestSyncCategory,
  SoarSyncResult,
  SoarSyncRow,
  SoarSyncCategory,
  SyncDisposition,
} from '@/lib/types';

interface RowError {
  sheet: string;
  rowNumber: number;
  reason: string;
}

interface PmImportResult {
  dryRun: boolean;
  counts: { applied: number; skipped: number };
  errors: RowError[];
  stagesChanged: number;
  touchedEnrollmentIds: string[];
  missingSheets: string[];
}

export default function StaffImportsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<PmImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const token = getAccessToken();
      const res = await fetch(
        `/api/staff/imports/pm-workbook?dryRun=${dryRun ? 'true' : 'false'}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type':
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: file,
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(body?.error?.message ?? `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as PmImportResult;
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          PM workbook import
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Upload an updated PM engagement-data workbook (.xlsx) — Enrollment Forms,
          Meeting Attendance, QI Advising, Data Submissions, and HRA Completions sheets
          all flow through in one pass. Safe to upload the same file more than once:
          rows that already exist get updated to match the workbook, and nothing is
          ever deleted. If you fix a typo in the workbook and re-upload, the tracker
          will pick up the correction.
        </p>
      </header>

      <section className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
          1. Choose a workbook
        </h2>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              setError(null);
            }}
            className="block w-full text-sm text-cpcqc-purple-dark file:mr-3 file:rounded-full file:border-0 file:bg-cpcqc-purple file:px-4 file:py-2 file:font-rounded file:text-sm file:font-bold file:uppercase file:tracking-wide file:text-white hover:file:bg-cpcqc-purple/90"
          />
          {file && (
            <button
              type="button"
              onClick={() => {
                setFile(null);
                setResult(null);
                setError(null);
                if (inputRef.current) inputRef.current.value = '';
              }}
              className="rounded-full border border-cpcqc-purple-dark/15 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
            >
              Clear
            </button>
          )}
        </div>
        {file && (
          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-cpcqc-purple-dark/70">
            <FileSpreadsheet size={14} aria-hidden />
            {file.name} · {(file.size / 1024).toFixed(0)} KB
          </p>
        )}

        <h2 className="mt-6 font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
          2. Dry run or apply
        </h2>
        <label className="mt-3 flex items-center gap-2 text-sm text-cpcqc-purple-dark">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => {
              setDryRun(e.target.checked);
              setResult(null);
            }}
            className="h-4 w-4 rounded border-cpcqc-purple-dark/30 text-cpcqc-purple focus:ring-cpcqc-purple"
          />
          <span>
            <span className="font-bold">Dry run</span> — preview what would change without
            writing to the database. Recommended on first upload.
          </span>
        </label>

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            disabled={!file || uploading}
            onClick={handleUpload}
            className="inline-flex items-center gap-2 rounded-full bg-cpcqc-purple px-5 py-2.5 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-purple/90 disabled:opacity-50"
          >
            <Upload size={16} aria-hidden />
            {uploading
              ? 'Uploading…'
              : dryRun
                ? 'Run dry-run import'
                : 'Apply import'}
          </button>
          {!dryRun && file && (
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-cpcqc-pink">
              <AlertTriangle size={14} aria-hidden />
              This will write to the production database.
            </span>
          )}
        </div>
      </section>

      {error && (
        <div className="mt-6 rounded-2xl bg-red-50 p-5 ring-1 ring-red-200">
          <h3 className="font-rounded text-base font-extrabold text-red-700">
            Upload failed
          </h3>
          <p className="mt-1 text-sm text-red-700/90">{error}</p>
        </div>
      )}

      {result && <ResultPanel result={result} />}

      <SparkRedcapSync />

      <NestRedcapSync />

      <SoarRedcapSync />
    </div>
  );
}

function ResultPanel({ result }: { result: PmImportResult }) {
  const hasErrors = result.errors.length > 0;
  return (
    <section className="mt-6 rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
        {result.dryRun ? 'Dry-run results' : 'Import results'}
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Stat
          label={result.dryRun ? 'Would apply' : 'Applied'}
          value={result.counts.applied}
          tone="positive"
        />
        <Stat
          label={result.dryRun ? 'Stages would change' : 'Stages changed'}
          value={result.stagesChanged}
        />
        <Stat label="Errors" value={result.errors.length} tone={hasErrors ? 'warn' : 'neutral'} />
      </div>

      {result.missingSheets.length > 0 && (
        <p className="mt-4 text-xs text-cpcqc-purple-dark/70">
          Sheets not found in the upload (skipped): {result.missingSheets.join(', ')}.
        </p>
      )}

      {hasErrors ? (
        <div className="mt-5">
          <h3 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
            First {Math.min(result.errors.length, 40)} error
            {result.errors.length === 1 ? '' : 's'}
          </h3>
          <ul className="mt-2 max-h-96 overflow-y-auto rounded-xl border border-cpcqc-purple-dark/10 bg-cpcqc-cream/50 p-3 text-xs">
            {result.errors.slice(0, 40).map((e, i) => (
              <li key={i} className="border-b border-cpcqc-purple-dark/5 py-1.5 last:border-b-0">
                <span className="font-semibold text-cpcqc-purple-dark">
                  [{e.sheet} row {e.rowNumber}]
                </span>{' '}
                <span className="text-cpcqc-purple-dark/80">{e.reason}</span>
              </li>
            ))}
          </ul>
          {result.errors.length > 40 && (
            <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
              …and {result.errors.length - 40} more.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-5 inline-flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 size={16} aria-hidden />
          No row errors.{' '}
          {result.dryRun ? 'Uncheck Dry run and re-upload to apply.' : 'Refresh the dashboard to see updated counts.'}
        </p>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'positive' | 'warn';
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-emerald-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : 'text-cpcqc-purple-dark';
  return (
    <div className="rounded-xl border border-cpcqc-purple-dark/10 bg-cpcqc-cream/40 p-3">
      <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
        {label}
      </div>
      <div className={`mt-1 font-rounded text-2xl font-extrabold ${toneClass}`}>{value}</div>
    </div>
  );
}

// =====================================================================
// SPARK · REDCap sync
// =====================================================================

const CATEGORY_META: Record<
  SparkSyncCategory,
  { label: string; className: string }
> = {
  counting: { label: 'Counts', className: 'bg-emerald-100 text-emerald-800' },
  complete_nodate: { label: 'Counts (no date)', className: 'bg-emerald-100 text-emerald-800' },
  complete_late: { label: 'Late', className: 'bg-amber-100 text-amber-800' },
  incomplete: { label: 'Incomplete', className: 'bg-orange-100 text-orange-800' },
  not_submitted: { label: 'Not submitted', className: 'bg-red-100 text-red-700' },
  pending: { label: 'Pending', className: 'bg-slate-100 text-slate-600' },
};

// ---- Human-in-the-loop overrides (shared by both REDCap sync cards) ----

const SYNC_DISPOSITIONS: ReadonlyArray<{ value: SyncDisposition; label: string }> = [
  { value: 'counts', label: 'Counts' },
  { value: 'late', label: 'Late' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'not_submitted', label: 'Not submitted' },
  { value: 'pending', label: 'Pending' },
];

function categoryToDisposition(category: string): SyncDisposition {
  switch (category) {
    case 'counting':
    case 'complete_nodate':
      return 'counts';
    case 'complete_late':
      return 'late';
    case 'incomplete':
      return 'incomplete';
    case 'not_submitted':
      return 'not_submitted';
    default:
      return 'pending';
  }
}

type OverrideMap = Record<string, { disposition?: SyncDisposition; comment?: string }>;

type OverrideRow = {
  taskId: string;
  category: string;
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
};

/** The status a row defaults to: a prior manual override if one exists, else
 *  the freshly-computed value from REDCap. */
function defaultDisposition(row: OverrideRow): SyncDisposition {
  return row.priorOverride?.disposition ?? categoryToDisposition(row.category);
}

/** Build the overrides array to POST: exactly the rows the PM touched this
 *  session. Untouched rows (incl. prior overrides) are left for the server,
 *  which preserves prior overrides and computes the rest. */
function buildOverridesPayload(
  rows: ReadonlyArray<OverrideRow>,
  overrides: OverrideMap,
): Array<{ taskId: string; disposition: SyncDisposition; comment: string }> {
  const byId = new Map(rows.map((r) => [r.taskId, r]));
  const out: Array<{ taskId: string; disposition: SyncDisposition; comment: string }> = [];
  for (const taskId of Object.keys(overrides)) {
    const r = byId.get(taskId);
    if (!r) continue;
    out.push({
      taskId,
      disposition: overrides[taskId]?.disposition ?? defaultDisposition(r),
      comment: overrides[taskId]?.comment ?? r.priorOverride?.comment ?? '',
    });
  }
  return out;
}

/** Editable status + comment cells for a preview row (disabled once applied). */
function OverrideCells({
  row,
  overrides,
  setOverrides,
  editable,
}: {
  row: OverrideRow;
  overrides: OverrideMap;
  setOverrides: (fn: (o: OverrideMap) => OverrideMap) => void;
  editable: boolean;
}) {
  const computedDef = categoryToDisposition(row.category);
  const touched = !!overrides[row.taskId];
  const disposition = overrides[row.taskId]?.disposition ?? defaultDisposition(row);
  const comment = overrides[row.taskId]?.comment ?? row.priorOverride?.comment ?? '';
  // "Overridden" = the value that will apply differs from what REDCap computed.
  const overridden = disposition !== computedDef;
  const preserved = !!row.priorOverride && !touched;
  return (
    <>
      <td className="px-3 py-2">
        <select
          value={disposition}
          disabled={!editable}
          onChange={(e) =>
            setOverrides((o) => ({
              ...o,
              [row.taskId]: { ...o[row.taskId], disposition: e.target.value as SyncDisposition },
            }))
          }
          className={`rounded-md border px-2 py-1 text-xs font-semibold disabled:opacity-70 ${
            overridden ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-cpcqc-purple-dark/20 bg-white'
          }`}
        >
          {SYNC_DISPOSITIONS.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
        {preserved && (
          <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            manual · preserved
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={comment}
          disabled={!editable}
          placeholder={overridden ? 'Rationale (required)' : 'Rationale…'}
          onChange={(e) =>
            setOverrides((o) => ({
              ...o,
              [row.taskId]: { ...o[row.taskId], comment: e.target.value },
            }))
          }
          className={`w-44 rounded-md border px-2 py-1 text-xs disabled:opacity-70 ${
            overridden && !comment.trim()
              ? 'border-amber-400 bg-amber-50'
              : 'border-cpcqc-purple-dark/20 bg-white'
          }`}
        />
      </td>
    </>
  );
}

function statusToDisposition(status: string, outcome: string | null): SyncDisposition {
  if (status === 'not_started') return 'pending';
  if (status === 'needs_revision') return 'incomplete';
  if (status === 'complete') {
    if (outcome === 'late') return 'late';
    if (outcome === 'not_submitted') return 'not_submitted';
    return 'counts';
  }
  return 'pending';
}

function dispositionLabel(d: SyncDisposition): string {
  return SYNC_DISPOSITIONS.find((o) => o.value === d)?.label ?? d;
}

function fmtShort(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Read-only status + comment cells for a finalized (locked) row. */
function LockedCells({
  row,
}: {
  row: { newStatus: string; newOutcome: string | null; note: string; finalizedAt: string | null; finalizedBy: string | null };
}) {
  return (
    <>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-bold text-slate-700">
          🔒 {dispositionLabel(statusToDisposition(row.newStatus, row.newOutcome))}
        </span>
        <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">
          Finalized {fmtShort(row.finalizedAt)}
          {row.finalizedBy ? ` · ${row.finalizedBy}` : ''}
        </div>
      </td>
      <td className="px-3 py-2 text-xs text-cpcqc-purple-dark/60">{row.note}</td>
    </>
  );
}

/** Per-month lock control shown in each period-group header. */
function FinalizeButton({
  program,
  period,
  finalized,
  onDone,
}: {
  program: 'SPARK' | 'NEST' | 'SOAR';
  period: string;
  finalized: boolean;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      const token = getAccessToken();
      const res = await fetch('/api/staff/imports/redcap/finalize', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ program, period, finalize: !finalized }),
      });
      if (!res.ok) throw new Error(`Finalize failed (${res.status})`);
      await onDone();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void toggle()}
      className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide disabled:opacity-50 ${
        finalized
          ? 'border border-slate-300 text-slate-600 hover:bg-slate-100'
          : 'bg-cpcqc-teal-dark text-white hover:bg-cpcqc-teal-dark/90'
      }`}
    >
      {busy ? '…' : finalized ? '🔓 Unlock month' : '🔒 Finalize month'}
    </button>
  );
}

function SparkRedcapSync() {
  const [loading, setLoading] = useState<false | 'preview' | 'apply'>(false);
  const [result, setResult] = useState<SparkSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<OverrideMap>({});

  async function run(dryRun: boolean) {
    setLoading(dryRun ? 'preview' : 'apply');
    setError(null);
    try {
      const token = getAccessToken();
      const res = await fetch(`/api/staff/imports/redcap/spark?dryRun=${dryRun ? 'true' : 'false'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: dryRun
          ? undefined
          : JSON.stringify({ overrides: buildOverridesPayload(result?.rows ?? [], overrides) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Sync failed (${res.status})`);
      }
      if (dryRun) setOverrides({}); // fresh preview clears prior edits
      setResult((await res.json()) as SparkSyncResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const editable = result?.dryRun ?? false;
  const overrideCount = result ? buildOverridesPayload(result.rows, overrides).length : 0;
  const byQuarter = (result?.rows ?? []).reduce<Record<string, SparkSyncRow[]>>((acc, r) => {
    (acc[r.quarter] ??= []).push(r);
    return acc;
  }, {});

  return (
    <section className="mt-10 border-t border-cpcqc-purple-dark/10 pt-8">
      <header className="mb-4">
        <h1 className="inline-flex items-center gap-2 font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          <Database size={26} aria-hidden /> SPARK · REDCap sync
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Pull SPARK quarterly data straight from REDCap and update each hospital&rsquo;s
          data-submission tasks — no spreadsheet needed. A submission counts only when it is{' '}
          <strong>complete and on time</strong>. In the preview you can <strong>override any
          status</strong> and add a rationale before applying; nothing is written until you apply.
        </p>
      </header>

      <div className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading !== false}
            onClick={() => void run(true)}
            className="inline-flex items-center gap-2 rounded-full bg-cpcqc-purple px-5 py-2.5 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-purple/90 disabled:opacity-50"
          >
            <RefreshCw size={16} aria-hidden className={loading === 'preview' ? 'animate-spin' : ''} />
            {loading === 'preview' ? 'Pulling from REDCap…' : 'Preview from REDCap'}
          </button>

          {result && !result.dryRun ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
              <CheckCircle2 size={16} aria-hidden /> Applied {result.counts.willChange} change
              {result.counts.willChange === 1 ? '' : 's'}.
            </span>
          ) : (
            result && (
              <button
                type="button"
                disabled={loading !== false}
                onClick={() => void run(false)}
                className="inline-flex items-center gap-2 rounded-full bg-cpcqc-pink px-5 py-2.5 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-pink/90 disabled:opacity-50"
              >
                <AlertTriangle size={16} aria-hidden />
                {loading === 'apply' ? 'Applying…' : 'Apply changes'}
              </button>
            )
          )}
          {result && result.dryRun && overrideCount > 0 && (
            <span className="text-xs font-semibold text-amber-700">
              {overrideCount} manual override{overrideCount === 1 ? '' : 's'} pending
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">
            {error}
          </div>
        )}
      </div>

      {result && (
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
              {result.dryRun ? 'Dry-run preview' : 'Applied'} · {result.programYear}
            </h2>
            <span className="text-xs text-cpcqc-purple-dark/60">
              {result.recordsFetched} REDCap rows · pulled{' '}
              {new Date(result.fetchedAt).toLocaleString()}
            </span>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label={result.dryRun ? 'Will change' : 'Changed'}
              value={result.counts.willChange}
              tone={result.counts.willChange > 0 ? 'positive' : 'neutral'}
            />
            <Stat label="Counting" value={result.counts.counting} tone="positive" />
            <Stat label="Incomplete" value={result.counts.incomplete} tone="warn" />
            <Stat label="Late" value={result.counts.completeLate} tone="warn" />
            <Stat label="Not submitted" value={result.counts.notSubmitted} />
            <Stat
              label="Dup records"
              value={result.counts.duplicates}
              tone={result.counts.duplicates > 0 ? 'warn' : 'neutral'}
            />
          </div>

          {result.warnings.length > 0 && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="flex items-center gap-1.5 font-rounded text-sm font-extrabold text-amber-800">
                <AlertTriangle size={14} aria-hidden /> {result.warnings.length} item
                {result.warnings.length === 1 ? '' : 's'} need attention
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-amber-900/90">
                {result.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 space-y-6">
            {result.quartersInScope.map((q) => {
              const rows = byQuarter[q] ?? [];
              if (rows.length === 0) return null;
              const finalized = rows[0]?.finalized ?? false;
              return (
                <div key={q}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
                      {q}
                    </h3>
                    <FinalizeButton program="SPARK" period={q} finalized={finalized} onDone={() => run(true)} />
                  </div>
                  <div className="mt-2 overflow-x-auto rounded-xl border border-cpcqc-purple-dark/10">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-cpcqc-cream/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                        <tr>
                          <th className="px-3 py-2">Hospital</th>
                          <th className="px-3 py-2">System</th>
                          <th className="px-3 py-2">Status (override)</th>
                          <th className="px-3 py-2">Comments</th>
                          <th className="px-3 py-2">Submitted</th>
                          <th className="px-3 py-2">%</th>
                          <th className="px-3 py-2">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => {
                          const meta = CATEGORY_META[r.category];
                          const isOverridden =
                            (overrides[r.taskId]?.disposition ?? defaultDisposition(r)) !==
                            categoryToDisposition(r.category);
                          return (
                            <tr
                              key={`${r.dagCode}-${r.quarter}`}
                              className={`border-t border-cpcqc-purple-dark/10 ${
                                isOverridden ? 'bg-amber-50' : r.willChange ? 'bg-cpcqc-purple/5' : ''
                              }`}
                            >
                              <td className="px-3 py-2 font-semibold text-cpcqc-purple-dark">
                                {r.hospitalName}
                                {r.duplicateRecords && (
                                  <span className="ml-1 text-amber-600" title="Multiple competing REDCap records">
                                    ⚠
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${meta.className}`}>
                                  {meta.label}
                                </span>
                              </td>
                              {r.finalized ? (
                                <LockedCells row={r} />
                              ) : (
                                <OverrideCells
                                  row={r}
                                  overrides={overrides}
                                  setOverrides={setOverrides}
                                  editable={editable}
                                />
                              )}
                              <td className="px-3 py-2 text-cpcqc-purple-dark/80">
                                {r.submissionDate ?? (r.submitted ? '(no date)' : '—')}
                              </td>
                              <td className="px-3 py-2 text-cpcqc-purple-dark/80">
                                {r.pctComplete === null ? '—' : `${r.pctComplete}%`}
                              </td>
                              <td className="px-3 py-2 text-xs text-cpcqc-purple-dark/70">{r.note}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// =====================================================================
// NEST · REDCap sync (monthly; two forms; strict completeness)
// =====================================================================

const NEST_CATEGORY_META: Record<NestSyncCategory, { label: string; className: string }> = {
  counting: { label: 'Counts', className: 'bg-emerald-100 text-emerald-800' },
  complete_nodate: { label: 'Counts (no date)', className: 'bg-emerald-100 text-emerald-800' },
  complete_late: { label: 'Late', className: 'bg-amber-100 text-amber-800' },
  incomplete: { label: 'Incomplete', className: 'bg-orange-100 text-orange-800' },
  not_submitted: { label: 'Not submitted', className: 'bg-red-100 text-red-700' },
  pending: { label: 'Pending', className: 'bg-slate-100 text-slate-600' },
};

function NestRedcapSync() {
  const [loading, setLoading] = useState<false | 'preview' | 'apply'>(false);
  const [result, setResult] = useState<NestSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<OverrideMap>({});

  async function run(dryRun: boolean) {
    setLoading(dryRun ? 'preview' : 'apply');
    setError(null);
    try {
      const token = getAccessToken();
      const res = await fetch(`/api/staff/imports/redcap/nest?dryRun=${dryRun ? 'true' : 'false'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: dryRun
          ? undefined
          : JSON.stringify({ overrides: buildOverridesPayload(result?.rows ?? [], overrides) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Sync failed (${res.status})`);
      }
      if (dryRun) setOverrides({});
      setResult((await res.json()) as NestSyncResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const editable = result?.dryRun ?? false;
  const overrideCount = result ? buildOverridesPayload(result.rows, overrides).length : 0;
  const byPeriod = (result?.rows ?? []).reduce<Record<string, NestSyncRow[]>>((acc, r) => {
    (acc[r.period] ??= []).push(r);
    return acc;
  }, {});

  return (
    <section className="mt-10 border-t border-cpcqc-purple-dark/10 pt-8">
      <header className="mb-4">
        <h1 className="inline-flex items-center gap-2 font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          <Database size={26} aria-hidden /> NEST · REDCap sync
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Pull NEST monthly data (safe-sleep audit + chart reviews) straight from REDCap. A month
          counts only when <strong>both forms are submitted, every row is complete, and it&rsquo;s on
          time</strong>. In the preview you can <strong>override any status</strong> and add a
          rationale before applying; nothing is written until you apply.
        </p>
      </header>

      <div className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading !== false}
            onClick={() => void run(true)}
            className="inline-flex items-center gap-2 rounded-full bg-cpcqc-purple px-5 py-2.5 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-purple/90 disabled:opacity-50"
          >
            <RefreshCw size={16} aria-hidden className={loading === 'preview' ? 'animate-spin' : ''} />
            {loading === 'preview' ? 'Pulling from REDCap…' : 'Preview from REDCap'}
          </button>

          {result && !result.dryRun ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
              <CheckCircle2 size={16} aria-hidden /> Applied {result.counts.willChange} change
              {result.counts.willChange === 1 ? '' : 's'}.
            </span>
          ) : (
            result && (
              <button
                type="button"
                disabled={loading !== false}
                onClick={() => void run(false)}
                className="inline-flex items-center gap-2 rounded-full bg-cpcqc-pink px-5 py-2.5 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-pink/90 disabled:opacity-50"
              >
                <AlertTriangle size={16} aria-hidden />
                {loading === 'apply' ? 'Applying…' : 'Apply changes'}
              </button>
            )
          )}
          {result && result.dryRun && overrideCount > 0 && (
            <span className="text-xs font-semibold text-amber-700">
              {overrideCount} manual override{overrideCount === 1 ? '' : 's'} pending
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">
            {error}
          </div>
        )}
      </div>

      {result && (
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
              {result.dryRun ? 'Dry-run preview' : 'Applied'} · {result.programYear}
            </h2>
            <span className="text-xs text-cpcqc-purple-dark/60">
              {result.recordsFetched} REDCap rows · pulled {new Date(result.fetchedAt).toLocaleString()}
            </span>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label={result.dryRun ? 'Will change' : 'Changed'}
              value={result.counts.willChange}
              tone={result.counts.willChange > 0 ? 'positive' : 'neutral'}
            />
            <Stat label="Counting" value={result.counts.counting} tone="positive" />
            <Stat label="Incomplete" value={result.counts.incomplete} tone="warn" />
            <Stat label="Late" value={result.counts.completeLate} tone="warn" />
            <Stat label="Not submitted" value={result.counts.notSubmitted} />
            <Stat label="Pending" value={result.counts.pending} />
          </div>

          {result.warnings.length > 0 && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="flex items-center gap-1.5 font-rounded text-sm font-extrabold text-amber-800">
                <AlertTriangle size={14} aria-hidden /> {result.warnings.length} item
                {result.warnings.length === 1 ? '' : 's'} need attention
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-amber-900/90">
                {result.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 space-y-6">
            {result.periodsInScope.map((p) => {
              const rows = byPeriod[p] ?? [];
              if (rows.length === 0) return null;
              const finalized = rows[0]?.finalized ?? false;
              return (
                <div key={p}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
                      {p}
                    </h3>
                    <FinalizeButton program="NEST" period={p} finalized={finalized} onDone={() => run(true)} />
                  </div>
                  <div className="mt-2 overflow-x-auto rounded-xl border border-cpcqc-purple-dark/10">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-cpcqc-cream/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                        <tr>
                          <th className="px-3 py-2">Hospital</th>
                          <th className="px-3 py-2">System</th>
                          <th className="px-3 py-2">Status (override)</th>
                          <th className="px-3 py-2">Comments</th>
                          <th className="px-3 py-2">SSP</th>
                          <th className="px-3 py-2">Chart</th>
                          <th className="px-3 py-2">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => {
                          const meta = NEST_CATEGORY_META[r.category];
                          const isOverridden =
                            (overrides[r.taskId]?.disposition ?? defaultDisposition(r)) !==
                            categoryToDisposition(r.category);
                          return (
                            <tr
                              key={`${r.dagCode}-${r.period}`}
                              className={`border-t border-cpcqc-purple-dark/10 ${
                                isOverridden ? 'bg-amber-50' : r.willChange ? 'bg-cpcqc-purple/5' : ''
                              }`}
                            >
                              <td className="px-3 py-2 font-semibold text-cpcqc-purple-dark">
                                {r.hospitalName}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${meta.className}`}>
                                  {meta.label}
                                </span>
                              </td>
                              {r.finalized ? (
                                <LockedCells row={r} />
                              ) : (
                                <OverrideCells
                                  row={r}
                                  overrides={overrides}
                                  setOverrides={setOverrides}
                                  editable={editable}
                                />
                              )}
                              <td className="px-3 py-2 text-cpcqc-purple-dark/80">
                                {r.sspSubmitted ? `${r.sspComplete}/${r.sspRows}` : '—'}
                              </td>
                              <td className="px-3 py-2 text-cpcqc-purple-dark/80">
                                {r.chartSubmitted ? `${r.chartComplete}/${r.chartRows}` : '—'}
                              </td>
                              <td className="px-3 py-2 text-xs text-cpcqc-purple-dark/70">{r.note}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// =====================================================================
// SOAR · REDCap sync (monthly; patient-level NTSV + No-NTSV attestation)
// =====================================================================

const SOAR_CATEGORY_META: Record<SoarSyncCategory, { label: string; className: string }> = {
  counting: { label: 'Counts', className: 'bg-emerald-100 text-emerald-800' },
  complete_nodate: { label: 'Counts (no date)', className: 'bg-emerald-100 text-emerald-800' },
  complete_late: { label: 'Late', className: 'bg-amber-100 text-amber-800' },
  incomplete: { label: 'Incomplete', className: 'bg-orange-100 text-orange-800' },
  not_submitted: { label: 'Not submitted', className: 'bg-red-100 text-red-700' },
  pending: { label: 'Pending', className: 'bg-slate-100 text-slate-600' },
};

function SoarRedcapSync() {
  const [loading, setLoading] = useState<false | 'preview' | 'apply'>(false);
  const [result, setResult] = useState<SoarSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<OverrideMap>({});

  async function run(dryRun: boolean) {
    setLoading(dryRun ? 'preview' : 'apply');
    setError(null);
    try {
      const token = getAccessToken();
      const res = await fetch(`/api/staff/imports/redcap/soar?dryRun=${dryRun ? 'true' : 'false'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: dryRun
          ? undefined
          : JSON.stringify({ overrides: buildOverridesPayload(result?.rows ?? [], overrides) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `Sync failed (${res.status})`);
      }
      if (dryRun) setOverrides({});
      setResult((await res.json()) as SoarSyncResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const editable = result?.dryRun ?? false;
  const overrideCount = result ? buildOverridesPayload(result.rows, overrides).length : 0;
  const byPeriod = (result?.rows ?? []).reduce<Record<string, SoarSyncRow[]>>((acc, r) => {
    (acc[r.period] ??= []).push(r);
    return acc;
  }, {});

  return (
    <section className="mt-10 border-t border-cpcqc-purple-dark/10 pt-8">
      <header className="mb-4">
        <h1 className="inline-flex items-center gap-2 font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          <Database size={26} aria-hidden /> SOAR · REDCap sync
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Pull SOAR monthly NTSV cesarean data straight from REDCap. A month counts when{' '}
          <strong>every NTSV case is complete and on time</strong> — or when the hospital files a{' '}
          <strong>zero-case attestation</strong> (No-NTSV). In the preview you can{' '}
          <strong>override any status</strong> and add a rationale before applying; nothing is
          written until you apply.
        </p>
      </header>

      <div className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading !== false}
            onClick={() => void run(true)}
            className="inline-flex items-center gap-2 rounded-full bg-cpcqc-purple px-5 py-2.5 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-purple/90 disabled:opacity-50"
          >
            <RefreshCw size={16} aria-hidden className={loading === 'preview' ? 'animate-spin' : ''} />
            {loading === 'preview' ? 'Pulling from REDCap…' : 'Preview from REDCap'}
          </button>

          {result && !result.dryRun ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
              <CheckCircle2 size={16} aria-hidden /> Applied {result.counts.willChange} change
              {result.counts.willChange === 1 ? '' : 's'}.
            </span>
          ) : (
            result && (
              <button
                type="button"
                disabled={loading !== false}
                onClick={() => void run(false)}
                className="inline-flex items-center gap-2 rounded-full bg-cpcqc-pink px-5 py-2.5 font-rounded text-sm font-bold uppercase tracking-wide text-white shadow-sm hover:bg-cpcqc-pink/90 disabled:opacity-50"
              >
                <AlertTriangle size={16} aria-hidden />
                {loading === 'apply' ? 'Applying…' : 'Apply changes'}
              </button>
            )
          )}
          {result && result.dryRun && overrideCount > 0 && (
            <span className="text-xs font-semibold text-amber-700">
              {overrideCount} manual override{overrideCount === 1 ? '' : 's'} pending
            </span>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">
            {error}
          </div>
        )}
      </div>

      {result && (
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark">
              {result.dryRun ? 'Dry-run preview' : 'Applied'} · {result.programYear}
            </h2>
            <span className="text-xs text-cpcqc-purple-dark/60">
              {result.recordsFetched} REDCap rows · pulled {new Date(result.fetchedAt).toLocaleString()}
            </span>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label={result.dryRun ? 'Will change' : 'Changed'}
              value={result.counts.willChange}
              tone={result.counts.willChange > 0 ? 'positive' : 'neutral'}
            />
            <Stat label="Counting" value={result.counts.counting} tone="positive" />
            <Stat label="Incomplete" value={result.counts.incomplete} tone="warn" />
            <Stat label="Late" value={result.counts.completeLate} tone="warn" />
            <Stat label="Not submitted" value={result.counts.notSubmitted} />
            <Stat label="Pending" value={result.counts.pending} />
          </div>

          {result.warnings.length > 0 && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <h3 className="flex items-center gap-1.5 font-rounded text-sm font-extrabold text-amber-800">
                <AlertTriangle size={14} aria-hidden /> {result.warnings.length} item
                {result.warnings.length === 1 ? '' : 's'} need attention
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-amber-900/90">
                {result.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 space-y-6">
            {result.periodsInScope.map((p) => {
              const rows = byPeriod[p] ?? [];
              if (rows.length === 0) return null;
              const finalized = rows[0]?.finalized ?? false;
              return (
                <div key={p}>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-rounded text-sm font-extrabold uppercase tracking-wide text-cpcqc-purple-dark">
                      {p}
                    </h3>
                    <FinalizeButton program="SOAR" period={p} finalized={finalized} onDone={() => run(true)} />
                  </div>
                  <div className="mt-2 overflow-x-auto rounded-xl border border-cpcqc-purple-dark/10">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-cpcqc-cream/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                        <tr>
                          <th className="px-3 py-2">Hospital</th>
                          <th className="px-3 py-2">System</th>
                          <th className="px-3 py-2">Status (override)</th>
                          <th className="px-3 py-2">Comments</th>
                          <th className="px-3 py-2">NTSV cases</th>
                          <th className="px-3 py-2">Submitted</th>
                          <th className="px-3 py-2">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => {
                          const meta = SOAR_CATEGORY_META[r.category];
                          const isOverridden =
                            (overrides[r.taskId]?.disposition ?? defaultDisposition(r)) !==
                            categoryToDisposition(r.category);
                          return (
                            <tr
                              key={`${r.dagCode}-${r.period}`}
                              className={`border-t border-cpcqc-purple-dark/10 ${
                                isOverridden ? 'bg-amber-50' : r.willChange ? 'bg-cpcqc-purple/5' : ''
                              }`}
                            >
                              <td className="px-3 py-2 font-semibold text-cpcqc-purple-dark">
                                {r.hospitalName}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${meta.className}`}>
                                  {meta.label}
                                </span>
                              </td>
                              {r.finalized ? (
                                <LockedCells row={r} />
                              ) : (
                                <OverrideCells
                                  row={r}
                                  overrides={overrides}
                                  setOverrides={setOverrides}
                                  editable={editable}
                                />
                              )}
                              <td className="px-3 py-2 text-cpcqc-purple-dark/80">
                                {r.ntsvSubmitted
                                  ? `${r.ntsvComplete}/${r.ntsvRows}`
                                  : r.noNtsvSubmitted
                                    ? '0 (attested)'
                                    : '—'}
                              </td>
                              <td className="px-3 py-2 text-cpcqc-purple-dark/80">
                                {r.submissionDate ?? (r.ntsvSubmitted || r.noNtsvSubmitted ? '(no date)' : '—')}
                              </td>
                              <td className="px-3 py-2 text-xs text-cpcqc-purple-dark/70">{r.note}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
