/**
 * Reports data-assembly service.
 *
 * Produces a structured AnnualReportData object for a given program year.
 * The XLSX and PDF generators consume the same data, so the formatting layer
 * stays decoupled from the data layer.
 *
 * "Generated date" reflects the moment the report was produced; the compliance
 * engine evaluates as of that moment, so requirement statuses are
 * point-in-time. For the legal end-of-year CDPHE report, this should be run
 * after Dec 31 so every requirement crystallizes to `met` or `not_met`.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { HttpError } from '@/middleware/errors.js';
import {
  evaluateEnrollment,
  type ComplianceForProgramYear,
} from '@/modules/compliance/compliance.repository.js';
import type { RequirementStatus } from '@/modules/compliance/compliance.service.js';

export interface ReportRequirement {
  current: number;
  required: number;
  status: RequirementStatus;
}

export interface ReportEnrollmentRow {
  enrollmentId: string;
  initiativeCode: string;
  initiativeName: string;
  track: 'active' | 'sustainability';
  cohortLabel: string;
  enrollmentStatus: string;
  enrolledOn: string;
  overall: RequirementStatus;
  requirements: {
    enrollment: ReportRequirement;
    meetings: ReportRequirement;
    advising: ReportRequirement;
    dataSubmissions: ReportRequirement;
    assessments: ReportRequirement | null;
  };
}

export interface ReportHospitalRow {
  hospitalId: string;
  chaHospitalId: string | null;
  cdpheId: string | null;
  aimId: string | null;
  name: string;
  cdpheName: string | null;
  system: string | null;
  county: string | null;
  city: string | null;
  enrollments: ReportEnrollmentRow[];
}

export interface ReportInitiativeSummary {
  code: string;
  name: string;
  emoji: string | null;
  totalEnrollments: number;
  met: number;
  onTrack: number;
  atRisk: number;
  notMet: number;
  /** Per-track breakdown for SOAR (where sustainability is meaningful) */
  active: { total: number; met: number; onTrack: number; atRisk: number; notMet: number };
  sustainability:
    | { total: number; met: number; onTrack: number; atRisk: number; notMet: number }
    | null;
}

export interface ReportTotals {
  hospitalsParticipating: number;
  totalEnrollments: number;
  metEnrollments: number;
  onTrackEnrollments: number;
  atRiskEnrollments: number;
  notMetEnrollments: number;
}

export interface AnnualReportData {
  programYear: number;
  generatedAt: Date;
  asOf: Date;
  hospitals: ReportHospitalRow[];
  initiatives: ReportInitiativeSummary[];
  totals: ReportTotals;
}

function reqFromCompliance(
  current: number,
  required: number,
  status: RequirementStatus,
): ReportRequirement {
  return { current, required, status };
}

function pickRow(c: ComplianceForProgramYear): ReportEnrollmentRow['requirements'] {
  return {
    enrollment: reqFromCompliance(
      c.result.enrollment.current,
      c.result.enrollment.required,
      c.result.enrollment.status,
    ),
    meetings: reqFromCompliance(
      c.result.meetings.current,
      c.result.meetings.required,
      c.result.meetings.status,
    ),
    advising: reqFromCompliance(
      c.result.advising.current,
      c.result.advising.required,
      c.result.advising.status,
    ),
    dataSubmissions: reqFromCompliance(
      c.result.dataSubmissions.current,
      c.result.dataSubmissions.required,
      c.result.dataSubmissions.status,
    ),
    assessments: c.result.assessments
      ? reqFromCompliance(
          c.result.assessments.current,
          c.result.assessments.required,
          c.result.assessments.status,
        )
      : null,
  };
}

/** Build the full annual-report data set for a given program year. */
export async function assembleAnnualReport(
  programYear: number,
  asOf: Date = new Date(),
): Promise<AnnualReportData> {
  // Load every active enrollment whose program year matches the request.
  // (An enrollment can span multiple years for TTT; we filter by ProgramYear.year.)
  const programYears = await db
    .select()
    .from(schema.programYears)
    .where(eq(schema.programYears.year, programYear));

  if (programYears.length === 0) {
    throw new HttpError(404, `No program year data found for ${programYear}.`);
  }

  const enrollmentIds = Array.from(new Set(programYears.map((py) => py.enrollmentId)));
  const enrollments = await db
    .select()
    .from(schema.enrollments)
    .where(inArray(schema.enrollments.id, enrollmentIds));

  const hospitalIds = Array.from(new Set(enrollments.map((e) => e.hospitalId)));
  const hospitals = await db
    .select()
    .from(schema.hospitals)
    .where(inArray(schema.hospitals.id, hospitalIds));
  const hospitalById = new Map(hospitals.map((h) => [h.id, h]));

  const cohortIds = Array.from(new Set(enrollments.map((e) => e.cohortId)));
  const cohorts = await db
    .select()
    .from(schema.cohorts)
    .where(inArray(schema.cohorts.id, cohortIds));
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));

  const initiativeIds = Array.from(new Set(cohorts.map((c) => c.initiativeId)));
  const initiatives = await db
    .select()
    .from(schema.initiatives)
    .where(inArray(schema.initiatives.id, initiativeIds));
  const initiativeById = new Map(initiatives.map((i) => [i.id, i]));

  // Evaluate every enrollment's compliance.
  const enrollmentRowsByHospital = new Map<string, ReportEnrollmentRow[]>();
  const initiativeCounts = new Map<string, ReportInitiativeSummary>();
  for (const ini of initiatives) {
    initiativeCounts.set(ini.id, {
      code: ini.code,
      name: ini.name,
      emoji: ini.emoji ?? null,
      totalEnrollments: 0,
      met: 0,
      onTrack: 0,
      atRisk: 0,
      notMet: 0,
      active: { total: 0, met: 0, onTrack: 0, atRisk: 0, notMet: 0 },
      sustainability: null,
    });
  }
  const totals: ReportTotals = {
    hospitalsParticipating: 0,
    totalEnrollments: 0,
    metEnrollments: 0,
    onTrackEnrollments: 0,
    atRiskEnrollments: 0,
    notMetEnrollments: 0,
  };

  for (const e of enrollments) {
    const cohort = cohortById.get(e.cohortId);
    const initiative = cohort ? initiativeById.get(cohort.initiativeId) : null;
    if (!cohort || !initiative) continue;
    const evaluations = await evaluateEnrollment(e.id, asOf);
    const py = evaluations.find((ev) => ev.programYear === programYear);
    if (!py) continue;

    const row: ReportEnrollmentRow = {
      enrollmentId: e.id,
      initiativeCode: initiative.code,
      initiativeName: initiative.name,
      track: cohort.track,
      cohortLabel: cohort.label,
      enrollmentStatus: e.status,
      enrolledOn: e.enrolledOn,
      overall: py.result.overall,
      requirements: pickRow(py),
    };
    const list = enrollmentRowsByHospital.get(e.hospitalId) ?? [];
    list.push(row);
    enrollmentRowsByHospital.set(e.hospitalId, list);

    // Tally
    const bucket = initiativeCounts.get(initiative.id)!;
    bucket.totalEnrollments += 1;
    totals.totalEnrollments += 1;
    if (py.result.overall === 'met') {
      bucket.met += 1;
      totals.metEnrollments += 1;
    } else if (py.result.overall === 'on_track') {
      bucket.onTrack += 1;
      totals.onTrackEnrollments += 1;
    } else if (py.result.overall === 'at_risk') {
      bucket.atRisk += 1;
      totals.atRiskEnrollments += 1;
    } else if (py.result.overall === 'not_met') {
      bucket.notMet += 1;
      totals.notMetEnrollments += 1;
    }
    if (cohort.track === 'active') {
      bucket.active.total += 1;
      if (py.result.overall === 'met') bucket.active.met += 1;
      else if (py.result.overall === 'on_track') bucket.active.onTrack += 1;
      else if (py.result.overall === 'at_risk') bucket.active.atRisk += 1;
      else if (py.result.overall === 'not_met') bucket.active.notMet += 1;
    } else {
      if (!bucket.sustainability) {
        bucket.sustainability = { total: 0, met: 0, onTrack: 0, atRisk: 0, notMet: 0 };
      }
      bucket.sustainability.total += 1;
      if (py.result.overall === 'met') bucket.sustainability.met += 1;
      else if (py.result.overall === 'on_track') bucket.sustainability.onTrack += 1;
      else if (py.result.overall === 'at_risk') bucket.sustainability.atRisk += 1;
      else if (py.result.overall === 'not_met') bucket.sustainability.notMet += 1;
    }
  }

  totals.hospitalsParticipating = enrollmentRowsByHospital.size;

  const hospitalRows: ReportHospitalRow[] = Array.from(enrollmentRowsByHospital.entries())
    .map(([hospitalId, rows]) => {
      const h = hospitalById.get(hospitalId);
      const meta = (h?.metadata as Record<string, unknown> | null) ?? {};
      return {
        hospitalId,
        chaHospitalId: h?.chaHospitalId ?? null,
        cdpheId: h?.cdpheId ?? null,
        aimId: h?.aimId ?? null,
        name: h?.name ?? '(unknown)',
        cdpheName: (meta['cdpheName'] as string | undefined) ?? null,
        system: h?.system ?? null,
        county: h?.county ?? null,
        city: h?.city ?? null,
        enrollments: rows.sort((a, b) => a.initiativeCode.localeCompare(b.initiativeCode)),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    programYear,
    generatedAt: new Date(),
    asOf,
    hospitals: hospitalRows,
    initiatives: Array.from(initiativeCounts.values()).sort((a, b) =>
      a.code.localeCompare(b.code),
    ),
    totals,
  };
}

/** Per-hospital scoped report — same data shape, just one hospital. */
export async function assembleHospitalReport(
  hospitalId: string,
  programYear: number,
  asOf: Date = new Date(),
): Promise<AnnualReportData> {
  const full = await assembleAnnualReport(programYear, asOf);
  const filtered = full.hospitals.filter((h) => h.hospitalId === hospitalId);
  if (filtered.length === 0) {
    throw new HttpError(404, 'Hospital has no enrollments for that program year.');
  }
  // Recompute totals + initiative buckets scoped to this hospital
  const totals: ReportTotals = {
    hospitalsParticipating: filtered.length,
    totalEnrollments: 0,
    metEnrollments: 0,
    onTrackEnrollments: 0,
    atRiskEnrollments: 0,
    notMetEnrollments: 0,
  };
  for (const h of filtered) {
    for (const e of h.enrollments) {
      totals.totalEnrollments += 1;
      if (e.overall === 'met') totals.metEnrollments += 1;
      else if (e.overall === 'on_track') totals.onTrackEnrollments += 1;
      else if (e.overall === 'at_risk') totals.atRiskEnrollments += 1;
      else if (e.overall === 'not_met') totals.notMetEnrollments += 1;
    }
  }
  return { ...full, hospitals: filtered, totals };
}

/** Per-initiative scoped report — full data shape, filtered to one initiative. */
export async function assembleInitiativeReport(
  initiativeCode: string,
  programYear: number,
  asOf: Date = new Date(),
): Promise<AnnualReportData> {
  const full = await assembleAnnualReport(programYear, asOf);
  const filteredHospitals = full.hospitals
    .map((h) => ({
      ...h,
      enrollments: h.enrollments.filter((e) => e.initiativeCode === initiativeCode),
    }))
    .filter((h) => h.enrollments.length > 0);
  const filteredInitiatives = full.initiatives.filter((i) => i.code === initiativeCode);
  if (filteredInitiatives.length === 0) {
    throw new HttpError(404, `No data for initiative "${initiativeCode}" in ${programYear}.`);
  }
  const totals: ReportTotals = {
    hospitalsParticipating: filteredHospitals.length,
    totalEnrollments: 0,
    metEnrollments: 0,
    onTrackEnrollments: 0,
    atRiskEnrollments: 0,
    notMetEnrollments: 0,
  };
  for (const h of filteredHospitals) {
    for (const e of h.enrollments) {
      totals.totalEnrollments += 1;
      if (e.overall === 'met') totals.metEnrollments += 1;
      else if (e.overall === 'on_track') totals.onTrackEnrollments += 1;
      else if (e.overall === 'at_risk') totals.atRiskEnrollments += 1;
      else if (e.overall === 'not_met') totals.notMetEnrollments += 1;
    }
  }
  return {
    ...full,
    hospitals: filteredHospitals,
    initiatives: filteredInitiatives,
    totals,
  };
}
