'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { MyEnrollment } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { EnrollmentCard } from '@/components/enrollment-card';

export default function PortalHomePage() {
  const { hospitalName } = useAuth();
  const [enrollments, setEnrollments] = useState<MyEnrollment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ enrollments: MyEnrollment[] }>('/me/enrollments')
      .then((data) => {
        if (!cancelled) setEnrollments(data.enrollments);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <header className="mb-8">
        <p className="font-script text-2xl text-cpcqc-purple-dark/80">Welcome back,</p>
        <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark sm:text-4xl">
          {hospitalName ?? 'Your Hospital'}
        </h1>
        <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
          Track your progress against the perinatal QI mandate across every initiative you're
          enrolled in.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          Couldn't load your enrollments: {error}
        </div>
      )}

      {enrollments === null && !error && (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading enrollments…
        </div>
      )}

      {enrollments && enrollments.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center shadow-card">
          <p className="font-rounded text-lg font-bold text-cpcqc-purple-dark">
            You're not enrolled in any initiatives yet.
          </p>
          <p className="mt-2 text-cpcqc-purple-dark/70">
            Once a CPCQC program manager approves your Interest Form, your initiative will appear
            here.
          </p>
        </div>
      )}

      <div className="space-y-6">
        {enrollments?.map((e) => (
          <EnrollmentCard key={e.enrollmentId} enrollment={e} />
        ))}
      </div>
    </div>
  );
}
