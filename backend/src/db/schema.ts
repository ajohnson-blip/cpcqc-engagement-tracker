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

export const meetingType = pgEnum('meeting_type', ['monthly_cohort', 'annual_forum']);

export const interestFormStatus = pgEnum('interest_form_status', [
  'submitted',
  'reviewed',
  'approved',
  'declined',
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
    completedOn: date('completed_on'),
    staffNote: text('staff_note'),
    attachmentUrl: text('attachment_url'),
    payload: jsonb('payload'), // type-specific data (attendees, advising notes, HRA responses, etc.)
    updatedBy: text('updated_by'),
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
