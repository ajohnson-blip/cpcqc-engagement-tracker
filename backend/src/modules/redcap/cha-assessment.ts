/**
 * Contract v1 with the CHA assessment service: response shape, validation, and
 * the adapter onto the tracker's own grid.
 *
 * Pure — no network, no database, no `@/` imports — so it is unit testable.
 * The HTTP call lives in cha-assessment.client.ts.
 *
 * The service answers only "did they submit, was it complete, when did it
 * arrive". Deadlines and timeliness stay here, computed by the same helpers
 * the REDCap path uses, so both paths produce identical cells and the parity
 * comparison means something.
 */
import { z } from 'zod';
import { monthDeadline, dayDiff, type FormRollup, type SoarCell } from './soar-engagement.js';

export const CONTRACT_VERSION = 'v1';

const missingFieldSchema = z.object({ field: z.string(), label: z.string() });

const assessmentSchema = z.object({
  cha_id: z.string(),
  period: z.string(),
  submitted: z.boolean(),
  complete: z.boolean(),
  earliest_submission_date: z.string().nullable().optional(),
  records: z
    .object({ total: z.number().int(), complete: z.number().int(), attestation: z.number().int() })
    .default({ total: 0, complete: 0, attestation: 0 }),
  attestation_only: z.boolean().default(false),
  missing_field_groups: z
    .array(z.object({ form: z.string(), records: z.number().int(), fields: z.array(missingFieldSchema) }))
    .default([]),
  linkage: z
    .object({
      positive_screens: z.number().int(),
      patient_forms: z.number().int(),
      shortfall: z.number().int(),
      floor_met: z.boolean(),
      ideal_met: z.boolean(),
    })
    .nullish(),
  notes: z.array(z.string()).default([]),
});

export const assessResponseSchema = z.object({
  contract_version: z.string(),
  program: z.enum(['SPARK', 'NEST', 'SOAR', 'TTT']),
  program_year: z.number().int(),
  methodology_version: z.string(),
  computed_at: z.string(),
  source: z.object({ records_read: z.number().int(), redcap_project: z.string() }),
  assessments: z.array(assessmentSchema),
  warnings: z.array(z.string()).default([]),
});

export type AssessResponse = z.infer<typeof assessResponseSchema>;
export type Assessment = z.infer<typeof assessmentSchema>;

export const assessErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * Validate a response and reject a version this tracker does not implement.
 *
 * A mismatched version is refused rather than parsed leniently: the fields may
 * carry different meanings, and a figure that silently changes meaning is
 * worse than an error a program manager can see.
 */
export function parseAssessResponse(raw: unknown): AssessResponse {
  const parsed = assessResponseSchema.parse(raw);
  if (parsed.contract_version !== CONTRACT_VERSION) {
    throw new Error(
      `Assessment service replied with contract ${parsed.contract_version}; this tracker implements ${CONTRACT_VERSION}.`,
    );
  }
  return parsed;
}

function rollup(nRows: number, nComplete: number, earliest: string | null): FormRollup {
  return {
    submitted: nRows > 0,
    nRows,
    nComplete,
    pctComplete: nRows === 0 ? 0 : Math.round((nComplete / nRows) * 100),
    allComplete: nRows > 0 && nComplete === nRows,
    earliestDate: earliest,
    // The service reports neither: it validates dates before returning them,
    // and a future delivery date is a REDCap data-entry question that belongs
    // with the records rather than in an assessment.
    invalidDate: false,
    // Empty by design — the service sends grouped missing fields instead, which
    // carry no record identifiers.
    incompleteRows: [],
  };
}

/**
 * Assessments → the same `Map<dag::period, SoarCell>` the REDCap path builds,
 * so everything downstream — dispositions, overrides, finalization, the
 * preview — is unchanged.
 *
 * @param chaIdToDag CHA ID → REDCap DAG. The service keys by CHA ID; the
 *   tracker's grid and sync key by DAG, so one of them has to translate and it
 *   is cheaper here than threading CHA IDs through the sync.
 */
export function soarCellsFromAssessments(
  assessments: Assessment[],
  chaIdToDag: Map<string, string>,
): { cells: Map<string, SoarCell>; unmappedChaIds: string[] } {
  const cells = new Map<string, SoarCell>();
  const unmapped = new Set<string>();

  for (const a of assessments) {
    const dag = chaIdToDag.get(a.cha_id);
    if (!dag) {
      // Surfaced rather than dropped: a hospital missing from the result would
      // read as one that did not submit.
      unmapped.add(a.cha_id);
      continue;
    }
    const m = /^(\d{4})-(\d{2})$/.exec(a.period);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);

    const earliest = a.earliest_submission_date ?? null;
    const deadline = monthDeadline(year, month);
    const days = earliest ? dayDiff(earliest, deadline) : null;

    cells.set(`${dag}::${a.period}`, {
      dagCode: dag,
      period: a.period,
      ntsv: rollup(a.records.total, a.records.complete, earliest),
      // The service reports how many attestations exist but not how many were
      // themselves complete; `complete` below already encodes the verdict, so
      // a zero-case month is counted complete when the overall verdict says so.
      noNtsv: rollup(
        a.records.attestation,
        a.attestation_only && a.complete ? a.records.attestation : 0,
        earliest,
      ),
      attestationOnly: a.attestation_only,
      submitted: a.submitted,
      dataComplete: a.complete,
      futureDated: 0,
      earliestSubmissionDate: earliest,
      invalidDate: false,
      onTime: days === null ? null : days <= 0,
      daysFromDeadline: days,
      deadline,
      missingFieldGroups: a.missing_field_groups,
    });
  }

  return { cells, unmappedChaIds: [...unmapped].sort() };
}
