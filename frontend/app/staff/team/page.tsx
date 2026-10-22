'use client';

/**
 * CPCQC staff accounts — admins only.
 *
 * Lists the CPCQC staff and admin accounts, adds new ones, and sends setup
 * links. A new account never has a password anyone knows: the person gets an
 * emailed link to choose their own. The link is shown here only if the email
 * could not be sent, so the admin can pass it on.
 *
 * Hospital champion accounts are on the Access page.
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Mail, ShieldCheck, UserPlus, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import type {
  CreateStaffAccountResponse,
  StaffAccount,
  StaffAssignmentRole,
  StaffInitiativeCode,
  StaffSetupLinkResponse,
} from '@/lib/types';

const INITIATIVES: Array<{ code: StaffInitiativeCode; name: string }> = [
  { code: 'TTT', name: 'Turning the Tide' },
  { code: 'SPARK', name: 'SPARK' },
  { code: 'SOAR', name: 'SOAR' },
  { code: 'NEST', name: 'NEST' },
];

const ROLE_LABEL: Record<StaffAssignmentRole, string> = {
  program_manager: 'Program Manager',
  qi_advisor: 'QI Advisor',
};

function fullName(s: StaffAccount): string {
  return [s.firstName, s.lastName].filter(Boolean).join(' ') || s.email;
}

export default function StaffTeamPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'cpcqc_admin';
  const [staff, setStaff] = useState<StaffAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [linkFor, setLinkFor] = useState<StaffAccount | null>(null);

  const load = useCallback(() => {
    api
      .get<{ staff: StaffAccount[] }>('/staff/team')
      .then((d) => setStaff(d.staff))
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <div className="rounded-2xl bg-white p-6 text-cpcqc-purple-dark shadow-card">
        <h1 className="font-rounded text-2xl font-extrabold">Team</h1>
        <p className="mt-2 text-sm text-cpcqc-purple-dark/70">
          Only CPCQC admins can manage staff accounts. Ask an admin if someone needs access.
        </p>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-rounded text-3xl font-extrabold text-cpcqc-purple-dark">Team</h1>
          <p className="mt-1 max-w-2xl text-cpcqc-purple-dark/70">
            CPCQC staff accounts. A new staff member is emailed a link to choose their own
            password — nobody else ever knows it. Hospital champions are managed under Access.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-cpcqc-purple px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
        >
          <UserPlus size={16} aria-hidden /> Add staff member
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">{error}</div>
      )}

      <div className="overflow-x-auto rounded-2xl bg-white shadow-card ring-1 ring-cpcqc-purple-dark/5">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-cpcqc-purple-dark/10 text-xs uppercase tracking-wide text-cpcqc-purple-dark/60">
            <tr>
              <th className="px-4 py-3 font-bold">Name</th>
              <th className="px-4 py-3 font-bold">Access</th>
              <th className="px-4 py-3 font-bold">Initiative roles</th>
              <th className="px-4 py-3 font-bold" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {staff === null && !error && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-cpcqc-purple-dark/60">
                  Loading…
                </td>
              </tr>
            )}
            {staff?.map((s) => (
              <tr key={s.id} className={`border-b border-cpcqc-purple-dark/5 ${s.active ? '' : 'opacity-60'}`}>
                <td className="px-4 py-3">
                  <div className="font-semibold text-cpcqc-purple-dark">{fullName(s)}</div>
                  <div className="text-xs text-cpcqc-purple-dark/60">{s.email}</div>
                </td>
                <td className="px-4 py-3">
                  {!s.active ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">
                      Deactivated
                    </span>
                  ) : s.role === 'cpcqc_admin' ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-cpcqc-purple/10 px-2 py-0.5 text-xs font-bold text-cpcqc-purple-dark">
                      <ShieldCheck size={12} aria-hidden /> Admin
                    </span>
                  ) : (
                    <span className="rounded-full bg-cpcqc-teal-dark/10 px-2 py-0.5 text-xs font-bold text-cpcqc-teal-dark">
                      Staff
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-cpcqc-purple-dark/80">
                  {s.assignments.length === 0 ? (
                    <span className="text-cpcqc-purple-dark/40">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {s.assignments.map((a) => (
                        <span
                          key={`${a.initiativeCode}:${a.role}`}
                          className="rounded-full border border-cpcqc-purple-dark/15 px-2 py-0.5 text-xs"
                        >
                          {a.initiativeCode} · {ROLE_LABEL[a.role]}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {s.active && (
                    <button
                      type="button"
                      onClick={() => setLinkFor(s)}
                      className="inline-flex items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-3 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
                    >
                      <Mail size={12} aria-hidden /> Send setup link
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && <AddStaffModal onClose={() => setShowAdd(false)} onCreated={load} />}
      {linkFor && <SetupLinkModal member={linkFor} onClose={() => setLinkFor(null)} />}

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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-4 px-6 pb-5 pt-4">{children}</div>
      </div>
    </div>
  );
}

/** Outcome of sending a setup link: confirmation, or the link to pass on by hand. */
function SetupLinkOutcome({ email, result }: { email: string; result: StaffSetupLinkResponse }) {
  const [copied, setCopied] = useState(false);
  if (result.emailed) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-cpcqc-teal-dark/10 px-3 py-2 text-sm text-cpcqc-purple-dark">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-cpcqc-teal-dark" aria-hidden />
        <span>
          We&apos;ve emailed <strong>{email}</strong> a link to choose their password. It works once
          and expires in {result.expiresInDays} days.
        </span>
      </div>
    );
  }
  return (
    <>
      <div className="rounded-lg bg-cpcqc-orange-dark/10 px-3 py-2 text-sm text-cpcqc-orange-dark">
        The email to <strong>{email}</strong> couldn&apos;t be sent. Pass this link to them directly
        — it lets them choose their password, works once, and expires in {result.expiresInDays}{' '}
        days.
      </div>
      <div className="rounded-lg border border-cpcqc-purple-dark/20 bg-cpcqc-cream-dark/20 p-3 text-sm text-cpcqc-purple-dark">
        <code className="block break-all font-mono text-xs">{result.setupUrl}</code>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-cpcqc-purple-dark/60">Shown once. Treat it like a password.</span>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(result.setupUrl ?? '').then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-cpcqc-purple-dark/20 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
          >
            <Copy size={12} aria-hidden /> {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </>
  );
}

function AddStaffModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [admin, setAdmin] = useState(false);
  const [assignments, setAssignments] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateStaffAccountResponse | null>(null);

  const canSubmit = firstName.trim() && email.trim() && !saving;

  function toggle(key: string) {
    setAssignments((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setSaving(true);
    try {
      const res = await api.post<CreateStaffAccountResponse>('/staff/team', {
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        email: email.trim(),
        role: admin ? 'cpcqc_admin' : 'cpcqc_staff',
        assignments: [...assignments].map((key) => {
          const [initiativeCode, role] = key.split(':') as [StaffInitiativeCode, StaffAssignmentRole];
          return { initiativeCode, role };
        }),
      });
      setCreated(res);
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the staff member.');
    } finally {
      setSaving(false);
    }
  }

  if (created) {
    return (
      <Modal title="Staff member added" onClose={onClose}>
        <SetupLinkOutcome email={created.account.email} result={created} />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90"
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Add staff member" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" required>
          <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} className="modal-input" />
        </Field>
        <Field label="Last name">
          <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} className="modal-input" />
        </Field>
      </div>
      <Field label="Email" required>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@cpcqc.org"
          className="modal-input"
        />
      </Field>

      <fieldset>
        <legend className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
          Access
        </legend>
        <div className="space-y-2">
          {[
            { value: false, label: 'Staff', help: 'Everything in the tracker except managing staff accounts.' },
            { value: true, label: 'Admin', help: 'Staff access, plus adding staff members and sending setup links.' },
          ].map((o) => (
            <label
              key={o.label}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                admin === o.value ? 'border-cpcqc-purple bg-cpcqc-purple/5' : 'border-cpcqc-purple-dark/15'
              }`}
            >
              <input
                type="radio"
                name="access"
                checked={admin === o.value}
                onChange={() => setAdmin(o.value)}
                className="mt-1"
              />
              <span>
                <span className="font-semibold text-cpcqc-purple-dark">{o.label}</span>
                <span className="block text-xs text-cpcqc-purple-dark/60">{o.help}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 block text-xs font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
          Initiative roles
        </legend>
        <p className="mb-2 text-xs text-cpcqc-purple-dark/60">
          Leave blank for roles that span every initiative.
        </p>
        <div className="overflow-hidden rounded-lg border border-cpcqc-purple-dark/15">
          <table className="w-full text-sm">
            <thead className="bg-cpcqc-cream-dark/20 text-xs text-cpcqc-purple-dark/70">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Initiative</th>
                <th className="px-3 py-1.5 font-semibold">Program Manager</th>
                <th className="px-3 py-1.5 font-semibold">QI Advisor</th>
              </tr>
            </thead>
            <tbody>
              {INITIATIVES.map((i) => (
                <tr key={i.code} className="border-t border-cpcqc-purple-dark/10">
                  <td className="px-3 py-1.5 text-cpcqc-purple-dark">{i.name}</td>
                  {(['program_manager', 'qi_advisor'] as const).map((role) => (
                    <td key={role} className="px-3 py-1.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${ROLE_LABEL[role]} for ${i.name}`}
                        checked={assignments.has(`${i.code}:${role}`)}
                        onChange={() => toggle(`${i.code}:${role}`)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </fieldset>

      {error && (
        <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">{error}</div>
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
          {saving ? 'Adding…' : 'Add and send setup link'}
        </button>
      </div>
    </Modal>
  );
}

function SetupLinkModal({ member, onClose }: { member: StaffAccount; onClose: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StaffSetupLinkResponse | null>(null);

  async function send() {
    setError(null);
    setSending(true);
    try {
      setResult(await api.post<StaffSetupLinkResponse>(`/staff/team/${member.id}/setup-link`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the setup link.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title="Send setup link" onClose={onClose}>
      {result ? (
        <>
          <SetupLinkOutcome email={member.email} result={result} />
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
          <p className="text-sm text-cpcqc-purple-dark">
            Email <strong>{fullName(member)}</strong> ({member.email}) a link to choose a new
            password? Use this when someone is new and their first link expired, or can&apos;t get
            in. Their current password keeps working until they use the link.
          </p>
          {error && (
            <div className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">{error}</div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending}
              className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send link'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
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
