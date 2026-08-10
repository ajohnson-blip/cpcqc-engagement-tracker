'use client';

/**
 * CE certificates — CPCQC staff view.
 *
 * Flow: create a training → upload the participant roster (previewed before it's
 * saved) → preview the certificate PDF → optional test send to yourself →
 * send to everyone. Failures are per-recipient and retryable; sent certificates
 * can be re-sent later when a participant loses theirs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Award,
  Upload,
  Send,
  Download,
  Eye,
  AlertTriangle,
  RefreshCw,
  Trash2,
  UserPlus,
  Image as ImageIcon,
  BarChart3,
} from 'lucide-react';
import { api, apiFetch } from '@/lib/api';
import type {
  CeProgramsResponse,
  CeTrainingSummary,
  CeTrainingDetail,
  CeRosterPreview,
  CeRosterImportResult,
  CeSendResult,
  CeReport,
} from '@/lib/types';

/**
 * Fetch a PDF through the authenticated client and hand it to the browser.
 * A plain <a href> can't carry the Bearer token, so these endpoints must be
 * fetched and turned into a blob URL. `filename` triggers a download; omitting
 * it opens the PDF in a new tab.
 */
async function openPdf(path: string, filename?: string): Promise<void> {
  const res = await apiFetch(path);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}) as { message?: string });
    throw new Error(detail.message ?? `Could not load the PDF (HTTP ${res.status}).`);
  }
  const url = URL.createObjectURL(await res.blob());
  if (filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  // Give the browser time to consume the URL before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const emptyForm = {
  programCode: '',
  title: '',
  trainingDate: '',
  contactHours: '',
  activityId: '',
};

export default function CeCertificatesPage() {
  const [programs, setPrograms] = useState<CeProgramsResponse | null>(null);
  const [trainings, setTrainings] = useState<CeTrainingSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CeTrainingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTrainings = useCallback(async () => {
    const res = await api.get<{ trainings: CeTrainingSummary[] }>('/staff/ce/trainings');
    setTrainings(res.trainings);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(await api.get<CeTrainingDetail>(`/staff/ce/trainings/${id}`));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [p] = await Promise.all([
          api.get<CeProgramsResponse>('/staff/ce/programs'),
          loadTrainings(),
        ]);
        setPrograms(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load CE data.');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadTrainings]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId).catch(() => setDetail(null));
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const handleDelete = useCallback(
    async (t: CeTrainingSummary) => {
      const roster =
        t.participants > 0
          ? ` Its roster of ${t.participants} participant${t.participants === 1 ? '' : 's'} will be removed too.`
          : '';
      if (!window.confirm(`Delete "${t.title}"?${roster} This can't be undone.`)) return;
      setError(null);
      try {
        await api.del(`/staff/ce/trainings/${t.id}`);
        // Close the detail pane if the training it was showing just went away.
        setSelectedId((cur) => (cur === t.id ? null : cur));
        await loadTrainings();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not delete that training.');
      }
    },
    [loadTrainings],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-rounded text-2xl font-bold text-cpcqc-purple-dark">
            <Award className="h-6 w-6" /> CE Certificates
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Create a training, upload the participant roster, and email each person their
            certificate of completion.
          </p>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-lg bg-cpcqc-pink-dark/10 px-4 py-3 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      <ReportsPanel />

      {programs && (
        <LogoManager
          programs={programs}
          onChanged={async () => setPrograms(await api.get<CeProgramsResponse>('/staff/ce/programs'))}
        />
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
          <div className="space-y-6">
            <NewTrainingForm
              programs={programs}
              onCreated={async (id) => {
                await loadTrainings();
                setSelectedId(id);
              }}
            />
            <TrainingList
              trainings={trainings}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDelete={handleDelete}
            />
          </div>

          <div>
            {detail ? (
              <TrainingDetail
                detail={detail}
                onChanged={async () => {
                  await Promise.all([loadTrainings(), loadDetail(detail.id)]);
                }}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
                Select a training to manage its roster and send certificates.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * CE reporting — what CPCQC owes its accreditor.
 *
 * Contact hours awarded counts certificates actually SENT, not roster size:
 * someone who never received a certificate has earned nothing. Roster total is
 * shown alongside so a gap between the two is visible rather than hidden.
 */
function ReportsPanel() {
  const thisYear = new Date().getFullYear();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(`${thisYear}-01-01`);
  const [to, setTo] = useState(`${thisYear}-12-31`);
  const [report, setReport] = useState<CeReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setReport(
        await api.get<CeReport>(
          `/staff/ce/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        ),
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load the report.');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function download(path: string, filename: string) {
    setErr(null);
    try {
      const res = await apiFetch(
        `${path}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      if (!res.ok) throw new Error(`Export failed (HTTP ${res.status}).`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Download failed.');
    }
  }

  const t = report?.totals;

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
          <BarChart3 className="h-4 w-4" /> CE reporting
        </span>
        <span className="text-xs text-slate-400">{open ? 'Hide' : 'Open'}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-4">
          <div className="mb-4 flex flex-wrap items-end gap-2">
            <label>
              <span className="mb-1 block text-[11px] text-slate-500">From</span>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-slate-500">To</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </label>
            <button
              onClick={load}
              disabled={loading}
              className="rounded-full border border-cpcqc-purple px-4 py-1.5 text-xs font-bold text-cpcqc-purple transition hover:bg-cpcqc-purple/10 disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() =>
                  download('/staff/ce/reports/export.xlsx', `CPCQC-CE-Report_${from}_${to}.xlsx`)
                }
                className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold text-white transition hover:bg-cpcqc-purple-dark"
              >
                <Download className="h-3.5 w-3.5" /> Excel report
              </button>
              <button
                onClick={() =>
                  download(
                    '/staff/ce/reports/participants.csv',
                    `CPCQC-CE-Participants_${from}_${to}.csv`,
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 px-4 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" /> Participants CSV
              </button>
            </div>
          </div>

          {err && <p className="mb-3 text-xs text-cpcqc-pink-dark">{err}</p>}

          {t && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Contact hours awarded" value={t.contactHoursAwarded} emphasis />
                <Stat label="Certificates issued" value={t.certificatesIssued} emphasis />
                <Stat label="Unique participants" value={t.uniqueParticipants} />
                <Stat label="Activities held" value={t.activities} />
              </div>

              {t.rosterTotal > t.certificatesIssued && (
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t.rosterTotal - t.certificatesIssued} roster entr
                  {t.rosterTotal - t.certificatesIssued === 1 ? 'y has' : 'ies have'} no certificate
                  sent yet, so those contact hours are not counted as awarded.
                </p>
              )}

              {report.byProgram.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="py-2 font-semibold">Program</th>
                        <th className="py-2 font-semibold">Activities</th>
                        <th className="py-2 font-semibold">Certificates</th>
                        <th className="py-2 font-semibold">Contact hours</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {report.byProgram.map((p) => (
                        <tr key={p.programCode}>
                          <td className="py-2 font-medium text-slate-800">{p.programLabel}</td>
                          <td className="py-2 text-slate-600">{p.activities}</td>
                          <td className="py-2 text-slate-600">{p.certificatesIssued}</td>
                          <td className="py-2 font-semibold text-cpcqc-purple-dark">
                            {p.contactHoursAwarded}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {report.activities.length === 0 && (
                <p className="mt-4 text-sm text-slate-500">No trainings in that date range.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className={`rounded-lg p-3 ${emphasis ? 'bg-cpcqc-purple/10' : 'bg-slate-50'}`}>
      <p
        className={`font-rounded text-2xl font-bold ${
          emphasis ? 'text-cpcqc-purple-dark' : 'text-slate-700'
        }`}
      >
        {value}
      </p>
      <p className="text-xs text-slate-600">{label}</p>
    </div>
  );
}

/**
 * Show the logo currently in use. The endpoint is staff-only, and an <img src>
 * can't carry the Bearer token, so the bytes are fetched through the
 * authenticated client and shown via a blob URL. `version` forces a refetch
 * after an upload or removal.
 */
function LogoPreview({ code, label, version }: { code: string; label: string; version: number }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await apiFetch(`/staff/ce/programs/${code}/logo`);
        if (!res.ok || cancelled) return;
        objectUrl = URL.createObjectURL(await res.blob());
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setUrl(objectUrl);
      } catch {
        /* preview is cosmetic — a failure just leaves the placeholder */
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [code, version]);

  if (!url) return <span className="text-xs text-slate-400">Loading…</span>;
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img src={url} alt={`${label} logo`} className="max-h-14 max-w-full object-contain" />;
}

/**
 * Upload and replace the logos that appear on certificates.
 *
 * Uploads are stored in the database, not on the server's filesystem — Render
 * wipes local files on every deploy, which would silently strip the branding
 * from certificates issued afterwards.
 */
function LogoManager({
  programs,
  onChanged,
}: {
  programs: CeProgramsResponse;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(programs.missingLogos.length > 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Bumped after each change to defeat the browser's image cache.
  const [version, setVersion] = useState(0);

  // Generic (CPCQC-hosted) programs have no host logo, so they get no tile.
  const entries = [
    ...programs.programs.filter((p) => !p.generic),
    { code: programs.cpcqcLogoCode, label: 'CPCQC (on every certificate)' },
  ];

  async function upload(code: string, file: File) {
    setBusy(code);
    setErr(null);
    try {
      const res = await apiFetch(
        `/staff/ce/programs/${code}/logo?filename=${encodeURIComponent(file.name)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(detail.message ?? 'Upload failed.');
      }
      await onChanged();
      setVersion((v) => v + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(code: string) {
    if (!window.confirm(`Remove the ${code} logo? Certificates will show the name as text.`)) return;
    setBusy(code);
    setErr(null);
    try {
      await api.del(`/staff/ce/programs/${code}/logo`);
      await onChanged();
      setVersion((v) => v + 1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove the logo.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
          <ImageIcon className="h-4 w-4" /> Certificate logos
        </span>
        <span className="flex items-center gap-2 text-xs">
          {programs.missingLogos.length > 0 ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900">
              {programs.missingLogos.length} missing
            </span>
          ) : (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700">
              All set
            </span>
          )}
          <span className="text-slate-400">{open ? 'Hide' : 'Manage'}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-4 py-4">
          <p className="mb-3 text-xs text-slate-600">
            PNG or JPEG, transparent background, at least 600px wide. A program with no logo prints
            its name as text instead — the certificate is still valid.
          </p>
          {err && <p className="mb-3 text-xs text-cpcqc-pink-dark">{err}</p>}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((p) => {
              const has = programs.logoAvailability?.[p.code] ?? false;
              return (
                <div key={p.code} className="rounded-lg border border-slate-200 p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-700">{p.label}</span>
                    {has ? (
                      <button
                        onClick={() => remove(p.code)}
                        disabled={busy === p.code}
                        title="Remove logo"
                        className="text-slate-300 transition hover:text-cpcqc-pink-dark"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span className="text-[10px] font-semibold uppercase text-amber-700">
                        Missing
                      </span>
                    )}
                  </div>

                  <div className="mb-2 grid h-16 place-items-center rounded bg-slate-50">
                    {has ? (
                      <LogoPreview code={p.code} label={p.label} version={version} />
                    ) : (
                      <span className="text-xs text-slate-400">No logo</span>
                    )}
                  </div>

                  <label className="block cursor-pointer text-center text-xs font-semibold text-cpcqc-purple hover:underline">
                    {busy === p.code ? 'Uploading…' : has ? 'Replace' : 'Upload'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) upload(p.code, f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function NewTrainingForm({
  programs,
  onCreated,
}: {
  programs: CeProgramsResponse | null;
  onCreated: (id: string) => void | Promise<void>;
}) {
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const created = await api.post<CeTrainingDetail>('/staff/ce/trainings', {
        ...form,
        contactHours: Number(form.contactHours),
      });
      setForm(emptyForm);
      await onCreated(created.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the training.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
        New training
      </h2>
      <div className="space-y-3">
        <Field label="Host initiative">
          <select
            required
            value={form.programCode}
            onChange={set('programCode')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Select…</option>
            {programs?.programs.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Training name">
          <input
            required
            value={form.title}
            onChange={set('title')}
            placeholder="Breaking Stigma: Compassionate Care…"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Date of training">
          <input
            required
            type="date"
            value={form.trainingDate}
            onChange={set('trainingDate')}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact hours">
            <input
              required
              type="number"
              step="0.25"
              min="0.25"
              value={form.contactHours}
              onChange={set('contactHours')}
              placeholder="1.5"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Activity ID">
            <input
              required
              value={form.activityId}
              onChange={set('activityId')}
              placeholder="2026-0417"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>
        </div>
      </div>
      {err && <p className="mt-3 text-xs text-cpcqc-pink-dark">{err}</p>}
      <button
        type="submit"
        disabled={saving}
        className="mt-4 w-full rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold text-white transition hover:bg-cpcqc-purple-dark disabled:opacity-50"
      >
        {saving ? 'Creating…' : 'Create training'}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function TrainingList({
  trainings,
  selectedId,
  onSelect,
  onDelete,
}: {
  trainings: CeTrainingSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (t: CeTrainingSummary) => void;
}) {
  if (trainings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
        No trainings yet.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <h2 className="border-b border-slate-100 px-4 py-3 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
        Trainings
      </h2>
      <ul className="divide-y divide-slate-100">
        {trainings.map((t) => {
          // Once anything is sent the training holds issued CE records, which
          // must be retained — the server refuses too, this just explains why.
          const locked = t.sent > 0;
          return (
            <li
              key={t.id}
              className={`flex items-stretch ${selectedId === t.id ? 'bg-cpcqc-purple/10' : ''}`}
            >
              <button
                onClick={() => onSelect(t.id)}
                className="flex-1 px-4 py-3 text-left transition hover:bg-cpcqc-purple/5"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-cpcqc-purple/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cpcqc-purple-dark">
                    {t.programLabel}
                  </span>
                  <span className="text-xs text-slate-500">{t.trainingDateDisplay}</span>
                </div>
                <p className="mt-1 text-sm font-semibold text-slate-800">{t.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t.participants} participant{t.participants === 1 ? '' : 's'} · {t.sent} sent
                  {t.failed > 0 && (
                    <span className="ml-1 font-semibold text-cpcqc-pink-dark">
                      · {t.failed} failed
                    </span>
                  )}
                </p>
              </button>
              <button
                onClick={() => onDelete(t)}
                disabled={locked}
                title={
                  locked
                    ? `Can't delete — ${t.sent} certificate${t.sent === 1 ? '' : 's'} already sent. Issued CE records must be kept.`
                    : `Delete "${t.title}"`
                }
                aria-label={locked ? `Cannot delete ${t.title}` : `Delete ${t.title}`}
                className="px-3 text-slate-300 transition hover:text-cpcqc-pink-dark disabled:cursor-not-allowed disabled:text-slate-200 disabled:hover:text-slate-200"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TrainingDetail({
  detail,
  onChanged,
}: {
  detail: CeTrainingDetail;
  onChanged: () => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<CeRosterPreview | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<CeSendResult | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualEmail, setManualEmail] = useState('');

  async function addOne() {
    setBusy('addOne');
    setErr(null);
    setMsg(null);
    try {
      const r = await api.post<{ added: number; alreadyPresent: number }>(
        `/staff/ce/trainings/${detail.id}/participants`,
        { name: manualName.trim(), email: manualEmail.trim() },
      );
      setMsg(
        r.added > 0
          ? `Added ${manualName.trim()} to the roster.`
          : 'That email is already on the roster.',
      );
      setManualName('');
      setManualEmail('');
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add that person.');
    } finally {
      setBusy(null);
    }
  }

  const unsent = detail.certificates.filter((c) => !c.sentAt).length;
  const failed = detail.certificates.filter((c) => !c.sentAt && c.sendError).length;

  async function uploadForPreview(file: File) {
    setBusy('preview');
    setErr(null);
    setMsg(null);
    try {
      const res = await apiFetch(`/staff/ce/trainings/${detail.id}/roster/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Preview failed.');
      setPreview(await res.json());
      setPendingFile(file);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read that file.');
      setPreview(null);
      setPendingFile(null);
    } finally {
      setBusy(null);
    }
  }

  async function confirmImport() {
    if (!pendingFile) return;
    setBusy('import');
    setErr(null);
    try {
      const res = await apiFetch(`/staff/ce/trainings/${detail.id}/roster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pendingFile,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? 'Import failed.');
      const result: CeRosterImportResult = await res.json();
      setMsg(
        `Added ${result.added} participant${result.added === 1 ? '' : 's'}` +
          (result.alreadyPresent > 0 ? `; ${result.alreadyPresent} already on the roster.` : '.'),
      );
      setPreview(null);
      setPendingFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setBusy(null);
    }
  }

  async function send(certificateIds?: string[]) {
    const count = certificateIds?.length ?? unsent;
    if (
      !window.confirm(
        certificateIds
          ? `Re-send ${count} certificate${count === 1 ? '' : 's'}? The recipient will get another email.`
          : `Email certificates to ${count} participant${count === 1 ? '' : 's'}? This sends real email.`,
      )
    ) {
      return;
    }
    setBusy('send');
    setErr(null);
    setMsg(null);
    try {
      const result = await api.post<CeSendResult>(`/staff/ce/trainings/${detail.id}/send`, {
        ...(certificateIds ? { certificateIds, onlyUnsent: false } : { onlyUnsent: true }),
      });
      setSendResult(result);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed.');
    } finally {
      setBusy(null);
    }
  }

  async function testSend() {
    setBusy('test');
    setErr(null);
    setMsg(null);
    try {
      const r = await api.post<{ sent: boolean; error: string | null }>(
        `/staff/ce/trainings/${detail.id}/test-send`,
        { toEmail: testEmail },
      );
      setMsg(
        r.sent
          ? `Test certificate sent to ${testEmail}. Check that it arrives — and check the junk folder.`
          : `Test send did not go out: ${r.error ?? 'email is not configured in this environment.'}`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Test send failed.');
    } finally {
      setBusy(null);
    }
  }

  async function removeParticipant(id: string) {
    if (!window.confirm('Remove this participant from the roster?')) return;
    try {
      await api.del(`/staff/ce/certificates/${id}`);
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove.');
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <span className="rounded-full bg-cpcqc-purple/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cpcqc-purple-dark">
              {detail.programLabel}
            </span>
            <h2 className="mt-2 font-rounded text-lg font-bold text-slate-800">{detail.title}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {detail.trainingDateDisplay} · {detail.contactHours} nursing contact hours · Activity
              ID {detail.activityId}
            </p>
          </div>
          <button
            onClick={() =>
              openPdf(`/staff/ce/trainings/${detail.id}/preview.pdf`).catch((e) =>
                setErr(e instanceof Error ? e.message : 'Could not open the preview.'),
              )
            }
            className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-purple px-3 py-1.5 text-xs font-bold text-cpcqc-purple transition hover:bg-cpcqc-purple/10"
          >
            <Eye className="h-3.5 w-3.5" /> Preview certificate
          </button>
        </div>

        {detail.logoMissing && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            No logo file for {detail.programCode}. Certificates will show the program name as text.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
          <Upload className="h-4 w-4" /> Participant roster
        </h3>
        <p className="mb-3 text-xs text-slate-600">
          Upload a .xlsx or .csv with a header row containing a name column (or First/Last) and an
          email column. Re-uploading adds new people without disturbing anyone already sent.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadForPreview(f);
          }}
          className="block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-cpcqc-purple/10 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-cpcqc-purple-dark"
        />

        {busy === 'preview' && <p className="mt-3 text-xs text-slate-500">Reading file…</p>}

        {/* Late arrivals and corrected addresses don't warrant editing and
            re-uploading the whole roster file. */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-semibold text-slate-700">Or add one person</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addOne();
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <label className="min-w-[8rem] flex-1">
              <span className="mb-1 block text-[11px] text-slate-500">Name</span>
              <input
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="Jane Doe"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </label>
            <label className="min-w-[10rem] flex-1">
              <span className="mb-1 block text-[11px] text-slate-500">Email</span>
              <input
                type="email"
                value={manualEmail}
                onChange={(e) => setManualEmail(e.target.value)}
                placeholder="jane@hospital.org"
                className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={!manualName.trim() || !manualEmail.trim() || busy === 'addOne'}
              className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold text-white transition hover:bg-cpcqc-purple-dark disabled:opacity-50"
            >
              <UserPlus className="h-3.5 w-3.5" />
              {busy === 'addOne' ? 'Adding…' : 'Add'}
            </button>
          </form>
        </div>

        {preview && (
          <div className="mt-4 rounded-lg border border-slate-200 p-3">
            <p className="text-sm font-semibold text-slate-800">
              {preview.rows.length} participant{preview.rows.length === 1 ? '' : 's'} found
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              Using {preview.detected.nameColumns.join(' + ') || '—'} for name and{' '}
              {preview.detected.emailColumn ?? '—'} for email.
            </p>

            {preview.problems.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-cpcqc-orange-dark">
                  {preview.problems.length} row{preview.problems.length === 1 ? '' : 's'} skipped
                </summary>
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs text-slate-600">
                  {preview.problems.map((p) => (
                    <li key={`${p.sourceRow}-${p.email}`}>
                      Row {p.sourceRow}: {p.name || '(no name)'} {p.email && `<${p.email}>`} —{' '}
                      {p.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="mt-3 flex gap-2">
              <button
                onClick={confirmImport}
                disabled={busy === 'import' || preview.rows.length === 0}
                className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-xs font-bold text-white transition hover:bg-cpcqc-purple-dark disabled:opacity-50"
              >
                {busy === 'import' ? 'Adding…' : `Add ${preview.rows.length} to roster`}
              </button>
              <button
                onClick={() => {
                  setPreview(null);
                  setPendingFile(null);
                  if (fileRef.current) fileRef.current.value = '';
                }}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-3 flex items-center gap-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
          <Send className="h-4 w-4" /> Send certificates
        </h3>

        <div className="mb-4 rounded-lg bg-slate-50 p-3">
          <p className="text-xs font-semibold text-slate-700">
            Send a test to yourself first — confirm it arrives and isn&apos;t filtered to junk.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              type="email"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              placeholder="you@cpcqc.org"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
            <button
              onClick={testSend}
              disabled={!testEmail || busy === 'test'}
              className="rounded-full border border-cpcqc-purple px-4 py-1.5 text-xs font-bold text-cpcqc-purple transition hover:bg-cpcqc-purple/10 disabled:opacity-50"
            >
              {busy === 'test' ? 'Sending…' : 'Test send'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => send()}
            disabled={busy === 'send' || unsent === 0}
            className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold text-white transition hover:bg-cpcqc-purple-dark disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            {busy === 'send'
              ? 'Sending…'
              : unsent === 0
                ? 'All certificates sent'
                : `Send to ${unsent} participant${unsent === 1 ? '' : 's'}`}
          </button>
          {failed > 0 && (
            <button
              onClick={() =>
                send(detail.certificates.filter((c) => !c.sentAt && c.sendError).map((c) => c.id))
              }
              disabled={busy === 'send'}
              className="inline-flex items-center gap-1.5 rounded-full border border-cpcqc-pink-dark px-4 py-2 text-sm font-bold text-cpcqc-pink-dark transition hover:bg-cpcqc-pink-dark/10 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" /> Retry {failed} failed
            </button>
          )}
        </div>

        {msg && <p className="mt-3 text-xs text-emerald-700">{msg}</p>}
        {err && <p className="mt-3 text-xs text-cpcqc-pink-dark">{err}</p>}
        {sendResult && (
          <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs">
            <p className="font-semibold text-slate-800">
              {sendResult.sent} of {sendResult.attempted} sent
              {sendResult.failed > 0 && ` · ${sendResult.failed} failed`}
            </p>
            {sendResult.failures.length > 0 && (
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-slate-600">
                {sendResult.failures.map((f) => (
                  <li key={f.recipientEmail}>
                    {f.recipientEmail}: {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <h3 className="border-b border-slate-100 px-5 py-3 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark">
          Participants ({detail.certificates.length})
        </h3>
        {detail.certificates.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">
            No participants yet — upload a roster above.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Email</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {detail.certificates.map((c) => (
                <tr key={c.id}>
                  <td className="px-5 py-2 font-medium text-slate-800">{c.recipientName}</td>
                  <td className="px-3 py-2 text-slate-600">{c.recipientEmail}</td>
                  <td className="px-3 py-2">
                    {c.sentAt ? (
                      <span className="text-emerald-700">
                        Sent {new Date(c.sentAt).toLocaleDateString()}
                        {c.sendCount > 1 && ` (×${c.sendCount})`}
                      </span>
                    ) : c.sendError ? (
                      <span className="text-cpcqc-pink-dark" title={c.sendError}>
                        Failed
                      </span>
                    ) : (
                      <span className="text-slate-400">Not sent</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() =>
                          openPdf(
                            `/staff/ce/certificates/${c.id}/pdf`,
                            `CE-Certificate_${c.recipientName.replace(/\s+/g, '-')}.pdf`,
                          ).catch((e) =>
                            setErr(e instanceof Error ? e.message : 'Could not download.'),
                          )
                        }
                        title="Download PDF"
                        className="text-slate-400 transition hover:text-cpcqc-purple"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      {c.sentAt ? (
                        <button
                          onClick={() => send([c.id])}
                          title="Re-send"
                          className="text-slate-400 transition hover:text-cpcqc-purple"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          onClick={() => removeParticipant(c.id)}
                          title="Remove from roster"
                          className="text-slate-400 transition hover:text-cpcqc-pink-dark"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
