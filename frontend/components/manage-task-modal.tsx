'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { TASK_TYPE_LABEL, fmtPeriod } from '@/lib/format';
import type { TaskRow, TaskStatus, TaskOutcome } from '@/lib/types';

/**
 * Composite UI value combining task status + outcome. Each option maps to a
 * (status, outcome) pair sent to the backend. The available options depend on
 * task type — see optionsForTaskType below.
 */
type OutcomeOption =
  | 'submitted_on_time'
  | 'submitted_late'
  | 'not_submitted'
  | 'attended'
  | 'did_not_attend'
  | 'complete'
  | 'current_activities'
  | 'needs_revision';

function optionsForTaskType(taskType: TaskRow['template']['taskType']): {
  value: OutcomeOption;
  label: string;
}[] {
  switch (taskType) {
    // Three-way outcome — PMs need to record "didn't submit at all" alongside
    // on-time / late.
    case 'data_submission':
    case 'readiness_assessment':
      return [
        { value: 'submitted_on_time', label: 'Submitted on time' },
        { value: 'submitted_late', label: 'Submitted late' },
        { value: 'not_submitted', label: 'Not submitted' },
      ];
    // Binary outcomes only — no "in progress" or "needs revision" for attendance.
    case 'meeting_attendance':
    case 'qi_advising':
      return [
        { value: 'attended', label: 'Attended' },
        { value: 'did_not_attend', label: 'Did not attend' },
      ];
    // enrollment_form and 'other' keep the legacy options.
    default:
      return [
        { value: 'complete', label: 'Complete' },
        { value: 'current_activities', label: 'In progress' },
        { value: 'needs_revision', label: 'Needs revision' },
      ];
  }
}

function outcomeOptionToWire(value: OutcomeOption): {
  status: TaskStatus;
  outcome: TaskOutcome;
} {
  switch (value) {
    case 'submitted_on_time':
      return { status: 'complete', outcome: 'on_time' };
    case 'submitted_late':
      return { status: 'complete', outcome: 'late' };
    case 'not_submitted':
      return { status: 'complete', outcome: 'not_submitted' };
    case 'attended':
      return { status: 'complete', outcome: 'attended' };
    case 'did_not_attend':
      return { status: 'complete', outcome: 'missed' };
    case 'complete':
      return { status: 'complete', outcome: null };
    case 'current_activities':
      return { status: 'current_activities', outcome: null };
    case 'needs_revision':
      return { status: 'needs_revision', outcome: null };
  }
}

function defaultOutcomeOption(task: TaskRow): OutcomeOption {
  // Derive a sensible default for the dropdown based on current state.
  if (task.status === 'complete') {
    if (task.outcome === 'on_time') return 'submitted_on_time';
    if (task.outcome === 'late') return 'submitted_late';
    if (task.outcome === 'not_submitted') return 'not_submitted';
    if (task.outcome === 'attended') return 'attended';
    if (task.outcome === 'missed') return 'did_not_attend';
    // status complete with no outcome — pick the on_time/attended option
    // for the type if applicable, else generic complete.
    switch (task.template.taskType) {
      case 'data_submission':
      case 'readiness_assessment':
        return 'submitted_on_time';
      case 'meeting_attendance':
      case 'qi_advising':
        return 'attended';
      default:
        return 'complete';
    }
  }
  if (task.status === 'current_activities') return 'current_activities';
  if (task.status === 'needs_revision') return 'needs_revision';
  // 'not_started' — pick the type-default "compliant" option as a hint.
  switch (task.template.taskType) {
    case 'data_submission':
    case 'readiness_assessment':
      return 'submitted_on_time';
    case 'meeting_attendance':
    case 'qi_advising':
      return 'attended';
    default:
      return 'complete';
  }
}

interface ManageTaskModalProps {
  task: TaskRow;
  onClose: () => void;
  onUpdated: (updated: TaskRow) => void;
}

export function ManageTaskModal({ task, onClose, onUpdated }: ManageTaskModalProps) {
  const [outcomeChoice, setOutcomeChoice] = useState<OutcomeOption>(defaultOutcomeOption(task));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Type-specific state
  const [implementationSite, setImplementationSite] = useState('');
  // Champions: L&D, Data, Provider (required) + Other #1, #2 (optional, with role)
  const [ldChampionName, setLdChampionName] = useState('');
  const [ldChampionEmail, setLdChampionEmail] = useState('');
  const [dataChampionName, setDataChampionName] = useState('');
  const [dataChampionEmail, setDataChampionEmail] = useState('');
  const [providerChampionName, setProviderChampionName] = useState('');
  const [providerChampionEmail, setProviderChampionEmail] = useState('');
  const [other1Name, setOther1Name] = useState('');
  const [other1Role, setOther1Role] = useState('');
  const [other1Email, setOther1Email] = useState('');
  const [other2Name, setOther2Name] = useState('');
  const [other2Role, setOther2Role] = useState('');
  const [other2Email, setOther2Email] = useState('');
  const [ehrSystem, setEhrSystem] = useState('');
  const [meetingMonth, setMeetingMonth] = useState(''); // YYYY-MM
  const [meetingTitle, setMeetingTitle] = useState('');
  const [sessionDate, setSessionDate] = useState('');
  const [advisorName, setAdvisorName] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [periodCovered, setPeriodCovered] = useState('');
  const [notes, setNotes] = useState('');

  // Esc to close
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function buildPayload(): Record<string, unknown> | undefined {
    switch (task.template.taskType) {
      case 'enrollment_form': {
        const champion = (name: string, email: string) =>
          name.trim()
            ? { name: name.trim(), ...(email.trim() ? { email: email.trim() } : {}) }
            : undefined;
        const otherChampion = (name: string, role: string, email: string) =>
          name.trim()
            ? {
                name: name.trim(),
                ...(role.trim() ? { role: role.trim() } : {}),
                ...(email.trim() ? { email: email.trim() } : {}),
              }
            : undefined;
        return {
          implementationSite: implementationSite || undefined,
          ldChampion: champion(ldChampionName, ldChampionEmail),
          dataChampion: champion(dataChampionName, dataChampionEmail),
          providerChampion: champion(providerChampionName, providerChampionEmail),
          otherChampion1: otherChampion(other1Name, other1Role, other1Email),
          otherChampion2: otherChampion(other2Name, other2Role, other2Email),
          ehrSystem: ehrSystem || undefined,
          notes: notes || undefined,
        };
      }
      case 'meeting_attendance':
        return {
          meetingMonth,
          meetingTitle: meetingTitle || undefined,
          notes: notes || undefined,
        };
      case 'qi_advising':
        return {
          sessionDate,
          advisorName,
          notes: notes || undefined,
        };
      case 'data_submission':
        // QI data is entered directly in REDCap; we only confirm submission here.
        return {
          periodCovered: periodCovered || undefined,
          notes: notes || undefined,
        };
      case 'readiness_assessment':
        // HRA responses live in REDCap; we only record that it was completed.
        return {
          notes: notes || undefined,
        };
      case 'other':
        return { notes: notes || undefined, attachmentUrl: attachmentUrl || undefined };
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { status, outcome } = outcomeOptionToWire(outcomeChoice);
      const res = await api.post<{ task: TaskRow }>(`/tasks/${task.id}/manage`, {
        status,
        outcome,
        payload: buildPayload(),
      });
      onUpdated(res.task);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-task-title"
      className="fixed inset-0 z-50 grid place-items-center bg-cpcqc-purple-dark/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-card">
        <div className="h-1.5 w-full bg-cpcqc-pink" />
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div>
            <h2
              id="manage-task-title"
              className="font-rounded text-xl font-extrabold text-cpcqc-purple-dark"
            >
              {task.template.name}
            </h2>
            <p className="mt-1 text-sm text-cpcqc-purple-dark/70">
              {TASK_TYPE_LABEL[task.template.taskType]} · {fmtPeriod(task.period)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-cpcqc-purple-dark/60 hover:bg-cpcqc-purple-dark/10"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-5 px-6 pb-6 pt-4">
          {task.template.taskType === 'enrollment_form' && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Implementation site">
                  <input
                    type="text"
                    value={implementationSite}
                    onChange={(e) => setImplementationSite(e.target.value)}
                    placeholder="e.g. Mother–Baby Unit, 4 South"
                    className="modal-input"
                  />
                </Field>
                <Field label="EHR system">
                  <select
                    value={ehrSystem}
                    onChange={(e) => setEhrSystem(e.target.value)}
                    className="modal-input"
                  >
                    <option value="">Select…</option>
                    <option>EPIC</option>
                    <option>Meditech</option>
                    <option>Cerner</option>
                    <option>Other</option>
                  </select>
                </Field>
              </div>

              <ChampionFieldset
                legend="L&D Champion"
                required
                name={ldChampionName}
                onName={setLdChampionName}
                email={ldChampionEmail}
                onEmail={setLdChampionEmail}
              />
              <ChampionFieldset
                legend="Data Champion"
                required
                name={dataChampionName}
                onName={setDataChampionName}
                email={dataChampionEmail}
                onEmail={setDataChampionEmail}
              />
              <ChampionFieldset
                legend="Provider Champion"
                required
                name={providerChampionName}
                onName={setProviderChampionName}
                email={providerChampionEmail}
                onEmail={setProviderChampionEmail}
              />
              <ChampionFieldset
                legend="Other Champion #1"
                name={other1Name}
                onName={setOther1Name}
                role={other1Role}
                onRole={setOther1Role}
                email={other1Email}
                onEmail={setOther1Email}
              />
              <ChampionFieldset
                legend="Other Champion #2"
                name={other2Name}
                onName={setOther2Name}
                role={other2Role}
                onRole={setOther2Role}
                email={other2Email}
                onEmail={setOther2Email}
              />
            </>
          )}

          {task.template.taskType === 'meeting_attendance' && (
            <>
              <div className="rounded-lg bg-cpcqc-cream-dark/40 p-3 text-sm text-cpcqc-purple-dark/80">
                <p>
                  Attendance is judged by hospital — confirm that <em>someone</em> from your
                  hospital attended. No need to list individual attendees.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Meeting month">
                  <input
                    type="month"
                    required
                    value={meetingMonth}
                    onChange={(e) => setMeetingMonth(e.target.value)}
                    className="modal-input"
                  />
                </Field>
                <Field label="Meeting title (optional)">
                  <input
                    type="text"
                    value={meetingTitle}
                    onChange={(e) => setMeetingTitle(e.target.value)}
                    placeholder="e.g. March 2026 Cohort Meeting"
                    className="modal-input"
                  />
                </Field>
              </div>
            </>
          )}

          {task.template.taskType === 'qi_advising' && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Session date">
                  <input
                    type="date"
                    required
                    value={sessionDate}
                    onChange={(e) => setSessionDate(e.target.value)}
                    className="modal-input"
                  />
                </Field>
                <Field label="CPCQC advisor">
                  <input
                    type="text"
                    required
                    value={advisorName}
                    onChange={(e) => setAdvisorName(e.target.value)}
                    className="modal-input"
                  />
                </Field>
              </div>
            </>
          )}

          {task.template.taskType === 'data_submission' && (
            <>
              <div className="rounded-lg bg-cpcqc-cream-dark/40 p-3 text-sm text-cpcqc-purple-dark/80">
                <p>
                  QI data for this period is entered directly in REDCap. Once submitted, record
                  whether it was on time using the dropdown below; late submissions are tracked
                  but do not count toward your data submission requirement.
                </p>
              </div>
              <Field label="Period covered (optional)">
                <input
                  type="text"
                  value={periodCovered}
                  onChange={(e) => setPeriodCovered(e.target.value)}
                  placeholder={fmtPeriod(task.period)}
                  className="modal-input"
                />
              </Field>
            </>
          )}

          {task.template.taskType === 'readiness_assessment' && (
            <div className="rounded-lg bg-cpcqc-cream-dark/40 p-3 text-sm text-cpcqc-purple-dark/80">
              <p>
                Hospital Readiness Assessments are entered in REDCap. Once submitted, record
                whether it was on time using the dropdown below; late submissions are tracked
                but do not count toward your HRA requirement.
              </p>
            </div>
          )}

          {task.template.taskType === 'other' && (
            <Field label="Attachment / link (optional)">
              <input
                type="url"
                value={attachmentUrl}
                onChange={(e) => setAttachmentUrl(e.target.value)}
                className="modal-input"
              />
            </Field>
          )}

          <Field label="Notes (optional)">
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="modal-input"
            />
          </Field>

          <Field label="Mark as">
            <select
              value={outcomeChoice}
              onChange={(e) => setOutcomeChoice(e.target.value as OutcomeOption)}
              className="modal-input"
            >
              {optionsForTaskType(task.template.taskType).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {(outcomeChoice === 'submitted_late' ||
              outcomeChoice === 'not_submitted' ||
              outcomeChoice === 'did_not_attend') && (
              <p className="mt-1.5 text-xs text-cpcqc-purple-dark/65">
                {outcomeChoice === 'submitted_late'
                  ? 'Will be recorded but does not count toward the data submission requirement.'
                  : outcomeChoice === 'not_submitted'
                    ? 'Will be recorded but does not count toward the requirement.'
                    : 'Will be recorded but does not count toward the attendance requirement.'}
              </p>
            )}
          </Field>

          {error && (
            <p className="rounded-lg bg-cpcqc-pink-dark/10 px-3 py-2 text-sm text-cpcqc-pink-dark">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-cpcqc-purple-dark/20 px-4 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark hover:bg-cpcqc-purple-dark/5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-full bg-cpcqc-purple px-5 py-2 font-rounded text-sm font-bold uppercase tracking-wide text-white hover:bg-cpcqc-purple/90 disabled:opacity-60"
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>

      <style jsx>{`
        :global(.modal-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid rgba(106, 101, 135, 0.2);
          background-color: white;
          padding: 0.5rem 0.75rem;
          font-size: 0.95rem;
        }
        :global(.modal-input:focus) {
          outline: none;
          border-color: #6b529b;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-cpcqc-purple-dark">{label}</span>
      {children}
    </label>
  );
}

function ChampionFieldset(props: {
  legend: string;
  required?: boolean;
  name: string;
  onName: (v: string) => void;
  role?: string;
  onRole?: (v: string) => void;
  email: string;
  onEmail: (v: string) => void;
}) {
  return (
    <fieldset className="rounded-lg border border-cpcqc-purple-dark/15 p-4">
      <legend className="px-2 text-sm font-bold uppercase tracking-wide text-cpcqc-purple-dark/70">
        {props.legend}
        {props.required && <span className="ml-1 text-cpcqc-pink-dark">*</span>}
      </legend>
      <div
        className={
          props.onRole
            ? 'grid grid-cols-1 gap-4 sm:grid-cols-3'
            : 'grid grid-cols-1 gap-4 sm:grid-cols-2'
        }
      >
        <Field label="Name">
          <input
            type="text"
            value={props.name}
            onChange={(e) => props.onName(e.target.value)}
            className="modal-input"
          />
        </Field>
        {props.onRole && (
          <Field label="Role (e.g. Pediatric Hospitalist)">
            <input
              type="text"
              value={props.role ?? ''}
              onChange={(e) => props.onRole!(e.target.value)}
              className="modal-input"
            />
          </Field>
        )}
        <Field label="Email">
          <input
            type="email"
            value={props.email}
            onChange={(e) => props.onEmail(e.target.value)}
            className="modal-input"
          />
        </Field>
      </div>
    </fieldset>
  );
}
