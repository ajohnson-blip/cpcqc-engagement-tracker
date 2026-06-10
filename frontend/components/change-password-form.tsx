'use client';

/**
 * Self-service change-password form, shared by /portal/account and
 * /staff/account. Both layouts wrap this in the right header / shell.
 *
 * Backend revokes every refresh token for the user on success — including
 * the current one — so after a successful change we sign the user out
 * client-side and bounce them to /login. This matches the existing
 * password-reset flow (confirmPasswordReset() in auth.service.ts) and
 * means a credential leak doesn't leave any sessions alive.
 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const MIN_PASSWORD_LENGTH = 12;

export function ChangePasswordForm({ returnHref }: { returnHref: string }) {
  const router = useRouter();
  const { signOut } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Inline validation feedback drives the disabled state on Submit so the
  // user gets a click that does something every time it's clickable.
  const validationErrors: string[] = [];
  if (newPassword && newPassword.length < MIN_PASSWORD_LENGTH) {
    validationErrors.push(
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (newPassword && confirmPassword && newPassword !== confirmPassword) {
    validationErrors.push("New passwords don't match.");
  }
  if (newPassword && currentPassword && newPassword === currentPassword) {
    validationErrors.push('New password must be different from the current one.');
  }

  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    confirmPassword === newPassword &&
    newPassword !== currentPassword &&
    !submitting;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword,
        newPassword,
      });
      setSuccess(true);
      // The backend just revoked every refresh token (including the one
      // powering this session). Sign the user out client-side so the auth
      // context flips, then bounce to /login with a short delay so they
      // can read the confirmation.
      setTimeout(() => {
        void signOut().finally(() => router.replace('/login'));
      }, 1500);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not change your password. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-2xl bg-white p-6 text-center shadow-card">
        <CheckCircle2 className="mx-auto mb-3 text-cpcqc-teal-dark" size={36} aria-hidden />
        <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
          Password updated.
        </h2>
        <p className="mt-2 text-cpcqc-purple-dark/80">
          For security, we've signed you out of every device. Redirecting you to sign
          in with your new password…
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-2xl bg-white p-6 shadow-card">
      <div className="flex items-start gap-3 rounded-lg bg-cpcqc-cream-dark/30 px-4 py-3 text-sm text-cpcqc-purple-dark/80">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-cpcqc-purple" aria-hidden />
        <span>
          Changing your password signs you out of every device for security. You'll
          be redirected to sign in with your new password after submitting.
        </span>
      </div>

      <Field label="Current password" required>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="form-input"
        />
      </Field>

      <Field
        label="New password"
        required
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
      >
        <input
          type="password"
          required
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="form-input"
        />
      </Field>

      <Field label="Confirm new password" required>
        <input
          type="password"
          required
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="form-input"
        />
      </Field>

      {validationErrors.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <ul className="list-disc pl-4">
            {validationErrors.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push(returnHref)}
          disabled={submitting}
          className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
        >
          {submitting ? 'Updating…' : 'Update password'}
        </button>
      </div>

      <style jsx>{`
        :global(.form-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(106, 101, 135, 0.2);
          background-color: white;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: rgb(46, 39, 87);
        }
        :global(.form-input:focus) {
          outline: none;
          border-color: rgb(106, 101, 135);
          box-shadow: 0 0 0 3px rgba(106, 101, 135, 0.15);
        }
      `}</style>
    </form>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        {label}
        {required && <span className="ml-0.5 text-cpcqc-pink-dark">*</span>}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs text-cpcqc-purple-dark/60">{hint}</span>
      )}
    </label>
  );
}
