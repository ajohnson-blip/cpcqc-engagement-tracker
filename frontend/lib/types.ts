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

export interface SparkSyncRow {
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

export type RequirementStatus = 'on_track' | 'at_risk' | 'met' | 'not_met';

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
