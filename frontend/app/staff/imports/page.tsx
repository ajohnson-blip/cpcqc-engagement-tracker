'use client';

import { useRef, useState } from 'react';
import { Upload, FileSpreadsheet, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getAccessToken } from '@/lib/api';

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
