'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { Logo } from '@/components/logo';
import { api, ApiError } from '@/lib/api';

const INITIATIVES = [
  { code: 'TTT', name: "Turning the Tide: Perinatal Substance Use", emoji: '🌊' },
  { code: 'SPARK', name: 'SPARK: Postpartum Discharge Transitions', emoji: '✨' },
  { code: 'SOAR', name: 'SOAR: Primary Cesarean Reduction', emoji: '🪁' },
  { code: 'NEST', name: 'NEST: Infant Safe Sleep', emoji: '🐣' },
] as const;

type InitiativeCode = (typeof INITIATIVES)[number]['code'];

export default function InterestFormPage() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center font-rounded text-cpcqc-purple">
          Loading…
        </div>
      }
    >
      <InterestFormInner />
    </Suspense>
  );
}

function InterestFormInner() {
  const searchParams = useSearchParams();
  const presetCode = searchParams.get('initiative')?.toUpperCase() as InitiativeCode | null;
  const validPreset = INITIATIVES.find((i) => i.code === presetCode)?.code ?? null;

  const [initiativeCode, setInitiativeCode] = useState<InitiativeCode | ''>(validPreset ?? '');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [facilityName, setFacilityName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (validPreset && !initiativeCode) setInitiativeCode(validPreset);
  }, [validPreset, initiativeCode]);

  const selectedInitiative = INITIATIVES.find((i) => i.code === initiativeCode) ?? null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!initiativeCode) {
      setError('Please choose an initiative.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/interest-forms', {
        initiativeCode,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        role: role.trim(),
        facilityName: facilityName.trim(),
      });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again or email engagement@qi.cpcqc.org.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="grid min-h-screen place-items-center px-4 py-12">
        <div className="w-full max-w-xl">
          <div className="mb-8 flex flex-col items-center">
            <Logo size="lg" />
          </div>
          <div className="cpcqc-content-strip">
            <div className="rounded-b-2xl bg-white p-8 text-center shadow-card">
              <CheckCircle2 className="mx-auto mb-4 text-cpcqc-teal-dark" size={48} aria-hidden />
              <h1 className="font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
                Thanks — we got your interest form.
              </h1>
              <p className="mt-3 text-cpcqc-purple-dark/80">
                A CPCQC program manager will review your submission and follow up by email.
                You'll receive instructions for setting up your account and completing the
                Enrollment Form once you've been approved.
              </p>
              <p className="mt-3 text-sm text-cpcqc-purple-dark/70">
                Questions in the meantime?{' '}
                <a
                  className="text-cpcqc-purple underline underline-offset-2"
                  href="mailto:engagement@qi.cpcqc.org"
                >
                  engagement@qi.cpcqc.org
                </a>
              </p>
              <Link
                href="/interest"
                className="mt-6 inline-block rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
              >
                Submit another
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="mb-8 flex flex-col items-center">
          <Logo size="lg" />
          <p className="mt-3 font-rounded text-sm uppercase tracking-[0.15em] text-cpcqc-purple-dark">
            Engagement Tracker
          </p>
        </div>

        <div className="cpcqc-content-strip">
          <div className="rounded-b-2xl bg-white p-8 shadow-card">
            <h1 className="mb-2 font-rounded text-2xl font-extrabold text-cpcqc-purple-dark">
              {selectedInitiative
                ? `Thank you for your interest in CPCQC – ${selectedInitiative.name}.`
                : 'Tell us about your hospital.'}
            </h1>
            <p className="mb-6 text-cpcqc-purple-dark/80">
              Once you submit this form, a CPCQC program manager will review and confirm your
              eligibility. If approved, we'll email you a link to set up your account and complete
              the full Enrollment Form.
            </p>

            <form onSubmit={onSubmit} className="space-y-4">
              <Field label="Which initiative?">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {INITIATIVES.map((init) => {
                    const active = initiativeCode === init.code;
                    return (
                      <button
                        key={init.code}
                        type="button"
                        onClick={() => setInitiativeCode(init.code)}
                        className={
                          'rounded-xl border-2 p-3 text-left transition ' +
                          (active
                            ? 'border-cpcqc-purple bg-cpcqc-purple/5'
                            : 'border-cpcqc-purple-dark/15 bg-white hover:border-cpcqc-purple/40')
                        }
                      >
                        <div className="flex items-center gap-2">
                          <span aria-hidden className="text-lg">{init.emoji}</span>
                          <span className="font-rounded font-bold text-cpcqc-purple-dark">{init.code}</span>
                        </div>
                        <div className="mt-1 text-xs text-cpcqc-purple-dark/70">{init.name}</div>
                      </button>
                    );
                  })}
                </div>
              </Field>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="First name" required>
                  <input
                    type="text"
                    required
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="form-input"
                  />
                </Field>
                <Field label="Last name" required>
                  <input
                    type="text"
                    required
                    autoComplete="family-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="form-input"
                  />
                </Field>
              </div>

              <Field label="Email" required>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="form-input"
                />
              </Field>

              <Field label="Your role" required>
                <input
                  type="text"
                  required
                  placeholder="e.g. OB Director, QI Lead, Nurse Manager"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="form-input"
                />
              </Field>

              <Field label="Hospital / facility name" required>
                <input
                  type="text"
                  required
                  value={facilityName}
                  onChange={(e) => setFacilityName(e.target.value)}
                  className="form-input"
                />
              </Field>

              {error && (
                <p
                  className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark"
                  role="alert"
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-cpcqc-purple px-4 py-2.5 font-rounded font-bold text-white shadow-sm transition hover:bg-cpcqc-purple/90 disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Submit Interest Form'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-cpcqc-purple-dark/70">
              Already have an account?{' '}
              <Link className="text-cpcqc-purple underline underline-offset-2" href="/login">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>

      <style jsx>{`
        :global(.form-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(106, 101, 135, 0.2);
          background-color: white;
          padding: 0.55rem 0.75rem;
          font-size: 1rem;
        }
        :global(.form-input:focus) {
          outline: none;
          border-color: #6b529b;
          box-shadow: 0 0 0 3px rgba(107, 82, 155, 0.15);
        }
      `}</style>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">
        {label}
        {required && <span className="ml-1 text-cpcqc-pink-dark">*</span>}
      </span>
      {children}
    </label>
  );
}
