/**
 * TypeScript shapes mirroring the backend's JSON responses.
 * Keep these in sync with src/modules/*.ts on the backend.
 */

export type UserRole = 'hospital_user' | 'hospital_admin' | 'cpcqc_staff' | 'cpcqc_admin';

export interface AuthUser {
  userId: string;
  role: UserRole;
  hospitalId: string | null;
}

export interface LoginResponse {
  accessToken: string;
  user: AuthUser;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: UserRole;
    hospitalId: string | null;
  };
  hospital: { id: string; name: string; region: string | null } | null;
  // Full accessible-hospital set (primary + regional grants). One entry for
  // single-hospital users; multiple for regional staff → drives the switcher.
  hospitals: Array<{ id: string; name: string }>;
}

// ---------- Staff: multi-hospital access management ----------

export interface StaffUserListItem {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  // Champion roster title(s), matched by email — may span initiatives.
  championRoles: string[];
  primaryHospital: { id: string; name: string } | null;
  additionalCount: number;
}

export interface RosterRoleEntry {
  id: string;
  role: string | null;
  initiativeCode: string | null;
  initiativeName: string | null;
}

export interface UserHospitalsResponse {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: UserRole;
  };
  phone: string | null;
  rosterEntries: RosterRoleEntry[];
  primaryHospital: { id: string; name: string } | null;
  additionalHospitals: Array<{ id: string; name: string }>;
}

export interface MyRosterMember {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  initiative: { code: string; name: string } | null;
}

export interface CreateChampionResponse {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: UserRole;
    hospital: { id: string; name: string };
    initiative: { code: string; name: string };
  };
  // True when the welcome email went out. When false (dev / delivery failure),
  // tempPassword is returned so the PM can relay it manually.
  emailed: boolean;
  loginUrl: string;
  tempPassword: string | null;
}

// ---------- SPARK REDCap sync (staff imports) ----------

export type SparkSyncCategory =
  | 'counting'
  | 'complete_late'
  | 'complete_nodate'
  | 'incomplete'
  | 'not_submitted'
  | 'pending';

export type SyncTaskStatus = 'not_started' | 'current_activities' | 'complete' | 'needs_revision';
export type SyncTaskOutcome = 'on_time' | 'late' | 'attended' | 'missed' | 'not_submitted' | null;

export type SyncDisposition = 'counts' | 'late' | 'incomplete' | 'not_submitted' | 'pending';

export interface SparkSyncRow {
  taskId: string;
  overridden: boolean;
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  finalized: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  dagCode: string;
  hospitalId: string | null;
  hospitalName: string;
  quarter: string;
  category: SparkSyncCategory;
  submitted: boolean;
  complete: boolean;
  pctComplete: number | null;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  submissionDate: string | null;
  missingTotal: number;
  missingSummary: string | null;
  duplicateRecords: boolean;
  primaryRecordId: string | null;
  currentStatus: SyncTaskStatus;
  currentOutcome: SyncTaskOutcome;
  newStatus: SyncTaskStatus;
  newOutcome: SyncTaskOutcome;
  willChange: boolean;
  note: string;
}

export interface SparkSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  quartersInScope: string[];
  recordsFetched: number;
  rows: SparkSyncRow[];
  warnings: string[];
  counts: {
    willChange: number;
    counting: number;
    completeLate: number;
    incomplete: number;
    notSubmitted: number;
    pending: number;
    duplicates: number;
    unchanged: number;
  };
}

export interface ChampionContact {
  hospital: string;
  region: string | null;
  initiativeCode: string | null;
  initiativeName: string | null;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

export interface ChampionContactsResponse {
  initiative: 'TTT' | 'SPARK' | 'SOAR' | 'NEST' | null;
  contacts: ChampionContact[];
}

export type NestSyncCategory =
  | 'counting'
  | 'complete_late'
  | 'complete_nodate'
  | 'incomplete'
  | 'not_submitted'
  | 'pending';

export interface NestSyncRow {
  taskId: string;
  overridden: boolean;
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  finalized: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  dagCode: string;
  hospitalId: string | null;
  hospitalName: string;
  period: string;
  category: NestSyncCategory;
  sspSubmitted: boolean;
  chartSubmitted: boolean;
  bothSubmitted: boolean;
  dataComplete: boolean;
  sspRows: number;
  sspComplete: number;
  chartRows: number;
  chartComplete: number;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  submissionDate: string | null;
  /** Incomplete rows grouped by REDCap record — which record is missing what.
   *  Empty unless the row is incomplete. */
  incompleteRecords: Array<{
    recordId: string;
    form: string;
    fields: Array<{ field: string; label: string }>;
  }>;
  currentStatus: SyncTaskStatus;
  currentOutcome: SyncTaskOutcome;
  newStatus: SyncTaskStatus;
  newOutcome: SyncTaskOutcome;
  willChange: boolean;
  note: string;
}

export interface NestSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  periodsInScope: string[];
  recordsFetched: number;
  rows: NestSyncRow[];
  warnings: string[];
  counts: {
    willChange: number;
    counting: number;
    completeLate: number;
    incomplete: number;
    notSubmitted: number;
    pending: number;
    unchanged: number;
  };
}

export type SoarSyncCategory =
  | 'counting'
  | 'complete_late'
  | 'complete_nodate'
  | 'incomplete'
  | 'not_submitted'
  | 'pending';

export interface SoarSyncRow {
  taskId: string;
  overridden: boolean;
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  finalized: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  dagCode: string;
  hospitalId: string | null;
  hospitalName: string;
  period: string;
  category: SoarSyncCategory;
  ntsvSubmitted: boolean;
  noNtsvSubmitted: boolean;
  attestationOnly: boolean;
  dataComplete: boolean;
  ntsvRows: number;
  ntsvComplete: number;
  noNtsvRows: number;
  onTime: boolean | null;
  daysFromDeadline: number | null;
  submissionDate: string | null;
  /** Incomplete rows grouped by REDCap record — which record is missing what.
   *  Empty unless the row is incomplete. */
  incompleteRecords: Array<{
    recordId: string;
    form: string;
    fields: Array<{ field: string; label: string }>;
  }>;
  currentStatus: SyncTaskStatus;
  currentOutcome: SyncTaskOutcome;
  newStatus: SyncTaskStatus;
  newOutcome: SyncTaskOutcome;
  willChange: boolean;
  note: string;
}

export interface SoarSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  periodsInScope: string[];
  recordsFetched: number;
  rows: SoarSyncRow[];
  warnings: string[];
  notes: string[];
  counts: {
    willChange: number;
    counting: number;
    completeLate: number;
    incomplete: number;
    notSubmitted: number;
    pending: number;
    unchanged: number;
  };
}

// ---- TtT (Turning the Tide) — two projects, cross-linked on CHA_ID ----

export type TttSyncCategory =
  | 'pre_criteria'
  | 'counting'
  | 'below_ideal'
  | 'complete_late'
  | 'complete_nodate'
  | 'incomplete'
  | 'not_submitted'
  | 'pending';

export interface TttSyncRow {
  taskId: string;
  overridden: boolean;
  priorOverride: { disposition: SyncDisposition; comment: string } | null;
  finalized: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  chaId: number;
  hospitalId: string | null;
  hospitalName: string;
  period: string;
  category: TttSyncCategory;
  submitted: boolean;
  reportComplete: boolean;
  missingFields: string[];
  positiveScreens: number;
  patientForms: number;
  shortfall: number;
  linkageFloor: boolean;
  linkageIdeal: boolean;
  onTime: boolean | null;
  submissionDate: string | null;
  deadline: string;
  currentStatus: SyncTaskStatus;
  currentOutcome: SyncTaskOutcome;
  newStatus: SyncTaskStatus;
  newOutcome: SyncTaskOutcome;
  willChange: boolean;
  note: string;
}

export interface TttSyncResult {
  dryRun: boolean;
  fetchedAt: string;
  programYear: number;
  eligibilityMode: 'explicit' | 'derived' | 'either';
  periodsInScope: string[];
  hospitalRecords: number;
  patientRecords: number;
  requiredFieldCount: number;
  rows: TttSyncRow[];
  warnings: string[];
  notes: string[];
  counts: {
    willChange: number;
    preCriteria: number;
    counting: number;
    belowIdeal: number;
    completeLate: number;
    incomplete: number;
    notSubmitted: number;
    pending: number;
    unchanged: number;
    linkageGaps: number;
  };
}

export type RequirementStatus = 'on_track' | 'at_risk' | 'met' | 'not_met';

// ---- System rollup (health-system QI lead: all linked hospitals × initiatives) ----

export interface RollupFailingRequirement {
  requirement: string;
  status: RequirementStatus;
  current: number;
  required: number;
}

export interface RollupCell {
  hospitalId: string;
  hospitalName: string;
  initiativeId: string;
  initiativeCode: string;
  initiativeName: string;
  enrollmentId: string;
  enrollmentStatus: string;
  track: 'active' | 'sustainability';
  programYear: number | null;
  overall: RequirementStatus | null;
  requirements: Record<string, RequirementStatus> | null;
  failing: RollupFailingRequirement[];
}

export interface RollupNeedsAttention {
  hospitalId: string;
  hospitalName: string;
  initiativeCode: string;
  enrollmentId: string;
  track: 'active' | 'sustainability';
  overall: RequirementStatus | null;
  failing: RollupFailingRequirement[];
}

export interface SystemRollupResponse {
  hospitals: Array<{ id: string; name: string }>;
  initiatives: Array<{ id: string; code: string; name: string }>;
  cells: RollupCell[];
  needsAttention: RollupNeedsAttention[];
  totals: {
    hospitals: number;
    enrollments: number;
    met: number;
    onTrack: number;
    atRisk: number;
    notMet: number;
  };
}

export interface RequirementResult {
  status: RequirementStatus;
  current: number;
  required: number;
  expected: number;
  reason?: string;
}

export interface ProgramYearCompliance {
  enrollment: RequirementResult;
  meetings: RequirementResult;
  advising: RequirementResult;
  dataSubmissions: RequirementResult;
  assessments?: RequirementResult;
  overall: RequirementStatus;
}

export interface ComplianceForProgramYear {
  programYearId: string;
  programYear: number;
  enrollmentId: string;
  cohortLabel: string;
  initiativeCode: string;
  track: 'active' | 'sustainability';
  thresholds: {
    requiredMeetings: number;
    requiredAdvising: number;
    requiredDataPeriods: number;
    dataSubmissionsMin: number;
    requiredAssessments: number;
  };
  progress: {
    meetingsAttended: number;
    advisingCompleted: number;
    dataSubmissionsCompleted: number;
    assessmentsCompleted: number;
    enrollmentStatus: string;
  };
  result: ProgramYearCompliance;
}

export interface RequirementBenchmark {
  peerMedian: number;
  peerP25: number;
  peerP75: number;
  peersMet: number;
  peersTotal: number;
  myPercentile: number;
}

export interface CohortBenchmark {
  cohortId: string;
  cohortLabel: string;
  peersTotal: number;
  meetings: RequirementBenchmark;
  advising: RequirementBenchmark;
  dataSubmissions: RequirementBenchmark;
  assessments: RequirementBenchmark | null;
}

export interface InitiativeTeamMember {
  userId: string;
  fullName: string;
  email: string;
  staffRole: 'program_manager' | 'qi_advisor';
}

export interface InitiativeTeam {
  initiativeId: string;
  initiativeCode: string;
  programManagers: InitiativeTeamMember[];
  qiAdvisors: InitiativeTeamMember[];
}

export interface MyEnrollment {
  enrollmentId: string;
  status: string;
  enrolledOn: string;
  cohort: {
    id: string;
    label: string;
    track: 'active' | 'sustainability';
    startDate: string;
    endDate: string;
  } | null;
  initiative: {
    id: string;
    code: string;
    name: string;
    brandColor: string | null;
    emoji: string | null;
  } | null;
  currentStage: {
    id: string;
    code: string;
    name: string;
    sequence: number;
  } | null;
  currentProgramYear: ComplianceForProgramYear | null;
  allProgramYears: ComplianceForProgramYear[];
  cohortBenchmark: CohortBenchmark | null;
  team: InitiativeTeam | null;
}

export type TaskType =
  | 'enrollment_form'
  | 'meeting_attendance'
  | 'qi_advising'
  | 'data_submission'
  | 'readiness_assessment'
  | 'other';

export type TaskStatus = 'not_started' | 'current_activities' | 'complete' | 'needs_revision';

/**
 * Qualifies a 'complete' status. NULL = unspecified (counts as compliant
 * for back-compat). 'on_time' / 'attended' = compliant. 'late' / 'missed' /
 * 'not_submitted' = documented but do NOT count toward thresholds.
 */
export type TaskOutcome =
  | 'on_time'
  | 'late'
  | 'attended'
  | 'missed'
  | 'not_submitted'
  | null;

export interface TaskRow {
  id: string;
  enrollmentId: string;
  programYear: number;
  stage: { id: string; code: string; name: string; sequence: number };
  template: {
    id: string;
    name: string;
    taskType: TaskType;
    period: string;
    periodLabel: string | null;
    knowledgeCenterUrl: string | null;
    countsTowardRequirement: boolean;
  };
  period: string;
  dueOn: string | null;
  status: TaskStatus;
  outcome: TaskOutcome;
  completedOn: string | null;
  staffNote: string | null;
  attachmentUrl: string | null;
  payload: Record<string, unknown> | null;
  updatedAt: string;
}

// ---------- Staff dashboard ----------

export interface StaffOverviewInitiative {
  initiativeId: string;
  code: string;
  name: string;
  enrolled: number;
  met: number;
  onTrack: number;
  atRisk: number;
  notMet: number;
}

export interface NeedsAttentionRow {
  hospitalId: string;
  hospitalName: string;
  initiativeId: string;
  initiativeCode: string;
  enrollmentId: string;
  enrollmentStatus: string;
  track: 'active' | 'sustainability';
  compliance: ComplianceForProgramYear | null;
}

// LEGACY: the per-initiative interest_forms table is decommissioned, but the
// /staff/overview endpoint still selects from it (returning [] always). Kept
// the type so the response shape doesn't break existing callers. Remove with
// the next pass that touches the overview page.
export interface PendingInterestForm {
  id: string;
  initiativeId: string;
  hospitalId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  facilityName: string;
  status: 'submitted' | 'reviewed' | 'approved' | 'declined';
  staffNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffOverviewResponse {
  initiatives: StaffOverviewInitiative[];
  needsAttention: NeedsAttentionRow[];
  pendingInterestForms: PendingInterestForm[];
  totals: {
    hospitalsEnrolled: number;
    totalEnrollments: number;
    pendingInterestForms: number;
  };
}

export interface HospitalSummary {
  id: string;
  name: string;
  region: string | null;
  defaultContactName: string | null;
  defaultContactEmail: string | null;
}

export interface InitiativeHospitalsResponse {
  initiative: {
    id: string;
    code: string;
    name: string;
    brandColor: string | null;
    emoji: string | null;
  };
  hospitals: Array<{
    hospital: HospitalSummary;
    enrollmentId: string;
    enrollmentStatus: string;
    cohort: { id: string; label: string; track: 'active' | 'sustainability' } | null;
    currentStage: { id: string; code: string; name: string; sequence: number } | null;
    compliance: ComplianceForProgramYear | null;
  }>;
}

export interface HospitalStaffMember {
  id: string;
  hospitalId: string;
  initiativeId: string | null;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string;
  diff: unknown;
  note: string | null;
  createdAt: string;
}

export interface HospitalDetailEnrollment {
  enrollmentId: string;
  status: string;
  enrolledOn: string;
  withdrawnOn: string | null;
  cohort: {
    id: string;
    label: string;
    track: 'active' | 'sustainability';
    startDate: string;
    endDate: string;
  } | null;
  initiative: {
    id: string;
    code: string;
    name: string;
    brandColor: string | null;
    emoji: string | null;
  } | null;
  currentStage: { id: string; code: string; name: string; sequence: number } | null;
  programYears: ComplianceForProgramYear[];
}

export interface HospitalDetailResponse {
  hospital: {
    id: string;
    name: string;
    cmsId: string | null;
    npi: string | null;
    region: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    defaultContactName: string | null;
    defaultContactEmail: string | null;
    inGoodStanding: boolean;
    notes: string | null;
  };
  enrollments: HospitalDetailEnrollment[];
  staffMembers: HospitalStaffMember[];
  recentAudit: AuditEntry[];
}

// ---------- /me/tasks ----------

export interface MyTasksResponse {
  tasks: Array<{
    id: string;
    enrollmentId: string;
    programYear: number;
    initiative: { code: string; name: string };
    stage: { code: string; name: string };
    template: {
      name: string;
      taskType: TaskType;
      knowledgeCenterUrl: string | null;
    };
    period: string;
    dueOn: string | null;
    status: TaskStatus;
    outcome: TaskOutcome;
    completedOn: string | null;
  }>;
}

// ---------- Annual interest forms (step 1 of 2-step enrollment) ----------

export type RankableInitiativeCode = 'SPARK' | 'SOAR' | 'NEST';

export interface EnrollmentWindow {
  programYear: number;
  opensAt: string; // YYYY-MM-DD
  closesAt: string; // YYYY-MM-DD
}

export interface EnrollmentWindowResponse {
  window: EnrollmentWindow;
  isOpen: boolean;
  // 'before' = window hasn't opened yet; 'open' = within [opens, closes];
  // 'after' = past closes_at. Drives the copy on the form + banner so
  // pre-window state reads as "opens on…" rather than "closed on…".
  windowState: 'before' | 'open' | 'after';
  rankableInitiativeCodes: RankableInitiativeCode[];
}

export interface AnnualInterestForm {
  id: string;
  programYear: number;
  hospital: { id: string; name: string };
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  intendedInitiativeCount: number;
  rankedInitiatives: Array<{ code: RankableInitiativeCode; rank: number }>;
  reasoning: Record<string, string>;
  status: 'submitted' | 'under_review' | 'accepted' | 'declined';
  staffNote: string | null;
  decidedInitiatives: RankableInitiativeCode[] | null;
  decidedAt: string | null;
  decidedBy: string | null;
  /** 'portal' = submitted from that hospital's login; 'public' = accountless. */
  submittedVia: 'portal' | 'public';
  verifiedAt: string | null;
  flags: {
    currentlyEnrolledInTTT: boolean;
    currentlyInSoarSustainability: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CohortPlanningAggregate {
  programYear: number;
  totalSubmissions: number;
  // Cohort context — independent of submissions. Drives the "even if
  // nobody's submitted yet, here's what you're walking into" tiles.
  cohortContext: {
    tttContinuationCount: number;
    soarSustainabilityCount: number;
  };
  // Submission-funnel metrics — labeled in the UI as "of submissions so far".
  intent: { 0: number; 1: number; 2: number };
  perInitiative: Array<{
    code: RankableInitiativeCode;
    rankCounts: Record<1 | 2 | 3, number>;
    totalInterested: number;
  }>;
  currentlyTTTSubmissionCount: number;
}

// ---------- CE certificates ----------

export interface CeProgram {
  code: string;
  label: string;
  /** CPCQC-hosted training not tied to an initiative — no host logo expected. */
  generic?: boolean;
}

export interface CeProgramsResponse {
  programs: CeProgram[];
  /** Program codes with no logo yet — their certificates fall back to text. */
  missingLogos: string[];
  /** code -> whether a logo exists (uploaded or committed). Includes CPCQC. */
  logoAvailability: Record<string, boolean>;
  /** The code used for CPCQC's own mark, which appears on every certificate. */
  cpcqcLogoCode: string;
}

export interface CeTrainingSummary {
  id: string;
  programCode: string;
  programLabel: string;
  title: string;
  trainingDate: string;
  trainingDateDisplay: string;
  contactHours: string;
  activityId: string;
  createdAt: string;
  participants: number;
  sent: number;
  failed: number;
}

export interface CeCertificate {
  id: string;
  certificateCode: string;
  recipientName: string;
  recipientEmail: string;
  sentAt: string | null;
  sendError: string | null;
  sendCount: number;
}

export interface CeTrainingDetail {
  id: string;
  programCode: string;
  programLabel: string;
  title: string;
  trainingDate: string;
  trainingDateDisplay: string;
  contactHours: string;
  activityId: string;
  createdAt: string;
  logoMissing: boolean;
  certificates: CeCertificate[];
}

export interface CeRosterProblem {
  sourceRow: number;
  name: string;
  email: string;
  reason: string;
}

export interface CeRosterPreview {
  rows: Array<{ name: string; email: string; sourceRow: number }>;
  problems: CeRosterProblem[];
  detected: { nameColumns: string[]; emailColumn: string | null };
}

export interface CeRosterImportResult {
  added: number;
  alreadyPresent: number;
  total: number;
  problems: CeRosterProblem[];
  detected: { nameColumns: string[]; emailColumn: string | null };
}

export interface CeSendResult {
  attempted: number;
  sent: number;
  failed: number;
  failures: Array<{ recipientEmail: string; error: string }>;
}

export interface CeActivityRow {
  trainingId: string;
  programCode: string;
  programLabel: string;
  title: string;
  trainingDate: string;
  trainingDateDisplay: string;
  activityId: string;
  contactHours: number;
  rosterCount: number;
  certificatesIssued: number;
  contactHoursAwarded: number;
}

export interface CeReport {
  from: string;
  to: string;
  totals: {
    activities: number;
    activitiesWithIssuance: number;
    rosterTotal: number;
    certificatesIssued: number;
    contactHoursAwarded: number;
    uniqueParticipants: number;
  };
  byProgram: Array<{
    programCode: string;
    programLabel: string;
    activities: number;
    certificatesIssued: number;
    contactHoursAwarded: number;
  }>;
  activities: CeActivityRow[];
}

// ---------- Staff enrollment-forms view (step 2 of annual enrollment) ----------

export type EnrollableInitiativeCode = 'SPARK' | 'SOAR' | 'NEST' | 'TTT';

export interface EnrollmentChampion {
  role: 'nurse' | 'provider' | 'data' | 'csuite' | 'other';
  name: string;
  email: string;
  title: string;
  isPrimary: boolean;
  /** Requested by the hospital — CPCQC grants access separately. */
  redcapAccess: boolean;
  dashboardAccess: boolean;
}

export interface StaffEnrollmentForm {
  id: string;
  programYear: number;
  hospital: { id: string; name: string };
  initiativeCode: EnrollableInitiativeCode;
  submitterName: string;
  submitterRole: string;
  submitterEmail: string;
  ehr: string | null;
  ehrOther: string | null;
  champions: EnrollmentChampion[];
  tttContinuationAttested: boolean;
  submittedVia: 'portal' | 'public';
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnrollmentCoverage {
  initiativeCode: EnrollableInitiativeCode;
  expected: Array<{ id: string; name: string }>;
  submittedCount: number;
  outstanding: Array<{ id: string; name: string }>;
  unexpectedCount: number;
}

export interface StaffEnrollmentOverview {
  programYear: number;
  window: { opensAt: string | null; closesAt: string | null };
  forms: StaffEnrollmentForm[];
  coverage: EnrollmentCoverage[];
}
