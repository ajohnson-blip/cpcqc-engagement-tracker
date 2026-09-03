/**
 * Database schema for the CPCQC hospital engagement tracker.
 *
 * Mirrors §2 of IMPLEMENTATION_PLAN.md. The central unit is `enrollments`
 * (Hospital × Cohort); compliance is evaluated per `program_years` row.
 *
 * Conventions:
 *  - All primary keys are UUIDs (text), generated app-side.
 *  - All tables include created_at / updated_at timestamps.
 *  - Enums are stored as text + check constraints for schema-evolution friendliness.
 */
import {
  pgTable,
  text,
  integer,
  numeric,
  boolean,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------- Enums ----------

export const userRole = pgEnum('user_role', [
  'hospital_user',
  'hospital_admin',
  'cpcqc_staff',
  'cpcqc_admin',
]);

export const initiativeCode = pgEnum('initiative_code', ['TTT', 'SPARK', 'SOAR', 'NEST']);

export const dataCadence = pgEnum('data_cadence', ['monthly', 'quarterly']);

export const cohortTrack = pgEnum('cohort_track', ['active', 'sustainability']);

export const enrollmentStatus = pgEnum('enrollment_status', [
  'eligible_to_enroll',
  'enrolled',
  'withdrawn',
  'completed',
]);

export const taskType = pgEnum('task_type', [
  'enrollment_form',
  'meeting_attendance',
  'qi_advising',
  'data_submission',
  'readiness_assessment',
  'other',
]);

export const taskStatus = pgEnum('task_status', [
  'not_started',
  'current_activities',
  'complete',
  'needs_revision',
]);

// How a completion was qualified, for tasks where on-time vs late or
// attended vs missed matters. NULL = legacy/unspecified (treat as compliant
// when status='complete' for backwards compatibility). Used for:
//   data_submission, readiness_assessment → on_time | late | not_submitted
//   meeting_attendance, qi_advising        → attended | missed
// "missed" / "late" / "not_submitted" outcomes are recorded (the task is
// status='complete') but they do NOT count toward compliance thresholds.
export const taskOutcome = pgEnum('task_outcome', [
  'on_time',
  'late',
  'attended',
  'missed',
  'not_submitted',
]);

export const meetingType = pgEnum('meeting_type', ['monthly_cohort', 'annual_forum']);

export const interestFormStatus = pgEnum('interest_form_status', [
  'submitted',
  'reviewed',
  'approved',
  'declined',
]);

// Annual interest form (different from the per-initiative interestForms table
// above). Tracks a single hospital's ranked preferences across the rankable
// initiatives for a given upcoming program year. CPCQC uses these in
// aggregate to decide cohort size and mix, then sends the detailed
// initiative-specific Enrollment Forms to accepted hospitals.
export const annualInterestFormStatus = pgEnum('annual_interest_form_status', [
  'submitted',     // hospital submitted; awaiting CPCQC review
  'under_review',  // CPCQC actively reviewing during cohort planning
  'accepted',      // CPCQC accepted to one or more cohorts
  'declined',      // CPCQC declined for the year
]);

export const staffRoleKind = pgEnum('staff_role_kind', [
  'program_manager',
  'qi_advisor',
]);

// ---------- Shared columns ----------

const idCol = (name = 'id') => text(name).primaryKey();
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

// ---------- Core entities ----------

export const hospitals = pgTable(
  'hospitals',
  {
    id: idCol(),
    name: text('name').notNull(), // CHA canonical name
    // External identifiers
    chaHospitalId: text('cha_hospital_id'), // CHA Master Hospital List ID
    cdpheId: text('cdphe_id'),
    aimId: text('aim_id'),
    cmsId: text('cms_id'),
    npi: text('npi'),
    tableauNickname: text('tableau_nickname'),
    // Display + grouping
    system: text('system'), // e.g. "Advent Health", "UCHealth"
    region: text('region'),
    // Address
    addressLine1: text('address_line_1'),
    addressLine2: text('address_line_2'),
    city: text('city'),
    state: text('state').default('CO'),
    postalCode: text('postal_code'),
    county: text('county'),
    // Contact
    defaultContactName: text('default_contact_name'),
    defaultContactEmail: text('default_contact_email'),
    // Status
    inGoodStanding: boolean('in_good_standing').notNull().default(true),
    // Catch-all for less-frequently-queried metadata (NICU level, urbanicity,
    // RAE, HSR, birth volume, etc.)
    metadata: jsonb('metadata'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    nameIdx: uniqueIndex('hospitals_name_idx').on(t.name),
    chaIdIdx: uniqueIndex('hospitals_cha_id_idx').on(t.chaHospitalId),
  }),
);

/**
 * Arbitrary groupings of hospitals CPCQC reports on as a set — a grant's
 * scholarship recipients, say. Generic rather than a column per grant: funders
 * ask about whichever group they funded, and a boolean per cohort would mean a
 * migration per cohort.
 *
 * `tag` is the display label, stored as typed so it reads correctly in a
 * report. A unique index on (hospital_id, lower(tag)) stops one cohort
 * becoming two through capitalisation.
 */
export const hospitalTags = pgTable(
  'hospital_tags',
  {
    hospitalId: text('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.hospitalId, t.tag] }),
  }),
);

export const initiatives = pgTable('initiatives', {
  id: idCol(),
  code: initiativeCode('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  cohortLengthYears: integer('cohort_length_years').notNull().default(1),
  defaultDataCadence: dataCadence('default_data_cadence').notNull(),
  brandColor: text('brand_color'),
  emoji: text('emoji'),
  ...timestamps,
});

/**
 * Snapshot of legal-requirement thresholds per (initiative, track).
 * Used as the source from which each new program_year copies its required-counts.
 * Editing this affects FUTURE program years only.
 */
export const initiativeTrackConfig = pgTable(
  'initiative_track_config',
  {
    id: idCol(),
    initiativeId: text('initiative_id')
      .notNull()
      .references(() => initiatives.id),
    track: cohortTrack('track').notNull(),
    requiredMeetings: integer('required_meetings').notNull(),
    requiredAdvising: integer('required_advising').notNull(),
    requiredDataPeriods: integer('required_data_periods').notNull(),
    dataSubmissionsMin: integer('data_submissions_min').notNull(),
    requiredAssessments: integer('required_assessments').notNull().default(0),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    initiativeTrackIdx: uniqueIndex('initiative_track_config_unique').on(t.initiativeId, t.track),
  }),
);

export const cohorts = pgTable(
  'cohorts',
  {
    id: idCol(),
    initiativeId: text('initiative_id')
      .notNull()
      .references(() => initiatives.id),
    track: cohortTrack('track').notNull(),
    label: text('label').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    initiativeIdx: index('cohorts_initiative_idx').on(t.initiativeId),
    initiativeTrackStartIdx: uniqueIndex('cohorts_initiative_track_start_unique').on(
      t.initiativeId,
      t.track,
      t.startDate,
    ),
  }),
);

/** Canonical stage rows; per IMPLEMENTATION_PLAN.md all four initiatives share these. */
export const stages = pgTable(
  'stages',
  {
    id: idCol(),
    initiativeId: text('initiative_id')
      .notNull()
      .references(() => initiatives.id),
    track: cohortTrack('track').notNull(),
    code: text('code').notNull(), // e.g., "1.", "2.", "3.1", "4.2"
    name: text('name').notNull(),
    sequence: integer('sequence').notNull(),
    quarter: integer('quarter'), // 1-4 if applicable, null for Enrollment/Onboarding
    ...timestamps,
  },
  (t) => ({
    uniqueStage: uniqueIndex('stages_unique').on(t.initiativeId, t.track, t.code),
    sequenceIdx: index('stages_sequence_idx').on(t.initiativeId, t.track, t.sequence),
  }),
);

export const enrollments = pgTable(
  'enrollments',
  {
    id: idCol(),
    hospitalId: text('hospital_id')
      .notNull()
      .references(() => hospitals.id),
    cohortId: text('cohort_id')
      .notNull()
      .references(() => cohorts.id),
    currentStageId: text('current_stage_id').references(() => stages.id),
    status: enrollmentStatus('status').notNull().default('enrolled'),
    enrolledOn: date('enrolled_on').notNull(),
    withdrawnOn: date('withdrawn_on'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    hospitalCohortIdx: uniqueIndex('enrollments_hospital_cohort_unique').on(t.hospitalId, t.cohortId),
    hospitalIdx: index('enrollments_hospital_idx').on(t.hospitalId),
  }),
);

/**
 * One row per (enrollment, year). For 1-year cohorts there's exactly one;
 * for the 2-year TTT cohort there are two. Holds the snapshotted required-counts
 * so historical years don't shift if config changes.
 */
export const programYears = pgTable(
  'program_years',
  {
    id: idCol(),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    year: integer('year').notNull(),
    requiredMeetings: integer('required_meetings').notNull(),
    requiredAdvising: integer('required_advising').notNull(),
    requiredDataPeriods: integer('required_data_periods').notNull(),
    dataSubmissionsMin: integer('data_submissions_min').notNull(),
    requiredAssessments: integer('required_assessments').notNull().default(0),
    // Ordered HRA due quarters for this program year, e.g. ["Q1","Q4"] or, for
    // SPARK 2026, ["Q3","Q4"]. NULL means use the default (Q1 + Q4). Snapshotted
    // at creation so historical schedules are stable if the rule later changes.
    hraSchedule: jsonb('hra_schedule').$type<string[]>(),
    ...timestamps,
  },
  (t) => ({
    uniqueEnrollmentYear: uniqueIndex('program_years_enrollment_year_unique').on(
      t.enrollmentId,
      t.year,
    ),
  }),
);

// ---------- Task model ----------

export const taskTemplates = pgTable(
  'task_templates',
  {
    id: idCol(),
    initiativeId: text('initiative_id')
      .notNull()
      .references(() => initiatives.id),
    track: cohortTrack('track').notNull(),
    stageId: text('stage_id')
      .notNull()
      .references(() => stages.id),
    name: text('name').notNull(),
    taskType: taskType('task_type').notNull(),
    period: text('period').notNull(), // 'once' | 'monthly' | 'quarterly' | 'annual'
    periodLabel: text('period_label'), // 'Q1', 'January', etc.
    dueDateRule: text('due_date_rule'),
    countsTowardRequirement: boolean('counts_toward_requirement').notNull().default(true),
    knowledgeCenterUrl: text('knowledge_center_url'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    initiativeTrackStageIdx: index('task_templates_itsx_idx').on(t.initiativeId, t.track, t.stageId),
  }),
);

export const taskInstances = pgTable(
  'task_instances',
  {
    id: idCol(),
    enrollmentId: text('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    programYearId: text('program_year_id')
      .notNull()
      .references(() => programYears.id, { onDelete: 'cascade' }),
    taskTemplateId: text('task_template_id')
      .notNull()
      .references(() => taskTemplates.id),
    period: text('period').notNull(), // concrete period like "2026-Q1", "2026-03"
    dueOn: date('due_on'),
    status: taskStatus('status').notNull().default('not_started'),
    // Qualifies the completion. NULL = unspecified (legacy / backwards-compatible);
    // when set, drives compliance counting (on_time/attended = compliant; late/missed = documented but not counted).
    outcome: taskOutcome('outcome'),
    completedOn: date('completed_on'),
    staffNote: text('staff_note'),
    attachmentUrl: text('attachment_url'),
    payload: jsonb('payload'), // type-specific data (attendees, advising notes, HRA responses, etc.)
    updatedBy: text('updated_by'),
    // When set, the task is "finalized" (locked): the REDCap sync will not
    // recompute or overwrite it. Set per month via the sync's Finalize control.
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizedBy: text('finalized_by'),
    ...timestamps,
  },
  (t) => ({
    enrollmentIdx: index('task_instances_enrollment_idx').on(t.enrollmentId),
    programYearIdx: index('task_instances_program_year_idx').on(t.programYearId),
    statusIdx: index('task_instances_status_idx').on(t.status),
  }),
);

// ---------- Meetings ----------

export const meetings = pgTable(
  'meetings',
  {
    id: idCol(),
    title: text('title').notNull(),
    type: meetingType('type').notNull(),
    meetingDate: date('meeting_date').notNull(),
    cohortId: text('cohort_id').references(() => cohorts.id), // null for cross-initiative annual forum
    crossInitiative: boolean('cross_initiative').notNull().default(false),
    locationOrZoomUrl: text('location_or_zoom_url'),
    countsAsMeetings: integer('counts_as_meetings').notNull().default(1),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    cohortIdx: index('meetings_cohort_idx').on(t.cohortId),
    dateIdx: index('meetings_date_idx').on(t.meetingDate),
  }),
);

export const meetingAttendance = pgTable(
  'meeting_attendance',
  {
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    hospitalId: text('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    attended: boolean('attended').notNull().default(false),
    attendees: jsonb('attendees'), // array of { name, email, role }
    markedBy: text('marked_by'),
    markedAt: timestamp('marked_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    pk: primaryKey({ columns: [t.meetingId, t.hospitalId] }),
    hospitalIdx: index('meeting_attendance_hospital_idx').on(t.hospitalId),
  }),
);

// ---------- People ----------

export const users = pgTable(
  'users',
  {
    id: idCol(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    role: userRole('role').notNull(),
    hospitalId: text('hospital_id').references(() => hospitals.id),
    totpSecret: text('totp_secret'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(sql`lower(${t.email})`),
    hospitalIdx: index('users_hospital_idx').on(t.hospitalId),
  }),
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: idCol(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    userIdx: index('refresh_tokens_user_idx').on(t.userId),
    tokenHashIdx: uniqueIndex('refresh_tokens_hash_idx').on(t.tokenHash),
  }),
);

export const passwordResets = pgTable('password_resets', {
  id: idCol(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  ...timestamps,
});

/**
 * CPCQC staff are tagged with the initiative(s) they manage and in what role
 * (Program Manager, QI Advisor, or both via two rows). Used to surface
 * "Your CPCQC contacts" on the hospital portal and to scope the staff
 * dashboard's per-initiative views. All cpcqc_staff users still have
 * cross-initiative read access at the role level; assignments here are about
 * "who's the point person" rather than permissions.
 */
export const staffInitiativeAssignments = pgTable(
  'staff_initiative_assignments',
  {
    id: idCol(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    initiativeId: text('initiative_id')
      .notNull()
      .references(() => initiatives.id, { onDelete: 'cascade' }),
    staffRole: staffRoleKind('staff_role').notNull(),
    ...timestamps,
  },
  (t) => ({
    uniqueAssignment: uniqueIndex('staff_initiative_assignments_unique').on(
      t.userId,
      t.initiativeId,
      t.staffRole,
    ),
    initiativeIdx: index('staff_initiative_assignments_initiative_idx').on(t.initiativeId),
    userIdx: index('staff_initiative_assignments_user_idx').on(t.userId),
  }),
);

/** Clinical leads, QI champions per hospital per initiative (non-user roster). */
export const hospitalStaffMembers = pgTable(
  'hospital_staff_members',
  {
    id: idCol(),
    hospitalId: text('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    initiativeId: text('initiative_id').references(() => initiatives.id),
    name: text('name').notNull(),
    role: text('role'),
    email: text('email'),
    phone: text('phone'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => ({
    hospitalIdx: index('hospital_staff_hospital_idx').on(t.hospitalId),
  }),
);

// ---------- Pre-enrollment intake ----------

export const interestForms = pgTable(
  'interest_forms',
  {
    id: idCol(),
    initiativeId: text('initiative_id')
      .notNull()
      .references(() => initiatives.id),
    hospitalId: text('hospital_id').references(() => hospitals.id), // matched later
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    role: text('role').notNull(),
    facilityName: text('facility_name').notNull(),
    status: interestFormStatus('status').notNull().default('submitted'),
    staffNotes: text('staff_notes'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => ({
    statusIdx: index('interest_forms_status_idx').on(t.status),
    initiativeIdx: index('interest_forms_initiative_idx').on(t.initiativeId),
  }),
);

// ---------- Ops ----------

export const notifications = pgTable(
  'notifications',
  {
    id: idCol(),
    userId: text('user_id').references(() => users.id),
    toEmail: text('to_email').notNull(),
    kind: text('kind').notNull(), // 'invite' | 'password_reset' | 'task_reminder' | 'digest' | ...
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    error: text('error'),
    relatedTaskId: text('related_task_id').references(() => taskInstances.id),
    ...timestamps,
  },
  (t) => ({
    sentIdx: index('notifications_sent_idx').on(t.sentAt),
  }),
);

// ---------- Continuing education (CE) certificates ----------

/**
 * A CE training/activity. Holds the certificate content that is identical for
 * every participant; the per-person part lives in `ceCertificates`.
 *
 * `programCode` is text, not a FK to `initiatives`, because the CE program list
 * is a branding list that evolves separately — IMPACT runs CE trainings but is
 * not a QI initiative here. Validated in code against CE_PROGRAMS.
 */
export const ceTrainings = pgTable(
  'ce_trainings',
  {
    id: idCol(),
    programCode: text('program_code').notNull(), // 'SPARK' | 'SOAR' | 'NEST' | 'TTT' | 'IMPACT'
    title: text('title').notNull(),
    trainingDate: date('training_date').notNull(),
    /** Nursing contact hours, e.g. 1.50. Drizzle returns numeric as string. */
    contactHours: numeric('contact_hours', { precision: 5, scale: 2 }).notNull(),
    /** Assigned by the accreditor (Colorado Nurses Association). */
    activityId: text('activity_id').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => ({
    dateIdx: index('ce_trainings_date_idx').on(t.trainingDate),
  }),
);

/**
 * One certificate per participant per training. Carries its own delivery state
 * so a 100-recipient send can partially fail and be retried per person, and so
 * a lost certificate can be re-sent years later (ANCC record retention).
 *
 * The PDF is NOT stored: it is deterministic from the training + recipient, so
 * it is regenerated on demand. That keeps the DB small and means a template fix
 * applies to reissues too.
 */
export const ceCertificates = pgTable(
  'ce_certificates',
  {
    id: idCol(),
    trainingId: text('training_id')
      .notNull()
      .references(() => ceTrainings.id, { onDelete: 'cascade' }),
    /** Human-readable audit handle printed on the PDF, e.g. CPCQC-2026-4F3A21. */
    certificateCode: text('certificate_code').notNull(),
    recipientName: text('recipient_name').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    /** When this person completed it. NULL = use the training's own date, which
     *  is right for live sessions; asynchronous courses differ per participant. */
    completionDate: date('completion_date'),
    /** Delivery state mirrors `notifications`: sentAt set = delivered to
     *  SendGrid; sendError set with no sentAt = failed; both null = not sent. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sendError: text('send_error'),
    sendCount: integer('send_count').notNull().default(0),
    lastSentBy: text('last_sent_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => ({
    codeIdx: uniqueIndex('ce_certificates_code_idx').on(t.certificateCode),
    trainingIdx: index('ce_certificates_training_idx').on(t.trainingId),
    sentIdx: index('ce_certificates_sent_idx').on(t.sentAt),
  }),
);

/**
 * Logos uploaded by staff for CE certificates, keyed by program code
 * (plus 'CPCQC' for the collaborative's own mark).
 *
 * Stored in the DB, not on disk: Render's filesystem is ephemeral, so an
 * uploaded file would vanish at the next deploy and quietly strip the branding
 * from every certificate issued after that. Files committed under
 * backend/assets/initiative-logos/ remain the fallback; a row here wins.
 */
export const ceProgramLogos = pgTable('ce_program_logos', {
  /** 'SPARK' | 'SOAR' | 'NEST' | 'TTT' | 'IMPACT' | 'CPCQC' */
  programCode: text('program_code').primaryKey(),
  /** image/png or image/jpeg — pdfkit cannot embed anything else. */
  mimeType: text('mime_type').notNull(),
  bytesBase64: text('bytes_base64').notNull(),
  byteSize: integer('byte_size').notNull(),
  originalFilename: text('original_filename'),
  uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

/**
 * Step 2 of annual enrollment — the legally mandated form.
 *
 * One row per (programYear, hospital, initiative): a hospital enrolling in two
 * initiatives files two forms. The champion roster lives per form rather than
 * per hospital because CPCQC confirmed champions often differ by initiative.
 *
 * Identity mirrors the public interest form — no account needed, confirmed by an
 * emailed token that is also the only way to edit. That matters more here than
 * on the interest form: this is the record that satisfies the statute, so a
 * silent overwrite by a stranger would be considerably worse.
 */
export const enrollmentForms = pgTable(
  'enrollment_forms',
  {
    id: idCol(),
    programYear: integer('program_year').notNull(),
    hospitalId: text('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    /** 'SPARK' | 'SOAR' | 'NEST' | 'TTT' */
    initiativeCode: text('initiative_code').notNull(),
    ehr: text('ehr'),
    ehrOther: text('ehr_other'),
    /** [{ role, name, email, title, isPrimary, redcapAccess, dashboardAccess }] —
     *  always read and written whole, never queried across hospitals. */
    champions: jsonb('champions'),
    /** TtT continues a two-year cohort: those hospitals attest instead of
     *  enrolling, so no roster is collected and this is the submission. */
    tttContinuationAttested: boolean('ttt_continuation_attested').notNull().default(false),
    submitterName: text('submitter_name').notNull(),
    submitterRole: text('submitter_role').notNull(),
    submitterEmail: text('submitter_email').notNull(),
    submitterUserId: text('submitter_user_id').references(() => users.id, { onDelete: 'set null' }),
    verificationTokenHash: text('verification_token_hash'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** 'portal' | 'public' — shown in staff triage. */
    submittedVia: text('submitted_via').notNull().default('public'),
    ...timestamps,
  },
  (t) => ({
    uniqYearHospitalInitiative: uniqueIndex('enrollment_forms_year_hospital_initiative_uniq').on(
      t.programYear,
      t.hospitalId,
      t.initiativeCode,
    ),
    yearIdx: index('enrollment_forms_year_idx').on(t.programYear),
    verificationIdx: index('enrollment_forms_verification_idx').on(t.verificationTokenHash),
  }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: idCol(),
    actorUserId: text('actor_user_id').references(() => users.id),
    actorRole: text('actor_role'),
    action: text('action').notNull(), // 'task.update', 'enrollment.create', etc.
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    diff: jsonb('diff'),
    note: text('note'),
    ...timestamps,
  },
  (t) => ({
    entityIdx: index('audit_log_entity_idx').on(t.entityType, t.entityId),
    actorIdx: index('audit_log_actor_idx').on(t.actorUserId),
    createdIdx: index('audit_log_created_idx').on(t.createdAt),
  }),
);

/** Snapshots of program-year compliance for historical reporting. */
export const complianceSnapshots = pgTable(
  'compliance_snapshots',
  {
    id: idCol(),
    programYearId: text('program_year_id')
      .notNull()
      .references(() => programYears.id, { onDelete: 'cascade' }),
    snapshotDate: date('snapshot_date').notNull(),
    summary: jsonb('summary').notNull(), // { meetings: { count: x, required: y, status: 'on_track' }, ... }
    ...timestamps,
  },
  (t) => ({
    uniqueSnapshot: uniqueIndex('compliance_snapshots_unique').on(t.programYearId, t.snapshotDate),
  }),
);

// ---------- Issue reports ----------

export const issueReportStatus = pgEnum('issue_report_status', [
  'open',
  'in_progress',
  'resolved',
]);

export const issueReportCategory = pgEnum('issue_report_category', [
  'bug',
  'data_correction',
  'feature_request',
  'other',
]);

/**
 * Hospital users and CPCQC staff submit issue reports via a modal in the
 * dashboard header. Reports get emailed to qi@cpcqc.org and tracked here for
 * triage on the staff /staff/issue-reports page. Reporter identity is
 * captured by snapshotting the user's email/role at submission time, so a
 * later user deletion doesn't orphan the report's attribution.
 */
export const issueReports = pgTable(
  'issue_reports',
  {
    id: idCol(),
    reporterUserId: text('reporter_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reporterEmail: text('reporter_email').notNull(),
    reporterRole: text('reporter_role').notNull(),
    reporterHospitalId: text('reporter_hospital_id').references(
      () => hospitals.id,
      { onDelete: 'set null' },
    ),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    category: issueReportCategory('category').notNull().default('other'),
    status: issueReportStatus('status').notNull().default('open'),
    resolutionNote: text('resolution_note'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => ({
    statusIdx: index('issue_reports_status_idx').on(t.status),
    createdIdx: index('issue_reports_created_idx').on(t.createdAt),
  }),
);

// ---------- Annual interest forms (2-step enrollment, step 1) ----------

/**
 * Per-program-year config row for the annual interest form acceptance
 * window. One row per year; staff can edit dates in the future via a
 * config UI (or psql for now). Used by:
 *   - Hospital portal banner ("2027 enrollment is open / closes in N days")
 *   - The interest form itself (the "accepted from X to Y" line)
 *   - Backend validation that submissions only land during the window
 */
export const enrollmentWindows = pgTable(
  'enrollment_windows',
  {
    id: idCol(),
    programYear: integer('program_year').notNull().unique(),
    opensAt: date('opens_at').notNull(),
    closesAt: date('closes_at').notNull(),
    /** Step 2 dates, distinct from the interest window above. NULL = the
     *  enrollment step isn't open for that year. */
    enrollmentOpensAt: date('enrollment_opens_at'),
    enrollmentClosesAt: date('enrollment_closes_at'),
    ...timestamps,
  },
  (t) => ({
    programYearIdx: index('enrollment_windows_program_year_idx').on(t.programYear),
  }),
);

/**
 * Step 1 of the annual enrollment flow. One row per (programYear, hospital);
 * a hospital can edit/re-submit within the window and the row is updated in
 * place rather than duplicated. Static initiative ranking + reasoning is
 * captured as JSONB so the schema doesn't need to change when CPCQC adds or
 * removes initiatives from the ranking pool in future years (e.g., TTT
 * coming back when it's not in a 2-year cohort).
 */
export const annualInterestForms = pgTable(
  'annual_interest_forms',
  {
    id: idCol(),
    programYear: integer('program_year').notNull(),
    hospitalId: text('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    // Submitter snapshot — captured at submit time so historical records
    // survive a user delete or a role change. submitterUserId is nullable
    // for that reason.
    submitterUserId: text('submitter_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    submitterName: text('submitter_name').notNull(),
    submitterRole: text('submitter_role').notNull(),
    submitterEmail: text('submitter_email').notNull(),
    // 0 valid for TTT-continuation hospitals submitting "no additional
    // initiatives requested." Capped at the program year's max in the
    // service layer (currently 2 for 2027).
    intendedInitiativeCount: integer('intended_initiative_count').notNull(),
    // [{ code: 'SPARK', rank: 1 }, { code: 'SOAR', rank: 2 }, ...] —
    // length matches the rankable pool for the year (3 for 2027).
    rankedInitiatives: jsonb('ranked_initiatives').notNull(),
    // { SPARK: 'why...', SOAR: 'why...' } — keys are the codes ranked 1 and 2.
    reasoning: jsonb('reasoning').notNull(),
    status: annualInterestFormStatus('status').notNull().default('submitted'),
    /**
     * Public submission identity. A portal submission is provably that hospital
     * (it came from their login); a public one is only as good as the verified
     * email behind it. The token is the ONLY way to edit a public submission
     * later — without that, the unique (year, hospital) index would let any
     * stranger silently overwrite a hospital's real entry.
     */
    verificationTokenHash: text('verification_token_hash'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** 'portal' | 'public' — shown in staff triage. */
    submittedVia: text('submitted_via').notNull().default('portal'),
    // PM scratchpad — same pattern as task_instances.staff_note. Free text
    // visible only to staff. Cleared on resubmission preserves history? No
    // — preserved across resubmits since PM commentary is about the hospital,
    // not the specific submission.
    staffNote: text('staff_note'),
    // Once CPCQC decides, the codes of the cohorts the hospital was
    // accepted to (e.g., ['SPARK', 'NEST']). Null until a decision is made;
    // [] means reviewed and accepted for nothing. This is the single source of
    // truth for "who gets which enrollment form" — read by the staff
    // acceptance checkboxes, bulk-accept, the XLSX export, the acceptance
    // email and the hospital's own portal view.
    decidedInitiatives: jsonb('decided_initiatives'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => ({
    // One submission per hospital per year. Resubmits UPDATE this row.
    uniqHospitalYear: uniqueIndex('annual_interest_forms_hospital_year_uniq').on(
      t.programYear,
      t.hospitalId,
    ),
    programYearIdx: index('annual_interest_forms_program_year_idx').on(t.programYear),
    statusIdx: index('annual_interest_forms_status_idx').on(t.status),
  }),
);

// ---------- Multi-hospital access (regional staff) ----------

/**
 * Additional hospitals a user can access beyond their primary
 * users.hospital_id. Regional staff (e.g. a UCHealth QI lead covering several
 * UCHealth sites) get one login that can switch between all their hospitals.
 *
 * A user's full accessible set = {users.hospital_id} ∪ {user_hospitals rows}.
 * The primary stays on users.hospital_id for back-compat (single-hospital
 * users need no rows here).
 */
export const userHospitals = pgTable(
  'user_hospitals',
  {
    id: idCol(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    hospitalId: text('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => ({
    uniqUserHospital: uniqueIndex('user_hospitals_user_hospital_uniq').on(
      t.userId,
      t.hospitalId,
    ),
    userIdx: index('user_hospitals_user_idx').on(t.userId),
  }),
);
