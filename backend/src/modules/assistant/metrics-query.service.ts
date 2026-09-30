/**
 * Database side of the assistant's metrics queries. Shapes, arithmetic and
 * caveat rules live in metrics-query.ts.
 *
 * The counting expressions here are copied deliberately from
 * engagement-metrics.service.ts rather than generalised out of it. The grant
 * report is the number of record; this module must agree with it, and a shared
 * abstraction that someone later "improves" would let the two drift apart
 * silently. metrics-query.test.ts asserts they still match.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '@/db/index.js';
import { hospitalIdsForTag } from '@/modules/hospitals/hospital-tags.service.js';
import {
  expandPeriod,
  scopeCaveats,
  toGroup,
  taskTypeFor,
  type MetricsAnswer,
  type MetricsQuery,
  type RawGroup,
  type Unit,
} from './metrics-query.js';

/** Group expressions, allowlisted — never interpolated from user input. */
const GROUP_SQL = {
  none: null,
  initiative: sql`i.code`,
  period: sql`ti.period`,
  hospital: sql`h.name`,
  cohort: sql`c.label`,
} as const;

/**
 * `col IN (...)` as an explicit parameter list.
 *
 * Drizzle binds a JS array in a raw `sql` template as one parameter, which
 * Postgres reads as a record — so both `IN (${arr})` and `= ANY(${arr})` fail
 * against a text column. Expanding to one placeholder per value keeps the
 * values parameterised.
 */
function inList(col: SQL, values: string[]): SQL {
  if (values.length === 0) return sql`false`;
  return sql`${col} IN (${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`;
}

/** Shared predicates so the task- and hospital-level queries cannot diverge. */
const IS_EXPECTED = sql`(ti.due_on < CURRENT_DATE OR ti.status = 'complete')`;
const IS_ENGAGED = sql`(ti.status = 'complete' AND (ti.outcome IS NULL OR ti.outcome NOT IN ('missed','not_submitted')))`;
const IS_LATE = sql`(ti.status = 'complete' AND ti.outcome = 'late')`;
const IS_NO_OUTCOME = sql`(ti.status = 'complete' AND ti.outcome IS NULL)`;

function filters(q: MetricsQuery, periods: string[], hospitalIds: string[] | null): SQL {
  const parts: SQL[] = [
    sql`py.year = ${q.programYear}`,
    // Withdrawn enrollments carry tasks nobody was going to do; counting them
    // reports a hospital that left as one that failed.
    sql`e.status = 'enrolled'`,
    inList(sql`ti.period`, periods),
  ];
  if (q.metric) parts.push(sql`tt.task_type = ${taskTypeFor(q.metric)}`);
  if (q.initiatives?.length) parts.push(inList(sql`i.code`, q.initiatives));
  if (hospitalIds) parts.push(inList(sql`e.hospital_id`, hospitalIds));
  return sql.join(parts, sql` AND `);
}

const FROM = sql`
  FROM task_instances ti
  JOIN task_templates tt ON tt.id = ti.task_template_id
  JOIN program_years py ON py.id = ti.program_year_id
  JOIN enrollments e ON e.id = ti.enrollment_id
  JOIN cohorts c ON c.id = e.cohort_id
  JOIN initiatives i ON i.id = c.initiative_id
  JOIN hospitals h ON h.id = e.hospital_id`;

/** One row per (group, task type): tasks counted individually. */
async function taskLevel(
  q: MetricsQuery,
  periods: string[],
  hospitalIds: string[] | null,
): Promise<RawGroup[]> {
  const g = GROUP_SQL[q.groupBy ?? 'none'];
  const groupCol = g ?? sql`NULL::text`;
  const rows = await db.execute(sql`
    SELECT ${groupCol} AS "group", tt.task_type AS "taskType",
      count(*) FILTER (WHERE ${IS_EXPECTED})::int AS "expected",
      count(*) FILTER (WHERE ${IS_ENGAGED})::int AS "engaged",
      count(*) FILTER (WHERE ${IS_LATE})::int AS "late",
      count(*) FILTER (WHERE ${IS_NO_OUTCOME})::int AS "completeNoOutcome",
      count(*) FILTER (WHERE ti.finalized_at IS NULL)::int AS "unfinalized",
      count(DISTINCT e.hospital_id)::int AS "hospitals"
    ${FROM}
    WHERE ${filters(q, periods, hospitalIds)}
    GROUP BY ${groupCol}, tt.task_type
    ORDER BY ${groupCol} NULLS FIRST, tt.task_type`);
  return rows.rows as unknown as RawGroup[];
}

/**
 * One row per (group, task type): hospitals counted once each.
 *
 * A hospital is engaged if it did the thing at least once in the window, and
 * timely if at least one of those was not late. "Late" here is therefore
 * hospitals that engaged but only ever late — which keeps
 * `timely = engaged - late` true, as the task-level shape expects.
 */
async function hospitalLevel(
  q: MetricsQuery,
  periods: string[],
  hospitalIds: string[] | null,
): Promise<RawGroup[]> {
  const g = GROUP_SQL[q.groupBy ?? 'none'];
  const groupCol = g ?? sql`NULL::text`;
  const rows = await db.execute(sql`
    SELECT "group", "taskType",
      count(*) FILTER (WHERE h_expected)::int AS "expected",
      count(*) FILTER (WHERE h_engaged)::int AS "engaged",
      (count(*) FILTER (WHERE h_engaged) - count(*) FILTER (WHERE h_timely))::int AS "late",
      count(*) FILTER (WHERE h_no_outcome)::int AS "completeNoOutcome",
      count(*) FILTER (WHERE h_unfinalized)::int AS "unfinalized",
      count(*) FILTER (WHERE h_expected)::int AS "hospitals"
    FROM (
      SELECT ${groupCol} AS "group", tt.task_type AS "taskType", e.hospital_id,
        bool_or(${IS_EXPECTED}) AS h_expected,
        bool_or(${IS_ENGAGED}) AS h_engaged,
        bool_or(${IS_ENGAGED} AND NOT ${IS_LATE}) AS h_timely,
        bool_or(${IS_NO_OUTCOME}) AS h_no_outcome,
        bool_or(ti.finalized_at IS NULL) AS h_unfinalized
      ${FROM}
      WHERE ${filters(q, periods, hospitalIds)}
      GROUP BY ${groupCol}, tt.task_type, e.hospital_id
    ) x
    GROUP BY "group", "taskType"
    ORDER BY "group" NULLS FIRST, "taskType"`);
  return rows.rows as unknown as RawGroup[];
}

/**
 * Cohorts in scope and the cadence their templates run on.
 *
 * Cadence is a property of the task template, not the cohort row — cohorts
 * differ by track, and templates are defined per (initiative, track). SOAR's
 * Active track is monthly and its Sustainability track quarterly, which is
 * what makes an initiative-wide quarterly figure misleading.
 */
async function cohortsInScope(
  q: MetricsQuery,
  hospitalIds: string[] | null,
): Promise<Array<{ label: string; cadence: string; initiativeCode: string }>> {
  const parts: SQL[] = [sql`py.year = ${q.programYear}`, sql`e.status = 'enrolled'`];
  if (q.metric) parts.push(sql`tt.task_type = ${taskTypeFor(q.metric)}`);
  if (q.initiatives?.length) parts.push(inList(sql`i.code`, q.initiatives));
  if (hospitalIds) parts.push(inList(sql`e.hospital_id`, hospitalIds));
  const rows = await db.execute(sql`
    SELECT DISTINCT c.label AS "label", tt.period AS "cadence", i.code AS "initiativeCode"
    ${FROM}
    WHERE ${sql.join(parts, sql` AND `)}
    ORDER BY i.code, c.label`);
  return rows.rows as unknown as Array<{ label: string; cadence: string; initiativeCode: string }>;
}

/** Cohorts that actually have tasks in the requested window. */
async function cohortsWithData(
  q: MetricsQuery,
  periods: string[],
  hospitalIds: string[] | null,
): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT c.label AS "label"
    ${FROM}
    WHERE ${filters(q, periods, hospitalIds)}`);
  return new Set((rows.rows as unknown as Array<{ label: string }>).map((r) => r.label));
}

export async function queryEngagement(q: MetricsQuery): Promise<MetricsAnswer> {
  const unit: Unit = q.unit ?? 'task';
  const periods = expandPeriod(q.programYear, q.period);
  const hospitalIds = q.cohortTag ? await hospitalIdsForTag(q.cohortTag) : null;

  const [raw, cohorts, withData] = await Promise.all([
    unit === 'hospital'
      ? hospitalLevel(q, periods, hospitalIds)
      : taskLevel(q, periods, hospitalIds),
    cohortsInScope(q, hospitalIds),
    cohortsWithData(q, periods, hospitalIds),
  ]);

  const groups = raw.map((r) => toGroup(r, unit));
  const matched = new Set<string>();
  if ((q.groupBy ?? 'none') === 'period') for (const g of groups) if (g.group) matched.add(g.group);

  return {
    query: q,
    asOf: new Date().toISOString().slice(0, 10),
    unit,
    groups,
    caveats: scopeCaveats(cohorts, withData, groups),
    periodsMatched: matched.size > 0 ? [...matched].sort() : periods,
    cohortsInScope: cohorts,
  };
}

/** What the assistant is allowed to ask about, so it never guesses a name. */
export async function listDimensions(programYear: number): Promise<{
  programYear: number;
  initiatives: Array<{ code: string; name: string; cohorts: string[] }>;
  periodsByInitiative: Array<{ code: string; taskType: string; periods: string[] }>;
  cohortTags: string[];
}> {
  const [inits, periods, tags] = await Promise.all([
    db.execute(sql`
      SELECT i.code AS "code", i.name AS "name",
             array_agg(DISTINCT c.label) AS "cohorts"
      FROM initiatives i
      JOIN cohorts c ON c.initiative_id = i.id
      JOIN enrollments e ON e.cohort_id = c.id AND e.status = 'enrolled'
      JOIN program_years py ON py.enrollment_id = e.id AND py.year = ${programYear}
      GROUP BY i.code, i.name ORDER BY i.code`),
    db.execute(sql`
      SELECT i.code AS "code", tt.task_type AS "taskType",
             array_agg(DISTINCT ti.period ORDER BY ti.period) AS "periods"
      ${FROM}
      WHERE py.year = ${programYear} AND e.status = 'enrolled'
      GROUP BY i.code, tt.task_type ORDER BY i.code, tt.task_type`),
    db.execute(sql`SELECT DISTINCT tag AS "tag" FROM hospital_tags ORDER BY tag`),
  ]);
  return {
    programYear,
    initiatives: inits.rows as never,
    periodsByInitiative: periods.rows as never,
    cohortTags: (tags.rows as unknown as Array<{ tag: string }>).map((t) => t.tag),
  };
}
