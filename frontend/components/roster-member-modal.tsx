'use client';

/**
 * Add/edit dialog for a single hospital_staff_members row, used on the staff
 * hospital-detail page. Add mode is opened from the per-initiative roster
 * group header; Edit mode from the row's pencil icon. Delete uses a separate
 * inline confirm (see ConfirmDeleteRosterRow).
 *
 * Initiative is fixed at open time (the modal doesn't let you reassign
 * someone to a different initiative on edit; if a PM needs that they can
 * delete + re-add, which keeps this dialog narrow).
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from '@/lib/api';
import type { HospitalStaffMember } from '@/lib/types';

interface InitiativeMeta {
  id: string;
  code: string;
  name: string;
}

interface Props {
  hospitalId: string;
  initiative: InitiativeMeta | null; // null = unaffiliated group
  // When present, modal is in Edit mode; when null, Add mode.
  member: HospitalStaffMember | null;
  onClose: () => void;
  onSaved: (m: HospitalStaffMember) => void;
}

export function RosterMemberModal({ hospitalId, initiative, member, onClose, onSaved }: Props) {
  const isEdit = member !== null;
  const [name, setName] = useState(member?.name ?? '');
  const [role, setRole] = useState(member?.role ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        initiativeId: initiative?.id ?? null,
        name: trimmedName,
        role: role.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
      };
      const path = isEdit
        ? `/staff/hospitals/${hospitalId}/staff/${member!.id}`
        : `/staff/hospitals/${hospitalId}/staff`;
      const res = isEdit
        ? await api.patch<{ staffMember: HospitalStaffMember }>(path, payload)
        : await api.post<{ staffMember: HospitalStaffMember }>(path, payload);
      onSaved(res.staffMember);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="roster-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-cpcqc-purple-dark/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cpcqc-purple-dark/10 px-5 py-3">
          <h3
            id="roster-modal-title"
            className="font-rounded text-lg font-extrabold text-cpcqc-purple-dark"
          >
            {isEdit ? 'Edit roster entry' : 'Add to roster'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/5 hover:text-cpcqc-purple-dark"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          {initiative && (
            <p className="text-xs text-cpcqc-purple-dark/70">
              <span className="font-bold uppercase tracking-wide">{initiative.code}</span>
              {' · '}
              {initiative.name}
            </p>
          )}

          <Field label="Name" required>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30"
            />
          </Field>

          <Field label="Role">
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Clinical Lead, QI Champion, VP of Nursing"
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30"
            />
          </Field>

          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@hospital.org"
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30"
            />
          </Field>

          <Field label="Phone">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(optional)"
              className="w-full rounded-lg border border-cpcqc-purple-dark/20 px-3 py-2 text-sm focus:border-cpcqc-purple focus:outline-none focus:ring-2 focus:ring-cpcqc-purple/30"
            />
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
              type="submit"
              disabled={saving || !name.trim()}
              className="rounded-full bg-cpcqc-purple px-4 py-1.5 text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add to roster'}
            </button>
          </div>
        </form>
      </div>
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
