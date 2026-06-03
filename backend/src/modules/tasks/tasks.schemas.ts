/**
 * Zod schemas for the per-task-type "Manage Task" payload.
 *
 * Each schema captures the fields we expect the hospital (or program manager)
 * to supply when completing a task of that type. Validated payloads are
 * persisted into TaskInstance.payload (JSONB).
 */
import { z } from 'zod';

// Required champions (L&D, Data, Provider) — name required, email optional.
const championSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
});

// Optional "Other" champions — same shape plus a free-text role description
// (e.g., "Pediatric Hospitalist", "Lactation Consultant").
const otherChampionSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
});

export const enrollmentFormPayload = z.object({
  implementationSite: z.string().min(1).max(200).optional(),
  ldChampion: championSchema.optional(),
  dataChampion: championSchema.optional(),
  providerChampion: championSchema.optional(),
  otherChampion1: otherChampionSchema.optional(),
  otherChampion2: otherChampionSchema.optional(),
  ehrSystem: z.string().max(100).optional(),
  notes: z.string().max(5000).optional(),
});

// Meeting attendance is judged yes/no by hospital — no individual attendees.
// Just the month is captured; quarter is derived from it. meetingMonth is
// optional because the "Did not attend" outcome has no meeting to record.
export const meetingAttendancePayload = z.object({
  meetingMonth: z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM').optional(),
  meetingTitle: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
});

// sessionDate / advisorName are optional for the same reason as meetingMonth
// above — the "Did not attend" outcome has no session to record.
export const qiAdvisingPayload = z.object({
  sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  advisorName: z.string().min(1).max(200).optional(),
  attendees: z.array(z.string().min(1).max(200)).optional(),
  notes: z.string().max(5000).optional(),
});

export const dataSubmissionPayload = z.object({
  attachmentUrl: z.string().url().optional(),
  externalUrl: z.string().url().optional(),
  periodCovered: z.string().max(50).optional(),
  notes: z.string().max(5000).optional(),
});

export const readinessAssessmentPayload = z.object({
  responses: z.record(z.string(), z.unknown()).optional(),
  attachmentUrl: z.string().url().optional(),
  notes: z.string().max(5000).optional(),
});

export const otherPayload = z.object({
  notes: z.string().max(5000).optional(),
  attachmentUrl: z.string().url().optional(),
});

export const manageTaskBody = z.object({
  // 'not_started' is included so the UI can UNDO a mistaken completion — a
  // common request after PMs accidentally mark the wrong task. The service
  // clears completedOn/outcome when status is reset to not_started.
  status: z
    .enum(['not_started', 'complete', 'current_activities', 'needs_revision'])
    .default('complete'),
  /**
   * Qualifies the completion. Only meaningful when status='complete'.
   *   data_submission / readiness_assessment → 'on_time' | 'late' | 'not_submitted'
   *   meeting_attendance / qi_advising       → 'attended' | 'missed'
   * 'late', 'missed', and 'not_submitted' are recorded but do NOT count toward
   * compliance. NULL/omitted = legacy / unspecified (counts toward compliance
   * for back-compat).
   */
  outcome: z.enum(['on_time', 'late', 'attended', 'missed', 'not_submitted']).nullable().optional(),
  staffNote: z.string().max(2000).optional(),
  /** Type-specific payload — validated against the matching schema in the service. */
  payload: z
    .union([
      enrollmentFormPayload,
      meetingAttendancePayload,
      qiAdvisingPayload,
      dataSubmissionPayload,
      readinessAssessmentPayload,
      otherPayload,
    ])
    .optional(),
});

export type ManageTaskBody = z.infer<typeof manageTaskBody>;

export function payloadSchemaForType(taskType: string) {
  switch (taskType) {
    case 'enrollment_form':
      return enrollmentFormPayload;
    case 'meeting_attendance':
      return meetingAttendancePayload;
    case 'qi_advising':
      return qiAdvisingPayload;
    case 'data_submission':
      return dataSubmissionPayload;
    case 'readiness_assessment':
      return readinessAssessmentPayload;
    case 'other':
      return otherPayload;
    default:
      return otherPayload;
  }
}
