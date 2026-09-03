/**
 * Database side of the five funder-facing engagement metrics. The shapes,
 * arithmetic and narrative wording live in engagement-metrics.ts.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import {
  EMPTY_TALLY,
  toMetrics,
  type EngagementScope,
  type EngagementSummary,
  type Tally,
} from './engagement-metrics.js';

/** Raw counts per (initiative, task type). See Tally for what each means. */
async function tally(
  programYear: number,
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
      ),
    )
    .groupBy(schema.initiatives.code, schema.initiatives.name, schema.taskTemplates.taskType);
}

export async function computeEngagementMetrics(programYear: number): Promise<EngagementSummary> {
  const [rows, hospitalRows] = await Promise.all([
    tally(programYear),
    db
      .select({ code: schema.initiatives.code, hospitalId: schema.enrollments.hospitalId })
      .from(schema.enrollments)
      .innerJoin(schema.programYears, eq(schema.programYears.enrollmentId, schema.enrollments.id))
      .innerJoin(schema.cohorts, eq(schema.cohorts.id, schema.enrollments.cohortId))
      .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.cohorts.initiativeId))
      .where(
        and(eq(schema.programYears.year, programYear), eq(schema.enrollments.status, 'enrolled')),
      ),
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
  };
}
