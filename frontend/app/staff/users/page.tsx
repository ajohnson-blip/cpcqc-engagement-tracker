'use client';

/**
 * Staff page to manage multi-hospital (regional) access for hospital users.
 *
 * Search a hospital user, then grant/revoke additional hospitals beyond their
 * primary. The primary (users.hospital_id) is shown read-only; this tool
 * manages the user_hospitals grants. Changes take effect on the user's next
 * token refresh (≤15 min) or immediately on re-login.
 */

import { useEffect, useState } from 'react';
import {
  Search,
  Building2,
  X,
  Plus,
  Trash2,
  UserPlus,
  UserX,
  Copy,
  CheckCircle2,
  KeyRound,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type {
  StaffUserListItem,
  UserHospitalsResponse,
  CreateChampionResponse,
} from '@/lib/types';

export default function StaffUsersPage() {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<StaffUserListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manageUser, setManageUser] = useState<StaffUserListItem | null>(null);
  const [resetUser, setResetUser] = useState<StaffUserListItem | null>(null);
  const [removeUser, setRemoveUser] = useState<StaffUserListItem | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // Bumped after a create to re-run the list query.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      const qp = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      api
        .get<{ users: StaffUserListItem[] }>(`/staff/users${qp}`)
        .then((d) => !cancelled && setUsers(d.users))
        .catch((err: Error) => !cancelled && setError(err.message));
    }, 250); // debounce
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, reloadKey]);

  function bumpAdditionalCount(userId: string, delta: number) {
    setUsers((prev) =>
      prev
        ? prev.map((u) =>
            u.id === userId
              ? { ...u, additionalCount: Math.max(0, u.additionalCount + delta) }
              : u,
          )
        : prev,
    );
  }

  function dropUserFromList(userId: string) {
    setUsers((prev) => (prev ? prev.filter((u) => u.id !== userId) : prev));
  }

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">
            User access
          </h1>
          <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
            Create champion accounts, and grant regional staff access to additional hospitals
            in their system.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
        >
          <UserPlus size={15} aria-hidden /> New champion
        </button>
      </header>

      <div className="mb-4 flex items-center gap-2 rounded-full bg-white px-4 py-2 shadow-sm ring-1 ring-cpcqc-purple-dark/10">
        <Search size={16} className="text-cpcqc-purple-dark/50" aria-hidden />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or email…"
          className="w-full bg-transparent text-sm text-cpcqc-purple-dark focus:outline-none"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-xl bg-cpcqc-pink-dark/10 p-4 text-sm text-cpcqc-pink-dark">
          {error}
        </div>
      )}

      {!users ? (
        <div className="rounded-xl bg-white p-8 text-center text-cpcqc-purple-dark/60 shadow-sm">
          Loading…
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-2xl bg-white p-8 text-center text-cpcqc-purple-dark/70 shadow-sm">
          No hospital users match.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
          <table className="w-full text-left">
            <thead className="bg-cpcqc-cream-dark/40 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
              <tr>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Primary hospital</th>
                <th className="px-4 py-3">Extra access</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-cpcqc-purple-dark/10">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-cpcqc-purple-dark">
                      {[u.firstName, u.lastName].filter(Boolean).join(' ') || '—'}
                    </div>
                    <div className="text-xs text-cpcqc-purple-dark/70">{u.email}</div>
                  </td>
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                    {u.championRoles.length > 0 ? (
                      u.championRoles.join(', ')
                    ) : (
                      <span className="text-cpcqc-purple-dark/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-cpcqc-purple-dark/80">
                    {u.primaryHospital?.name ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {u.additionalCount > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-cpcqc-purple">
                        <Building2 size={11} aria-hidden /> +{u.additionalCount}
                      </span>
                    ) : (
                      <span className="text-cpcqc-purple-dark/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setResetUser(u)}
                        className="inline-flex items-center gap-1 font-semibold text-cpcqc-purple-dark/70 hover:text-cpcqc-purple hover:underline"
                        title="Reset password & email new credentials"
                      >
                        <KeyRound size={12} aria-hidden /> Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => setManageUser(u)}
                        className="font-semibold text-cpcqc-purple hover:underline"
                      >
                        Manage access →
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemoveUser(u)}
                        className="inline-flex items-center gap-1 font-semibold text-cpcqc-pink-dark/80 hover:text-cpcqc-pink-dark hover:underline"
                        title="Remove this champion's access"
                      >
                        <UserX size={12} aria-hidden /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <EmailDeliveryCard />

      {manageUser && (
        <ManageAccessModal
          user={manageUser}
          onClose={() => setManageUser(null)}
          onChanged={(delta) => bumpAdditionalCount(manageUser.id, delta)}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}

      {showCreate && (
        <CreateChampionModal
          onClose={() => setShowCreate(false)}
          onCreated={() => setReloadKey((k) => k + 1)}
        />
      )}

      {resetUser && (
        <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} />
      )}

      {removeUser && (
        <RemoveChampionModal
          user={removeUser}
          onClose={() => setRemoveUser(null)}
          onRemoved={() => {
            dropUserFromList(removeUser.id);
            setRemoveUser(null);
          }}
        />
      )}
    </div>
  );
}

interface ResetResult {
  emailed: boolean;
  tempPassword: string | null;
  email: string;
  url: string;
}

function ResetPasswordModal({
  user,
  onClose,
}: {
  user: StaffUserListItem;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [copied, setCopied] = useState(false);
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function doReset() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<ResetResult>(`/staff/users/${user.id}/reset-password`, {});
      setResult(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
            {result ? 'Password reset' : 'Reset password'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 pb-5 pt-4">
          {error && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {error}
            </div>
          )}

          {!result ? (
            <>
              <p className="text-sm text-cpcqc-purple-dark/80">
                Reset the password for <strong>{name}</strong> ({user.email})? They'll be
                emailed a new temporary password and any current session will be signed out.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void doReset()}
                  disabled={busy}
                  className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
                >
                  {busy ? 'Resetting…' : 'Reset & email'}
                </button>
              </div>
            </>
          ) : result.emailed ? (
            <>
              <div className="flex items-start gap-2 rounded-lg bg-cpcqc-teal-dark/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
                <CheckCircle2
                  size={16}
                  className="mt-0.5 shrink-0 text-cpcqc-teal-dark"
                  aria-hidden
                />
                <span>
                  New credentials emailed to <strong>{result.email}</strong>. They'll set their
                  own password on next sign-in.
                </span>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
                >
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-orange-dark">
                Password reset, but the email couldn't be sent. Share these manually:
              </div>
              <div className="rounded-lg border border-cpcqc-purple-dark/20 bg-cpcqc-cream-dark/20 p-3 text-sm text-cpcqc-purple-dark">
                <div>
                  <span className="text-cpcqc-purple-dark/60">Sign in at:</span> {result.url}
                </div>
                <div className="mt-1">
                  <span className="text-cpcqc-purple-dark/60">Email:</span> {result.email}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-cpcqc-purple-dark/60">Password:</span>
                  <code className="break-all font-mono">{result.tempPassword}</code>
                  <button
                    type="button"
                    onClick={() => {
                      if (!result.tempPassword) return;
                      void navigator.clipboard?.writeText(result.tempPassword).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      });
                    }}
                    className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
                  >
                    <Copy size={12} aria-hidden /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface EmailTestResult {
  configured: boolean;
  sent: boolean;
  fromAddress: string;
  error: string | null;
}

function EmailDeliveryCard() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<EmailTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function sendTest() {
    if (!email.trim()) return;
    setErr(null);
    setResult(null);
    setSending(true);
    try {
      const res = await api.post<EmailTestResult>('/staff/email-test', {
        toEmail: email.trim(),
      });
      setResult(res);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not run the test.');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl bg-white p-5 shadow-card ring-1 ring-cpcqc-purple-dark/5">
      <h2 className="font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark/80">
        Email delivery check
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-cpcqc-purple-dark/70">
        Send a test email to confirm outbound delivery is working. Champion welcome emails,
        interest-form confirmations, and acceptance notices all depend on this.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@cpcqc.org"
          className="min-w-[16rem] flex-1 rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm text-cpcqc-purple-dark focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30"
        />
        <button
          type="button"
          onClick={() => void sendTest()}
          disabled={sending || !email.trim()}
          className="rounded-full bg-cpcqc-purple px-4 py-2 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send test'}
        </button>
      </div>

      {err && (
        <div className="mt-3 rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
          {err}
        </div>
      )}

      {result && (
        <div
          className={
            'mt-3 rounded-lg px-3 py-2 text-sm ' +
            (result.sent
              ? 'bg-cpcqc-teal-dark/10 text-cpcqc-purple-dark'
              : 'bg-cpcqc-orange-dark/10 text-cpcqc-orange-dark')
          }
        >
          {result.sent ? (
            <>
              <strong>Sent.</strong> Check {email.trim()} (and spam). Outbound email is working —
              from <code className="font-mono">{result.fromAddress}</code>.
            </>
          ) : (
            <>
              <strong>Not sent.</strong> {result.error}
              {!result.configured && (
                <div className="mt-1 text-xs text-cpcqc-orange-dark/90">
                  The app uses SendGrid. You'll need a SendGrid account, a verified sender for{' '}
                  <code className="font-mono">{result.fromAddress}</code>, and the{' '}
                  <code className="font-mono">SENDGRID_API_KEY</code> env var set on the backend
                  service.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function RemoveChampionModal({
  user,
  onClose,
  onRemoved,
}: {
  user: StaffUserListItem;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function doRemove() {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/staff/users/${user.id}/deactivate`, {});
      onRemoved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove this champion.');
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink-dark" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
            Remove champion
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 pb-5 pt-4">
          {error && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {error}
            </div>
          )}
          <p className="text-sm text-cpcqc-purple-dark/80">
            Remove <strong>{name}</strong> ({user.email})? They&rsquo;ll immediately lose access
            and any active session is signed out.
          </p>
          <p className="text-xs text-cpcqc-purple-dark/60">
            Their roster entry and history stay intact — this only revokes the login. CPCQC can
            restore the account later if needed.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void doRemove()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full bg-cpcqc-pink-dark px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-pink-dark/90 disabled:opacity-50"
            >
              <UserX size={14} aria-hidden />
              {busy ? 'Removing…' : 'Remove champion'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateChampionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  // Champion's roster title. Dropdown of common roles + "Other" → free text
  // (the long tail: CNO, VP of Nursing, etc.).
  const [roleSelect, setRoleSelect] = useState('');
  const [roleOther, setRoleOther] = useState('');
  const championRole = roleSelect === 'Other' ? roleOther.trim() : roleSelect;
  const [hospital, setHospital] = useState<{ id: string; name: string } | null>(null);
  const [hospSearch, setHospSearch] = useState('');
  const [hospResults, setHospResults] = useState<Array<{ id: string; name: string }>>([]);
  const [initiativeCode, setInitiativeCode] = useState<'' | 'TTT' | 'SPARK' | 'SOAR' | 'NEST'>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateChampionResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (!hospSearch.trim() || hospital) {
        setHospResults([]);
        return;
      }
      api
        .get<{ hospitals: Array<{ id: string; name: string }> }>(
          `/hospitals?search=${encodeURIComponent(hospSearch.trim())}&limit=20`,
        )
        .then((d) => !cancelled && setHospResults(d.hospitals))
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [hospSearch, hospital]);

  const canSubmit =
    firstName.trim() && email.trim() && hospital && initiativeCode && championRole && !saving;

  async function submit() {
    if (!canSubmit || !hospital || !initiativeCode) return;
    setError(null);
    setSaving(true);
    try {
      const res = await api.post<CreateChampionResponse>('/staff/users', {
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        email: email.trim(),
        hospitalId: hospital.id,
        initiativeCode,
        championRole,
      });
      setCreated(res);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the account.');
    } finally {
      setSaving(false);
    }
  }

  function copyPassword() {
    if (!created?.tempPassword) return;
    void navigator.clipboard?.writeText(created.tempPassword).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
            {created ? 'Account created' : 'New champion account'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {created ? (
          <div className="space-y-4 px-6 pb-5 pt-4">
            {created.emailed ? (
              <>
                <div className="flex items-start gap-2 rounded-lg bg-cpcqc-teal-dark/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
                  <CheckCircle2
                    size={16}
                    className="mt-0.5 shrink-0 text-cpcqc-teal-dark"
                    aria-hidden
                  />
                  <span>
                    We've emailed <strong>{created.user.email}</strong> their sign-in details for{' '}
                    <strong>{created.user.hospital.name}</strong>, and added them to the{' '}
                    <strong>{created.user.initiative.code}</strong> roster. They'll set their own
                    password on first login — nothing more for you to do.
                  </span>
                </div>
                <p className="text-xs text-cpcqc-purple-dark/60">
                  If they don't see it, ask them to check spam, or you can resend by recreating —
                  the account already exists, so use the access tools instead.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2 rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-orange-dark">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden />
                  <span>
                    Account for <strong>{created.user.email}</strong> at{' '}
                    <strong>{created.user.hospital.name}</strong> is created, but the welcome email
                    couldn't be sent. Share these details with the champion manually:
                  </span>
                </div>
                <div className="rounded-lg border border-cpcqc-purple-dark/20 bg-cpcqc-cream-dark/20 p-3 text-sm text-cpcqc-purple-dark">
                  <div>
                    <span className="text-cpcqc-purple-dark/60">Sign in at:</span>{' '}
                    {created.loginUrl}
                  </div>
                  <div className="mt-1">
                    <span className="text-cpcqc-purple-dark/60">Email:</span> {created.user.email}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-cpcqc-purple-dark/60">Password:</span>
                    <code className="break-all font-mono">{created.tempPassword}</code>
                    <button
                      type="button"
                      onClick={copyPassword}
                      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
                    >
                      <Copy size={12} aria-hidden /> {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-cpcqc-purple-dark/60">
                    Shown once — they'll change it on first sign-in (Account → Change password).
                  </p>
                </div>
              </>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 px-6 pb-5 pt-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name" required>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="modal-input"
                />
              </Field>
              <Field label="Last name">
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="modal-input"
                />
              </Field>
            </div>
            <Field label="Email" required>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@hospital.org"
                className="modal-input"
              />
            </Field>

            <Field label="Hospital" required>
              {hospital ? (
                <div className="flex items-center gap-2 rounded-lg border border-cpcqc-purple/30 bg-cpcqc-purple/5 px-3 py-2 text-sm text-cpcqc-purple-dark">
                  <Building2 size={14} className="text-cpcqc-purple" aria-hidden />
                  {hospital.name}
                  <button
                    type="button"
                    onClick={() => {
                      setHospital(null);
                      setHospSearch('');
                    }}
                    className="ml-auto text-xs font-bold uppercase text-cpcqc-purple-dark/60 hover:text-cpcqc-purple"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    value={hospSearch}
                    onChange={(e) => setHospSearch(e.target.value)}
                    placeholder="Search hospitals…"
                    className="modal-input"
                  />
                  {hospResults.length > 0 && (
                    <ul className="mt-1 max-h-40 overflow-auto rounded-lg border border-cpcqc-purple-dark/15">
                      {hospResults.map((h) => (
                        <li key={h.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setHospital(h);
                              setHospResults([]);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-cpcqc-purple-dark hover:bg-cpcqc-purple/5"
                          >
                            <Building2 size={13} className="text-cpcqc-purple-dark/50" aria-hidden />
                            {h.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Field>

            <Field label="Initiative" required>
              <select
                value={initiativeCode}
                onChange={(e) =>
                  setInitiativeCode(
                    e.target.value as '' | 'TTT' | 'SPARK' | 'SOAR' | 'NEST',
                  )
                }
                className="modal-input"
              >
                <option value="">Select…</option>
                <option value="TTT">TTT — Turning the Tide</option>
                <option value="SPARK">SPARK — Postpartum Discharge Transitions</option>
                <option value="SOAR">SOAR — Primary Cesarean Reduction</option>
                <option value="NEST">NEST — Infant Safe Sleep</option>
              </select>
              <span className="mt-1 block text-xs text-cpcqc-purple-dark/60">
                Which initiative this person champions — they'll be added to that
                initiative's roster for the hospital.
              </span>
            </Field>

            <Field label="Role" required>
              <select
                value={roleSelect}
                onChange={(e) => setRoleSelect(e.target.value)}
                className="modal-input"
              >
                <option value="">Select…</option>
                <option value="Clinical Lead">Clinical Lead</option>
                <option value="QI Champion">QI Champion</option>
                <option value="Data Champion">Data Champion</option>
                <option value="Provider Champion">Provider Champion</option>
                <option value="L&D Champion">L&amp;D Champion</option>
                <option value="C-Suite Sponsor">C-Suite Sponsor</option>
                <option value="Primary Contact">Primary Contact</option>
                <option value="Other">Other…</option>
              </select>
              {roleSelect === 'Other' && (
                <input
                  type="text"
                  value={roleOther}
                  onChange={(e) => setRoleOther(e.target.value)}
                  placeholder="e.g. VP of Nursing, CNO"
                  className="modal-input mt-2"
                />
              )}
            </Field>

            {error && (
              <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!canSubmit}
                className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
              >
                {saving ? 'Creating…' : 'Create account'}
              </button>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        :global(.modal-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(106, 101, 135, 0.2);
          background-color: white;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: rgb(46, 39, 87);
        }
        :global(.modal-input:focus) {
          outline: none;
          border-color: rgb(106, 101, 135);
          box-shadow: 0 0 0 3px rgba(106, 101, 135, 0.15);
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
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        {label}
        {required && <span className="ml-0.5 text-cpcqc-pink-dark">*</span>}
      </span>
      {children}
    </label>
  );
}

// Common roster titles, offered as suggestions when editing a champion's role.
// Free text is still allowed (the field is an <input> backed by this datalist).
const CHAMPION_ROLE_OPTIONS = [
  'Clinical Lead',
  'QI Champion',
  'Data Champion',
  'Provider Champion',
  'L&D Champion',
  'C-Suite Sponsor',
  'Primary Contact',
];

function ManageAccessModal({
  user,
  onClose,
  onChanged,
  onSaved,
}: {
  user: StaffUserListItem;
  onClose: () => void;
  onChanged: (delta: number) => void;
  onSaved: () => void;
}) {
  const [data, setData] = useState<UserHospitalsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable contact details + per-initiative roster title.
  const [form, setForm] = useState<{
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  } | null>(null);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the edit form once, when the user's data first arrives.
  useEffect(() => {
    if (data && !form) {
      setForm({
        firstName: data.user.firstName ?? '',
        lastName: data.user.lastName ?? '',
        email: data.user.email,
        phone: data.phone ?? '',
      });
      setRoles(Object.fromEntries(data.rosterEntries.map((r) => [r.id, r.role ?? ''])));
    }
  }, [data, form]);

  async function saveDetails() {
    if (!form || !data) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patch(`/staff/users/${user.id}`, {
        firstName: form.firstName,
        lastName: form.lastName,
        email: form.email,
        phone: form.phone,
        rosterRoles: data.rosterEntries.map((r) => ({ id: r.id, role: roles[r.id] ?? '' })),
      });
      const fresh = await api.get<UserHospitalsResponse>(`/staff/users/${user.id}/hospitals`);
      setData(fresh);
      setForm({
        firstName: fresh.user.firstName ?? '',
        lastName: fresh.user.lastName ?? '',
        email: fresh.user.email,
        phone: fresh.phone ?? '',
      });
      setRoles(Object.fromEntries(fresh.rosterEntries.map((r) => [r.id, r.role ?? ''])));
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  // Add-hospital picker.
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerResults, setPickerResults] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const load = () =>
    api
      .get<UserHospitalsResponse>(`/staff/users/${user.id}/hospitals`)
      .then(setData)
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (!pickerSearch.trim()) {
        setPickerResults([]);
        return;
      }
      api
        .get<{ hospitals: Array<{ id: string; name: string }> }>(
          `/hospitals?search=${encodeURIComponent(pickerSearch.trim())}&limit=20`,
        )
        .then((d) => !cancelled && setPickerResults(d.hospitals))
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [pickerSearch]);

  async function grant(hospitalId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.post(`/staff/users/${user.id}/hospitals`, { hospitalId });
      setPickerSearch('');
      setPickerResults([]);
      await load();
      onChanged(1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not grant access.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(hospitalId: string) {
    setError(null);
    setBusy(true);
    try {
      await api.del(`/staff/users/${user.id}/hospitals/${hospitalId}`);
      await load();
      onChanged(-1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke access.');
    } finally {
      setBusy(false);
    }
  }

  const existingIds = new Set(
    [data?.primaryHospital?.id, ...(data?.additionalHospitals ?? []).map((h) => h.id)].filter(
      Boolean,
    ) as string[],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">
              {[user.firstName, user.lastName].filter(Boolean).join(' ') || user.email}
            </h2>
            <p className="mt-0.5 text-sm text-cpcqc-purple-dark/70">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-6 pb-5 pt-4">
          {error && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {error}
            </div>
          )}

          {/* Editable contact details + role */}
          {form && (
            <div className="rounded-xl border border-cpcqc-purple-dark/15 bg-cpcqc-cream-dark/20 p-3">
              <div className="mb-2 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                Contact details &amp; role
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="modal-input"
                  placeholder="First name"
                  value={form.firstName}
                  onChange={(e) => {
                    setForm({ ...form, firstName: e.target.value });
                    setSaved(false);
                  }}
                />
                <input
                  className="modal-input"
                  placeholder="Last name"
                  value={form.lastName}
                  onChange={(e) => {
                    setForm({ ...form, lastName: e.target.value });
                    setSaved(false);
                  }}
                />
              </div>
              <input
                type="email"
                className="modal-input mt-2"
                placeholder="Email"
                value={form.email}
                onChange={(e) => {
                  setForm({ ...form, email: e.target.value });
                  setSaved(false);
                }}
              />
              <p className="mt-1 text-xs text-cpcqc-purple-dark/55">
                This is also their sign-in email — changing it changes how they log in.
              </p>

              {data && data.rosterEntries.length > 0 ? (
                <>
                  <input
                    className="modal-input mt-2"
                    placeholder="Phone"
                    value={form.phone}
                    onChange={(e) => {
                      setForm({ ...form, phone: e.target.value });
                      setSaved(false);
                    }}
                  />
                  <div className="mt-3 space-y-2">
                    <div className="text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
                      Role by initiative
                    </div>
                    {data.rosterEntries.map((r) => (
                      <div key={r.id} className="flex items-center gap-2">
                        <span className="w-16 shrink-0 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
                          {r.initiativeCode ?? '—'}
                        </span>
                        <input
                          list="champion-role-options"
                          className="modal-input flex-1"
                          placeholder="e.g. QI Champion"
                          value={roles[r.id] ?? ''}
                          onChange={(e) => {
                            setRoles({ ...roles, [r.id]: e.target.value });
                            setSaved(false);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="mt-2 text-xs italic text-cpcqc-purple-dark/50">
                  No initiative roster entry yet — phone &amp; role live on the roster, so add them
                  from the hospital&rsquo;s roster.
                </p>
              )}

              <datalist id="champion-role-options">
                {CHAMPION_ROLE_OPTIONS.map((o) => (
                  <option key={o} value={o} />
                ))}
              </datalist>

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveDetails()}
                  disabled={saving}
                  className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save details'}
                </button>
                {saved && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                    <CheckCircle2 size={14} aria-hidden /> Saved
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Primary (read-only) */}
          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Primary hospital
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-cpcqc-cream-dark/30 px-3 py-2 text-sm text-cpcqc-purple-dark">
              <Building2 size={14} className="text-cpcqc-purple-dark/60" aria-hidden />
              {data?.primaryHospital?.name ?? '—'}
              <span className="ml-auto text-xs text-cpcqc-purple-dark/50">primary</span>
            </div>
          </div>

          {/* Additional grants */}
          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Additional hospitals
            </div>
            {data && data.additionalHospitals.length === 0 ? (
              <p className="rounded-lg border border-dashed border-cpcqc-purple-dark/20 px-3 py-2 text-sm italic text-cpcqc-purple-dark/50">
                None yet — add one below for regional access.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {data?.additionalHospitals.map((h) => (
                  <li
                    key={h.id}
                    className="flex items-center gap-2 rounded-lg border border-cpcqc-purple-dark/15 px-3 py-2 text-sm text-cpcqc-purple-dark"
                  >
                    <Building2 size={14} className="text-cpcqc-purple" aria-hidden />
                    {h.name}
                    <button
                      type="button"
                      onClick={() => void revoke(h.id)}
                      disabled={busy}
                      className="ml-auto inline-flex items-center rounded-full p-1 text-cpcqc-purple-dark/50 hover:bg-cpcqc-pink-dark/10 hover:text-cpcqc-pink-dark disabled:opacity-40"
                      aria-label={`Remove ${h.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add picker */}
          <div>
            <div className="mb-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/60">
              Add a hospital
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2">
              <Plus size={14} className="text-cpcqc-purple-dark/50" aria-hidden />
              <input
                type="text"
                value={pickerSearch}
                onChange={(e) => setPickerSearch(e.target.value)}
                placeholder="Search hospitals to grant…"
                className="w-full bg-transparent text-sm text-cpcqc-purple-dark focus:outline-none"
              />
            </div>
            {pickerResults.length > 0 && (
              <ul className="mt-1 max-h-44 overflow-auto rounded-lg border border-cpcqc-purple-dark/15">
                {pickerResults.map((h) => {
                  const already = existingIds.has(h.id);
                  return (
                    <li key={h.id}>
                      <button
                        type="button"
                        disabled={already || busy}
                        onClick={() => void grant(h.id)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-cpcqc-purple-dark hover:bg-cpcqc-purple/5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Building2 size={13} className="text-cpcqc-purple-dark/50" aria-hidden />
                        {h.name}
                        {already && (
                          <span className="ml-auto text-xs text-cpcqc-purple-dark/50">
                            already has access
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <p className="text-xs text-cpcqc-purple-dark/60">
            Changes take effect the next time {user.firstName || 'the user'} signs in (or within
            ~15 minutes as their session refreshes).
          </p>
        </div>
      </div>
    </div>
  );
}
