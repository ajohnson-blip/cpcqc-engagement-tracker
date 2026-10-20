/**
 * The adapter from CHA's assessments onto the tracker's own SOAR grid.
 *
 * Pure — no network, no database, no `@/` imports — so it is unit testable.
 * The file format and its validation live in cha-snapshot.ts.
 *
 * CHA's script answers only "did they submit, was it complete, when did it
 * arrive". Deadlines and timeliness stay here, computed by the same helpers
 * the REDCap path uses, so both paths produce identical cells and the parity
 * comparison means something.
 */
import type { ChaAssessment } from './cha-snapshot.js';
import { monthDeadline, dayDiff, type FormRollup, type SoarCell } from './soar-engagement.js';

/**
 * CHA reports missing fields by REDCap instrument name; the REDCap path labels
 * the same groups for people. Mapped here so a preview reads the same
 * whichever path built it.
 */
const SOAR_FORM_LABELS: Record<string, string> = {
  ntsv_cesarean_section: 'NTSV',
  no_ntsv_csections: 'No-NTSV attestation',
};

function rollup(nRows: number, nComplete: number, earliest: string | null): FormRollup {
  return {
    submitted: nRows > 0,
    nRows,
    nComplete,
    pctComplete: nRows === 0 ? 0 : Math.round((nComplete / nRows) * 100),
    allComplete: nRows > 0 && nComplete === nRows,
    earliestDate: earliest,
    // CHA reports these as assessment notes instead — see `notes` below.
    invalidDate: false,
    // Empty by design — CHA sends grouped missing fields instead, which carry
    // no record identifiers.
    incompleteRows: [],
  };
}

/**
 * Assessments → the same `Map<dag::period, SoarCell>` the REDCap path builds,
 * so everything downstream — dispositions, overrides, finalization, the
 * preview — is unchanged.
 *
 * @param chaIdToDag CHA ID → REDCap DAG. CHA keys by CHA ID; the tracker's
 *   grid and sync key by DAG, so one of them has to translate and it is
 *   cheaper here than threading CHA IDs through the sync.
 */
export function soarCellsFromAssessments(
  assessments: ChaAssessment[],
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
      // CHA reports how many attestations exist but not how many were
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
      // Reported in `notes`, as counts, rather than as these flags.
      futureDated: 0,
      earliestSubmissionDate: earliest,
      invalidDate: false,
      onTime: days === null ? null : days <= 0,
      daysFromDeadline: days,
      deadline,
      missingFieldGroups: a.missing_field_groups.map((g) => ({
        ...g,
        form: SOAR_FORM_LABELS[g.form] ?? g.form,
      })),
      notes: a.notes,
    });
  }

  return { cells, unmappedChaIds: [...unmapped].sort() };
}
