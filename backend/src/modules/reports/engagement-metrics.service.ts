/**
 * Database side of the five funder-facing engagement metrics. The shapes,
 * arithmetic and narrative wording live in engagement-metrics.ts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import {
  EMPTY_TALLY,
  toMetrics,
  type EngagementScope,
  type EngagementSummary,
  type StatutoryCompliance,
  type Tally,
} from './engagement-metrics.js';
import { assembleAnnualReport } from './reports.service.js';
import { hospitalIdsForTag } from '@/modules/hospitals/hospital-tags.service.js';

/** Raw counts per (initiative, task type). See Tally for what each means. */
async function tally(
  programYear: number,
  hospitalIds: string[] | null,
): Promise<Array<{ code: string; name: string; taskType: string } & Tally>> {
  return db
    .select({
      code: schema.initiatives.code,
      name: schema.initiatives.name,
      taskType: schema.taskTemplates.taskType,
      expected: sql<number>`count(*) FILTER (
        WHERE ${schema.taskInstances.dueOn} < CURRENT_DATE
           OR ${schema.taskInstances.status} = 'complete')::int`,
      engaged: sql<number>`count(*) FILTER (
        WHERE ${schema.taskInstances.status} = 'complete'
          AND (${schema.taskInstances.outcome} IS NULL
               OR ${schema.taskInstances.outcome} NOT IN ('missed','not_submitted')))::int`,
      late: sql<number>`count(*) FILTER (
        WHERE ${schema.taskInstances.status} = 'complete'
          AND ${schema.taskInstances.outcome} = 'late')::int`,
    })
    .from(schema.taskInstances)
    .innerJoin(
      schema.taskTemplates,
      eq(schema.taskTemplates.id, schema.taskInstances.taskTemplateId),
    )
    .innerJoin(schema.programYears, eq(schema.programYears.id, schema.taskInstances.programYearId))
    .innerJoin(schema.enrollments, eq(schema.enrollments.id, schema.taskInstances.enrollmentId))
    .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
    .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
    .where(
      and(
        eq(schema.programYears.year, programYear),
        // Withdrawn enrollments carry tasks nobody was ever going to do;
        // counting them reports a hospital that left as one that failed.
        eq(schema.enrollments.status, 'enrolled'),
        ...(hospitalIds ? [inArray(schema.enrollments.hospitalId, hospitalIds)] : []),
      ),
    )
    .groupBy(schema.initiatives.code, schema.initiatives.name, schema.taskTemplates.taskType);
}

/**
 * The statutory picture, per hospital.
 *
 * Built on the annual report rather than a fresh query so that "compliant"
 * means exactly what it means everywhere else in the tracker — the same
 * compliance engine, the same thresholds. A second definition living here
 * would drift from the one CDPHE reports are built on.
 *
 * The denominator is every hospital on the roster, not just the enrolled ones:
 * a hospital that never enrolled is the clearest possible non-compliance, and
 * counting only enrollees would hide it.
 */
async function statutoryCompliance(
  programYear: number,
  hospitalIds: string[] | null,
): Promise<StatutoryCompliance> {
  const [report, roster] = await Promise.all([
    assembleAnnualReport(programYear),
    hospitalIds
      ? db
          .select({ id: schema.hospitals.id })
          .from(schema.hospitals)
          .where(inArray(schema.hospitals.id, hospitalIds))
      : db.select({ id: schema.hospitals.id }).from(schema.hospitals),
  ]);

  const byHospital = new Map<string, string[]>();
  for (const h of report.hospitals) {
    byHospital.set(
      h.hospitalId,
      h.enrollments
        .filter((e) => e.enrollmentStatus === 'enrolled')
        .map((e) => e.overall),
    );
  }

  let engaged = 0;
  let compliant = 0;
  let met = 0;
  let atRiskInAll = 0;
  const counts = new Map<number, number>();
  for (const h of roster) {
    const statuses = byHospital.get(h.id) ?? [];
    if (statuses.length === 0) continue;
    engaged += 1;
    counts.set(statuses.length, (counts.get(statuses.length) ?? 0) + 1);
    const anyOk = statuses.some((st) => st === 'met' || st === 'on_track');
    if (anyOk) compliant += 1;
    else atRiskInAll += 1;
    if (statuses.some((st) => st === 'met')) met += 1;
  }

  return {
    hospitals: roster.length,
    engagedInAtLeastOne: engaged,
    notEngaged: roster.length - engaged,
    compliantInAtLeastOne: compliant,
    metInAtLeastOne: met,
    atRiskInAll,
    byInitiativeCount: [...counts.entries()]
      .map(([initiatives, hospitals]) => ({ initiatives, hospitals }))
      .sort((a, b) => a.initiatives - b.initiatives),
  };
}

/**
 * @param cohort Optional cohort tag (e.g. "Scholarship recipient"). When given,
 *   every figure is scoped to that group — including the statutory
 *   denominator, so "4 of 4 engaged" means the cohort, not the state.
 */
export async function computeEngagementMetrics(
  programYear: number,
  cohort?: string | null,
): Promise<EngagementSummary> {
  const hospitalIds = cohort ? await hospitalIdsForTag(cohort) : null;
  const [rows, hospitalRows, statutory] = await Promise.all([
    tally(programYear, hospitalIds),
    db
      .select({ code: schema.initiatives.code, hospitalId: schema.enrollments.hospitalId })
      .from(schema.enrollments)
      .innerJoin(schema.programYears, eq(schema.programYears.enrollmentId, schema.enrollments.id))
      .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
      .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
      .where(
        and(
          eq(schema.programYears.year, programYear),
          eq(schema.enrollments.status, 'enrolled'),
          ...(hospitalIds ? [inArray(schema.enrollments.hospitalId, hospitalIds)] : []),
        ),
      ),
    statutoryCompliance(programYear, hospitalIds),
  ]);

  const byCode = new Map<string, { name: string; types: Map<string, Tally> }>();
  const overallTypes = new Map<string, Tally>();
  for (const r of rows) {
    if (!byCode.has(r.code)) byCode.set(r.code, { name: r.name, types: new Map() });
    byCode.get(r.code)!.types.set(r.taskType, {
      expected: r.expected,
      engaged: r.engaged,
      late: r.late,
    });
    const o = overallTypes.get(r.taskType) ?? EMPTY_TALLY;
    overallTypes.set(r.taskType, {
      expected: o.expected + r.expected,
      engaged: o.engaged + r.engaged,
      late: o.late + r.late,
    });
  }

  const hospitalsByCode = new Map<string, Set<string>>();
  const allHospitals = new Set<string>();
  for (const h of hospitalRows) {
    if (!hospitalsByCode.has(h.code)) hospitalsByCode.set(h.code, new Set());
    hospitalsByCode.get(h.code)!.add(h.hospitalId);
    allHospitals.add(h.hospitalId);
  }

  const byInitiative: EngagementScope[] = [...byCode.entries()]
    .map(([code, v]) => ({
      initiativeCode: code,
      initiativeName: v.name,
      hospitals: hospitalsByCode.get(code)?.size ?? 0,
      metrics: toMetrics((tt) => v.types.get(tt) ?? EMPTY_TALLY),
    }))
    .sort((a, b) => (a.initiativeCode ?? '').localeCompare(b.initiativeCode ?? ''));

  return {
    programYear,
    asOf: new Date().toISOString().slice(0, 10),
    overall: {
      initiativeCode: null,
      initiativeName: null,
      hospitals: allHospitals.size,
      metrics: toMetrics((tt) => overallTypes.get(tt) ?? EMPTY_TALLY),
    },
    byInitiative,
    statutory,
    cohort: cohort ?? null,
  };
}
