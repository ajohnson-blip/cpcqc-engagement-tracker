/**
 * The file CHA's nightly assessment script delivers — format v2, as defined in
 * docs/cha-sync-contract.md — and its validation.
 *
 * Pure: no network, no database, no `@/` imports, so it is unit testable.
 *
 * Validation is STRICT on purpose. Every object refuses keys the contract does
 * not define, so a field included by mistake — a delivery date copied into an
 * assessment, say — makes the whole file refused rather than stored. That is a
 * second line of defence behind the script's own constraints, and it is why a
 * schema violation rejects the file outright while a REDCap outage (a run with
 * status "error") does not: the first means the script produced something it
 * should not have, and output from a script in that state is not trusted for
 * any program.
 *
 * Rejection messages name WHERE a problem is and WHAT was expected, never the
 * value found there: the value is exactly the thing that may not belong.
 */
import { z, type ZodIssue } from 'zod';
import { linkageFloorMet, linkageIdealMet } from './ttt-engagement.js';

export const FORMAT_VERSION = 'v2';

export const PROGRAMS = ['SPARK', 'NEST', 'SOAR', 'TTT'] as const;
export type ChaProgram = (typeof PROGRAMS)[number];

/** Reporting cadence decides the period format: "2026-07" or "2026-Q3". */
const MONTHLY = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTERLY = /^\d{4}-Q[1-4]$/;
const PERIOD_FORMAT: Record<ChaProgram, RegExp> = {
  SPARK: QUARTERLY,
  NEST: MONTHLY,
  SOAR: MONTHLY,
  TTT: MONTHLY,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The two monthly NEST instruments, as named in REDCap. */
export const NEST_FORMS = ['safe_sleep_audit', 'chart_reviews'] as const;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** generated_at may run slightly ahead of our clock, never far ahead. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

const count = z.number().int().nonnegative();
const text = (max: number) => z.string().min(1).max(max);

const missingFieldSchema = z.object({ field: text(100), label: text(500) }).strict();

const assessmentSchema = z
  .object({
    cha_id: z.string().regex(/^[A-Za-z0-9-]{1,20}$/),
    period: z.string().max(10),
    submitted: z.boolean(),
    complete: z.boolean(),
    // A data-entry date, never a clinical one; null when REDCap captured none.
    earliest_submission_date: z.string().regex(ISO_DATE).nullable(),
    records: z.object({ total: count, complete: count, attestation: count }).strict(),
    attestation_only: z.boolean(),
    missing_field_groups: z.array(
      z
        .object({ form: text(100), records: count.min(1), fields: z.array(missingFieldSchema).min(1) })
        .strict(),
    ),
    // SPARK only: how many fields the submission had to complete (56, or 74
    // with IPV screening), for the tracker's percent-complete. Required there.
    fields_required: z.number().int().min(1).max(200).optional(),
    // NEST only: each form's rows. Required there, refused elsewhere.
    forms: z
      .array(z.object({ form: text(100), total: count, complete: count }).strict())
      .min(1)
      .max(4)
      .optional(),
    linkage: z
      .object({
        positive_screens: count,
        patient_forms: count,
        shortfall: count,
        floor_met: z.boolean(),
        ideal_met: z.boolean(),
      })
      .strict()
      .optional(),
    notes: z.array(text(500)),
  })
  .strict();

const okRunSchema = z
  .object({
    program: z.enum(PROGRAMS),
    program_year: z.number().int().min(2020).max(2100),
    status: z.literal('ok'),
    methodology_version: text(50),
    source: z.object({ records_read: count, redcap_project: text(200) }).strict(),
    assessments: z.array(assessmentSchema),
    warnings: z.array(text(1000)),
  })
  .strict();

const errorRunSchema = z
  .object({
    program: z.enum(PROGRAMS),
    program_year: z.number().int().min(2020).max(2100),
    status: z.literal('error'),
    error: z
      .object({ code: z.enum(['redcap_unavailable', 'configuration', 'internal']), message: text(1000) })
      .strict(),
  })
  .strict();

export const snapshotFileSchema = z
  .object({
    format_version: z.literal(FORMAT_VERSION),
    snapshot_id: z.string().uuid(),
    generated_at: z.string().regex(UTC_TIMESTAMP),
    generator: z.object({ name: text(100), version: text(50) }).strict(),
    runs: z.array(z.discriminatedUnion('status', [okRunSchema, errorRunSchema])).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    // Rules a per-field schema cannot express. Each problem is reported at
    // its own path so the script's maintainer can find it.
    const seenRuns = new Set<string>();
    file.runs.forEach((run, r) => {
      const runKey = `${run.program}:${run.program_year}`;
      if (seenRuns.has(runKey)) {
        ctx.addIssue({ code: 'custom', path: ['runs', r], message: `a second run for ${run.program} ${run.program_year}` });
      }
      seenRuns.add(runKey);
      if (run.status !== 'ok') return;

      const seenCells = new Set<string>();
      run.assessments.forEach((a, i) => {
        const at = ['runs', r, 'assessments', i];
        if (!PERIOD_FORMAT[run.program].test(a.period)) {
          ctx.addIssue({ code: 'custom', path: [...at, 'period'], message: `not a ${run.program} reporting period` });
        } else if (!a.period.startsWith(`${run.program_year}-`)) {
          ctx.addIssue({ code: 'custom', path: [...at, 'period'], message: `outside program year ${run.program_year}` });
        }
        const cell = `${a.cha_id}::${a.period}`;
        if (seenCells.has(cell)) {
          ctx.addIssue({ code: 'custom', path: at, message: 'a second assessment for the same hospital and period' });
        }
        seenCells.add(cell);
        if (a.records.complete > a.records.total) {
          ctx.addIssue({ code: 'custom', path: [...at, 'records'], message: 'more complete records than records' });
        }
        // Linkage is computed from TtT's patient-level project and means
        // nothing elsewhere; on another program it is a field out of place.
        if (a.linkage !== undefined && run.program !== 'TTT') {
          ctx.addIssue({ code: 'custom', path: [...at, 'linkage'], message: 'linkage is defined for TTT only' });
        }
        // NEST's verdict depends on which of its two forms arrived.
        if (run.program === 'NEST') {
          const forms = a.forms ?? [];
          for (const form of NEST_FORMS) {
            if (!forms.some((f) => f.form === form)) {
              ctx.addIssue({ code: 'custom', path: [...at, 'forms'], message: `needs an entry for ${form}` });
            }
          }
          forms.forEach((f, j) => {
            if (!(NEST_FORMS as readonly string[]).includes(f.form)) {
              ctx.addIssue({ code: 'custom', path: [...at, 'forms', j, 'form'], message: 'not a NEST form' });
            }
            if (f.complete > f.total) {
              ctx.addIssue({ code: 'custom', path: [...at, 'forms', j], message: 'more complete rows than rows' });
            }
          });
        } else if (a.forms !== undefined) {
          ctx.addIssue({ code: 'custom', path: [...at, 'forms'], message: 'forms is defined for NEST only' });
        }
        if (run.program === 'SPARK') {
          if (a.fields_required === undefined) {
            ctx.addIssue({ code: 'custom', path: [...at, 'fields_required'], message: 'required for SPARK' });
          } else {
            const missing = a.missing_field_groups.reduce((n, g) => n + g.fields.length, 0);
            if (missing > a.fields_required) {
              ctx.addIssue({
                code: 'custom',
                path: [...at, 'fields_required'],
                message: 'fewer than the fields reported missing',
              });
            }
          }
        } else if (a.fields_required !== undefined) {
          ctx.addIssue({ code: 'custom', path: [...at, 'fields_required'], message: 'fields_required is defined for SPARK only' });
        }
        // TtT's verdict rests on linkage. The sync judges the floor and the
        // ideal from the counts with the tracker's own rule, so flags that
        // disagree with the counts mean the two sides' rules have drifted.
        if (run.program === 'TTT') {
          const l = a.linkage;
          if (l === undefined) {
            ctx.addIssue({ code: 'custom', path: [...at, 'linkage'], message: 'required for TTT' });
          } else {
            const shortfall = l.positive_screens > 0 ? Math.max(l.positive_screens - l.patient_forms, 0) : 0;
            const checks: Array<[keyof typeof l, boolean]> = [
              ['shortfall', l.shortfall === shortfall],
              ['floor_met', l.floor_met === linkageFloorMet(l.positive_screens, l.patient_forms)],
              ['ideal_met', l.ideal_met === linkageIdealMet(l.positive_screens, l.patient_forms)],
            ];
            for (const [key, ok] of checks) {
              if (!ok) {
                ctx.addIssue({
                  code: 'custom',
                  path: [...at, 'linkage', key],
                  message: 'does not follow from positive_screens and patient_forms',
                });
              }
            }
          }
        }
      });
    });
  });

export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type SnapshotRun = SnapshotFile['runs'][number];
export type OkRun = Extract<SnapshotRun, { status: 'ok' }>;
export type ErrorRun = Extract<SnapshotRun, { status: 'error' }>;
export type ChaAssessment = OkRun['assessments'][number];

export class SnapshotRejected extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

function formatPath(path: Array<string | number>): string {
  if (path.length === 0) return 'file';
  return path.reduce<string>(
    (acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part),
    '',
  );
}

/** What was expected at a path — deliberately never what was received. */
function describeIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case 'unrecognized_keys':
      return `key${issue.keys.length === 1 ? '' : 's'} the contract does not define: ${issue.keys
        .map((k) => `"${k}"`)
        .join(', ')}`;
    case 'invalid_type':
      return issue.received === 'undefined' ? 'required' : `expected ${issue.expected}`;
    case 'invalid_literal':
      return `expected ${JSON.stringify(issue.expected)}`;
    case 'invalid_enum_value':
      return `expected one of ${issue.options.map((o) => JSON.stringify(o)).join(', ')}`;
    case 'invalid_union_discriminator':
      return `expected one of ${issue.options.map((o) => JSON.stringify(o)).join(', ')}`;
    case 'invalid_string':
      return 'not in the expected format';
    case 'too_small':
      return issue.type === 'array' ? `needs at least ${issue.minimum} item(s)` : 'too small or empty';
    case 'too_big':
      return issue.type === 'array' ? `more than ${issue.maximum} items` : 'too large or too long';
    case 'custom':
      return issue.message;
    default:
      return 'invalid';
  }
}

const MAX_REPORTED_PROBLEMS = 20;

/**
 * Validate a delivered file. Throws SnapshotRejected listing every problem
 * (up to a cap), so one round trip tells CHA everything that needs fixing.
 */
export function parseSnapshotFile(raw: unknown, now: Date = new Date()): SnapshotFile {
  // Checked first and alone: under another version every other message
  // would be noise.
  if (raw && typeof raw === 'object' && 'format_version' in raw && raw.format_version !== FORMAT_VERSION) {
    throw new SnapshotRejected([`format_version: this tracker implements ${FORMAT_VERSION} only`]);
  }
  const result = snapshotFileSchema.safeParse(raw);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${formatPath(i.path)}: ${describeIssue(i)}`);
    const shown = problems.slice(0, MAX_REPORTED_PROBLEMS);
    if (problems.length > shown.length) shown.push(`…and ${problems.length - shown.length} more`);
    throw new SnapshotRejected(shown);
  }
  const generatedAt = Date.parse(result.data.generated_at);
  if (Number.isNaN(generatedAt)) {
    throw new SnapshotRejected(['generated_at: not a valid timestamp']);
  }
  // A file stamped in the future would win "newest" against every real file
  // that followed it.
  if (generatedAt > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new SnapshotRejected(['generated_at: later than the time it was received']);
  }
  return result.data;
}
