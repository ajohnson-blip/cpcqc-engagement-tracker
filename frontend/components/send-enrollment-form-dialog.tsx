'use client';

/**
 * Send a hospital its enrollment form(s) from the staff enrollment-forms
 * screen. One email, one link per initiative, each opening the public form with
 * the hospital and initiative already chosen.
 *
 * Built for hospitals with no interest form to accept — they get no acceptance
 * email, so nothing else would carry the links — but it works for any hospital,
 * which also makes it how a PM re-sends a link that went astray. Sending puts
 * the hospital on each initiative's chase list.
 *
 * The address is the PM's call. The hospital's default contact, its interest
 * form's submitter, its roster and earlier recipients are offered, never
 * filled in silently: a prefilled address is too easy to send to unread.
 */

import { useEffect, useMemo, useState } from 'react';
import { X, CheckCircle2, AlertTriangle, Mail } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type {
  EnrollableInitiativeCode,
  EnrollmentRecipientSuggestion,
  SendEnrollmentFormsResult,
} from '@/lib/types';

const CODES: EnrollableInitiativeCode[] = ['SPARK', 'SOAR', 'NEST', 'TTT'];

interface Props {
  programYear: number;
  /** Preselected from a chase-list row. */
  initialHospitalId?: string;
  initialInitiative?: EnrollableInitiativeCode;
  /** Prefilled for a resend: who it went to before. */
  initialToEmail?: string;
  initialToName?: string | null;
  /** Initiatives each hospital has already filed — those can't be sent again. */
  filed: Map<string, Set<string>>;
  onCancel: () => void;
  onSent: (result: SendEnrollmentFormsResult, hospitalName: string) => void;
}

export function SendEnrollmentFormDialog({
  programYear,
  initialHospitalId,
  initialInitiative,
  initialToEmail,
  initialToName,
  filed,
  onCancel,
  onSent,
}: Props) {
  const [hospitals, setHospitals] = useState<Array<{ id: string; name: string }>>([]);
  const [hospitalId, setHospitalId] = useState(initialHospitalId ?? '');
  const [codes, setCodes] = useState<EnrollableInitiativeCode[]>(
    initialInitiative ? [initialInitiative] : [],
  );
  const [toEmail, setToEmail] = useState(initialToEmail ?? '');
  const [toName, setToName] = useState(initialToName ?? '');
  const [suggestions, setSuggestions] = useState<EnrollmentRecipientSuggestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ hospitals: Array<{ id: string; name: string }> }>('/public/enrollment-forms/hospitals')
      .then((h) => setHospitals([...h.hospitals].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    setSuggestions([]);
    if (!hospitalId) return;
    let cancelled = false;
    api
      .get<{ suggestions: EnrollmentRecipientSuggestion[] }>(
        `/staff/enrollment-forms/recipients?programYear=${programYear}&hospitalId=${encodeURIComponent(hospitalId)}`,
      )
      .then((r) => !cancelled && setSuggestions(r.suggestions))
      .catch(() => {
        // Suggestions are a convenience; the PM can still type an address.
      });
    return () => {
      cancelled = true;
    };
  }, [hospitalId, programYear]);

  const filedHere = useMemo(() => filed.get(hospitalId) ?? new Set<string>(), [filed, hospitalId]);
  const chosen = codes.filter((c) => !filedHere.has(c));
  const hospitalName = hospitals.find((h) => h.id === hospitalId)?.name ?? '';
  const emailLooksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail.trim());

  function toggle(code: EnrollableInitiativeCode) {
    setCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  async function send() {
    setSaving(true);
    setError(null);
    try {
      const result = await api.post<SendEnrollmentFormsResult>('/staff/enrollment-forms/send', {
        programYear,
        hospitalId,
        initiatives: chosen,
        toEmail: toEmail.trim(),
        ...(toName.trim() ? { toName: toName.trim() } : {}),
      });
      onSent(result, hospitalName);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send.');
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onCancel();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
            {initialToEmail ? 'Resend enrollment form' : 'Send enrollment form'}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark disabled:opacity-50"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-5 px-6 pb-5 pt-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              Hospital
            </span>
            <select
              value={hospitalId}
              onChange={(e) => setHospitalId(e.target.value)}
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm text-cpcqc-purple-dark"
            >
              <option value="">Choose a hospital…</option>
              {hospitals.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>

          <div>
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              Initiatives
            </span>
            <div className="flex flex-wrap gap-2">
              {CODES.map((code) => {
                const done = filedHere.has(code);
                const on = codes.includes(code) && !done;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => toggle(code)}
                    disabled={done}
                    title={done ? `${hospitalName} has already filed its ${code} form` : undefined}
                    className={
                      'rounded-full border px-4 py-1.5 text-sm font-bold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-40 ' +
                      (on
                        ? 'border-cpcqc-purple bg-cpcqc-purple text-white'
                        : 'border-cpcqc-purple-dark/20 text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5')
                    }
                  >
                    {on && <CheckCircle2 size={13} className="mr-1 inline" aria-hidden />}
                    {code}
                    {done && ' · filed'}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
              Each initiative is its own form, so the email has one link per initiative.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                Send to
              </span>
              <input
                type="email"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
                placeholder="name@hospital.org"
                className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm text-cpcqc-purple-dark"
              />
            </label>
            <input
              type="text"
              value={toName}
              onChange={(e) => setToName(e.target.value)}
              placeholder="Their name (optional, for the greeting)"
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm text-cpcqc-purple-dark"
            />
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s.email}
                    type="button"
                    onClick={() => {
                      setToEmail(s.email);
                      setToName(s.name ?? '');
                    }}
                    className="rounded-full bg-cpcqc-cream-dark/40 px-2.5 py-1 text-left text-xs text-cpcqc-purple-dark hover:bg-cpcqc-cream-dark/70"
                  >
                    {s.name ? `${s.name} · ` : ''}
                    {s.email}
                    <span className="text-cpcqc-purple-dark/50"> ({s.source})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {hospitalId && chosen.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-orange-dark">
              <Mail size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                Emails {emailLooksValid ? toEmail.trim() : 'this address'} a link to {hospitalName}
                &rsquo;s {chosen.join(', ')} enrollment form{chosen.length === 1 ? '' : 's'}, and adds{' '}
                {hospitalName} to {chosen.length === 1 ? 'that' : 'each'} chase list.
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={saving || !hospitalId || chosen.length === 0 || !emailLooksValid}
              className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              {saving ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
