/**
 * Denver Health CHoSEN Dyadic patch for the TtT sync.
 *
 * Denver Health (CHA 428) submits its MONTHLY HOSPITAL data to the TtT project
 * like every other hospital, but enters its PATIENT-level forms in a *different*
 * REDCap project — the CHoSEN Dyadic project — not the TtT patient project.
 * Without this patch DH shows 0 patient forms against its positive screens every
 * month and false-flags as a linkage gap (all months, 24 positives, 0 forms).
 *
 * This module pulls DH's eligible MATERNAL forms from the Dyadic project and
 * returns a per-period count, which the sync merges into the TtT patient-form
 * counts for DH ONLY. It is deliberately isolated so nothing Dyadic-specific
 * leaks into the TtT logic: Dyadic uses different field names AND a different
 * substance-code scheme than the TtT patient form (see below).
 *
 * PHI note: exactly like the TtT patient project, we only ever COUNT rows here —
 * we never read, print, or store patient identifiers.
 *
 * Ported from Luis Montes' ttt_monthly_validation_v2.py (Section 4b + helpers).
 */
import type { RedcapRow, EligibilityMode } from './ttt-engagement.js';
import { patientPeriod } from './ttt-engagement.js';

/** Denver Health's CHA_ID. Its hospital-form data lives in the TtT project under
 *  this ID; only its PATIENT forms are redirected to the Dyadic project. */
export const DENVER_HEALTH_CHA_ID = 428;

/** Dyadic maternal instrument — one row per birthing person. */
export const DYADIC_MATERNAL_FORM = 'chosen_sud_maternal';

/** Dyadic's eligibility checkbox. The TtT patient form uses `sample_check_patient`. */
export const DYADIC_ELIGIBILITY_FIELD = 'sample_check_mat';
const DYADIC_ELIGIBLE_VALUE = 1;
const DYADIC_INELIGIBLE_VALUE = 2;

/**
 * Dyadic qualifying substance codes are 1–6. This is NOT the TtT code scheme:
 * in Dyadic, 7 = alcohol, 8 = nicotine, 9 = cannabis and are ALL excluded,
 * whereas TtT's own codes 8 and 9 qualify. Do not unify these two lists — the
 * checkbox field happens to share a name (`substances_used_2___N`) but the code
 * meanings differ between the two projects.
 */
const DYADIC_QUALIFYING_SUBSTANCE_CODES = ['1', '2', '3', '4', '5', '6'];

function toNum(value: unknown): number {
  const n = parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Eligibility for a Dyadic maternal record — same shape as TtT's
 * `patientEligible`, but using Dyadic's own field and substance-code scheme.
 * 'derived' (CPCQC's choice): a qualifying substance is checked AND the record
 * is not explicitly marked ineligible.
 */
export function dyadicMaternalEligible(row: RedcapRow, mode: EligibilityMode = 'derived'): boolean {
  const val = toNum(row[DYADIC_ELIGIBILITY_FIELD]);
  const explicit = val === DYADIC_ELIGIBLE_VALUE;
  const ineligible = val === DYADIC_INELIGIBLE_VALUE;
  const qualifying = DYADIC_QUALIFYING_SUBSTANCE_CODES.some(
    (c) => String(row[`substances_used_2___${c}`] ?? '').trim() === '1',
  );
  const derived = qualifying && !ineligible;
  if (mode === 'explicit') return explicit;
  if (mode === 'either') return explicit || derived;
  return derived;
}

export interface DyadicCountResult {
  /** period 'YYYY-MM' -> eligible DH maternal-form count */
  countsByPeriod: Map<string, number>;
  eligibleTotal: number;
  /** how many DH-DAG rows were considered (before year/eligibility filters) */
  dhRows: number;
}

/**
 * Count Denver Health's eligible Dyadic maternal forms per reporting period.
 * `dhRows` must already be filtered to DH's Dyadic DAG by the caller. Cohort-year
 * filter first, then eligibility (mirrors the TtT patient-form ordering). The
 * reporting period comes from delivery_date_1, same field as the TtT patient form.
 */
export function countDenverHealthDyadicForms(
  dhRows: RedcapRow[],
  programYear: number,
  mode: EligibilityMode = 'derived',
): DyadicCountResult {
  const countsByPeriod = new Map<string, number>();
  let eligibleTotal = 0;
  for (const r of dhRows) {
    const period = patientPeriod(r); // delivery_date_1 → 'YYYY-MM'
    if (!period || !period.startsWith(String(programYear))) continue;
    if (!dyadicMaternalEligible(r, mode)) continue;
    countsByPeriod.set(period, (countsByPeriod.get(period) ?? 0) + 1);
    eligibleTotal += 1;
  }
  return { countsByPeriod, eligibleTotal, dhRows: dhRows.length };
}
