'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { api } from '@/lib/api';
import type { PendingInterestForm } from '@/lib/types';
import { fmtDate } from '@/lib/format';

type StatusFilter = 'submitted' | 'reviewed' | 'approved' | 'declined' | 'all';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'submitted', label: 'New' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'approved', label: 'Approved' },
  { value: 'declined', label: 'Declined' },
  { value: 'all', label: 'All' },
];

const STATUS_STYLE: Record<PendingInterestForm['status'], string> = {
  submitted: 'bg-cpcqc-orange-dark/15 text-cpcqc-orange-dark',
  reviewed: 'bg-cpcqc-purple/15 text-cpcqc-purple',
  approved: 'bg-cpcqc-teal-dark/15 text-cpcqc-teal-dark',
  declined: 'bg-cpcqc-pink-dark/15 text-cpcqc-pink-dark',
};

export default function InterestFormsListPage() {
  const [filter, setFilter] = useState<StatusFilter>('submitted');
  const [data, setData] = useState<{ interestForms: PendingInterestForm[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    const qp = new URLSearchParams();
    if (filter !== 'all') qp.set('status', filter);
    api
      .get<{ interestForms: PendingInterestForm[]; total: number }>(
        `/interest-forms?${qp.toString()}`,
      )
      .then((d) => !cancelled && setData(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [filter]);

  return (
    <div>
      <header className="mb-6">
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
          Interest Forms
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Review submissions, then approve to start the Enrollment Form, or decline with a note.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={clsx(
              'rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition',
              filter === f.value
                ? 'bg-cpcqc-purple text-white'
                : 'bg-white text-cpcqc-purple-dark ring-1 ring-cpcqc-purple-dark/15 hover:bg-cpcqc-purple/10',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {!data ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : data.interestForms.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
          No interest forms match this filter.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <table className="w-full text-left">
            <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              <tr>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3">Facility</th>
                <th className="px-4 py-3">Submitter</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.interestForms.map((f) => (
                <tr key={f.id} className="border-t border-cpcqc-purple-dark/10">
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">{fmtDate(f.createdAt)}</td>
                  <td className="px-4 py-3 font-semibold text-cpcqc-purple-dark">{f.facilityName}</td>
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                    <div>{f.firstName} {f.lastName}</div>
                    <div className="text-xs">{f.role} · {f.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={clsx(
                        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide',
                        STATUS_STYLE[f.status],
                      )}
                    >
                      {f.status === 'submitted' ? 'New' : f.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/staff/interest-forms/${f.id}`}
                      className="font-semibold text-cpcqc-purple hover:underline"
                    >
                      {f.status === 'submitted' ? 'Review →' : 'Open →'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
