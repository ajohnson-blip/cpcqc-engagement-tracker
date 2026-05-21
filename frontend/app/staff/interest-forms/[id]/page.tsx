'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { CheckCircle2, XCircle, ChevronLeft } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { PendingInterestForm } from '@/lib/types';
import { fmtDate } from '@/lib/format';

export default function InterestFormDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [form, setForm] = useState<PendingInterestForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'approve' | 'decline' | null>(null);
  const [programYear, setProgramYear] = useState<number>(new Date().getUTCFullYear());
  const [staffNotes, setStaffNotes] = useState('');
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ interestForm: PendingInterestForm }>(`/interest-forms/${params.id}`)
      .then((d) => {
        if (!cancelled) {
          setForm(d.interestForm);
          setStaffNotes(d.interestForm.staffNotes ?? '');
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  async function onApprove() {
    if (!form) return;
    setError(null);
    setSubmitting('approve');
    try {
      const res = await api.post<{
        hospitalId: string;
        enrollmentId: string;
        userId: string;
        devPasswordSetupToken?: string;
      }>(`/interest-forms/${form.id}/approve`, { programYear, staffNotes: staffNotes || undefined });
      setForm({ ...form, status: 'approved' });
      setSuccess(
        res.devPasswordSetupToken
          ? `Approved. Hospital created. Password-setup token (dev only): ${res.devPasswordSetupToken}`
          : 'Approved. Hospital created and welcome email sent.',
      );
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Something went wrong.');
    } finally {
      setSubmitting(null);
    }
  }

  async function onDecline() {
    if (!form) return;
    setError(null);
    setSubmitting('decline');
    try {
      await api.post(`/interest-forms/${form.id}/decline`, { staffNotes: staffNotes || undefined });
      setForm({ ...form, status: 'declined' });
      setSuccess('Declined. The submitter has been notified by email.');
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError('Something went wrong.');
    } finally {
      setSubmitting(null);
    }
  }

  if (error && !form) {
    return (
      <div className="rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
        {error}
      </div>
    );
  }
  if (!form) {
    return (
      <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
        Loading…
      </div>
    );
  }

  const reviewable = form.status === 'submitted' || form.status === 'reviewed';

  return (
    <div className="space-y-6">
      <Link
        href="/staff/interest-forms"
        className="inline-flex items-center gap-1 text-sm font-semibold text-cpcqc-purple-dark/70 hover:text-cpcqc-purple"
      >
        <ChevronLeft size={16} aria-hidden /> Back to Interest Forms
      </Link>

      <header className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
                {form.facilityName}
              </h1>
              <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
                Submitted {fmtDate(form.createdAt, 'MMM d, yyyy · h:mm a')}
              </p>
            </div>
            <span className="rounded-full bg-cpcqc-purple/10 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
              Status: {form.status === 'submitted' ? 'New' : form.status}
            </span>
          </div>

          <dl className="mt-5 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Field label="Submitter">
              {form.firstName} {form.lastName}
            </Field>
            <Field label="Role">{form.role}</Field>
            <Field label="Email">
              <a href={`mailto:${form.email}`} className="text-cpcqc-purple hover:underline">
                {form.email}
              </a>
            </Field>
          </dl>
        </div>
      </header>

      {success && (
        <div className="rounded-xl bg-cpcqc-teal-dark/10 p-4 text-sm text-cpcqc-teal-dark">
          {success}
        </div>
      )}
      {error && (
        <div className="rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {reviewable && (
        <section className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <h2 className="mb-4 font-rounded text-lg font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
            Review
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
                Program year (for approval)
              </span>
              <input
                type="number"
                min={2025}
                max={2100}
                value={programYear}
                onChange={(e) => setProgramYear(parseInt(e.target.value, 10) || programYear)}
                className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2"
              />
            </label>
          </div>
          <label className="mt-4 block">
            <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
              Staff notes (optional, included in decline email)
            </span>
            <textarea
              rows={3}
              value={staffNotes}
              onChange={(e) => setStaffNotes(e.target.value)}
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 bg-white px-3 py-2"
            />
          </label>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onDecline}
              disabled={!!submitting}
              className="inline-flex items-center gap-2 rounded-full border border-cpcqc-pink-dark/30 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-pink-dark hover:bg-cpcqc-pink-dark hover:text-white disabled:opacity-60"
            >
              <XCircle size={16} aria-hidden />
              {submitting === 'decline' ? 'Declining…' : 'Decline'}
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={!!submitting}
              className="inline-flex items-center gap-2 rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-60"
            >
              <CheckCircle2 size={16} aria-hidden />
              {submitting === 'approve' ? 'Approving…' : `Approve for ${programYear}`}
            </button>
          </div>
        </section>
      )}

      {!reviewable && form.staffNotes && (
        <div className="rounded-2xl bg-white p-6 shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <h2 className="mb-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
            Staff notes
          </h2>
          <p className="whitespace-pre-line text-sm text-cpcqc-purple-dark/80">{form.staffNotes}</p>
        </div>
      )}

      {form.status === 'approved' && form.hospitalId && (
        <button
          type="button"
          onClick={() => router.push(`/staff/hospitals/${form.hospitalId}`)}
          className="rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white"
        >
          Open hospital →
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">{label}</dt>
      <dd className="text-cpcqc-purple-dark">{children}</dd>
    </div>
  );
}
