import { describe, expect, it } from 'vitest';
import {
  dyadicMaternalEligible,
  countDenverHealthDyadicForms,
  DENVER_HEALTH_CHA_ID,
} from './ttt-dyadic.js';
import type { RedcapRow } from './ttt-engagement.js';

/** Minimal Dyadic maternal row builder. */
function row(overrides: RedcapRow = {}): RedcapRow {
  return {
    redcap_data_access_group: 'denver_health',
    sample_check_mat: '',
    delivery_date_1: '2026-05-14',
    ...overrides,
  };
}

describe('dyadicMaternalEligible — Dyadic uses sample_check_mat + codes 1–6', () => {
  it('derived: a qualifying substance (1–6) and not explicitly ineligible', () => {
    expect(dyadicMaternalEligible(row({ substances_used_2___3: '1' }))).toBe(true);
    expect(dyadicMaternalEligible(row({ substances_used_2___1: '1' }))).toBe(true);
    expect(dyadicMaternalEligible(row({ substances_used_2___6: '1' }))).toBe(true);
  });

  it('derived: excludes Dyadic codes 7 (alcohol), 8 (nicotine), 9 (cannabis)', () => {
    // These qualify under the TtT scheme but NOT the Dyadic scheme.
    expect(dyadicMaternalEligible(row({ substances_used_2___7: '1' }))).toBe(false);
    expect(dyadicMaternalEligible(row({ substances_used_2___8: '1' }))).toBe(false);
    expect(dyadicMaternalEligible(row({ substances_used_2___9: '1' }))).toBe(false);
  });

  it('derived: explicit ineligible (2) overrides a checked substance', () => {
    expect(
      dyadicMaternalEligible(row({ substances_used_2___2: '1', sample_check_mat: '2' })),
    ).toBe(false);
  });

  it('derived: no substance checked → not eligible', () => {
    expect(dyadicMaternalEligible(row())).toBe(false);
  });

  it('explicit mode: only sample_check_mat == 1 counts', () => {
    expect(dyadicMaternalEligible(row({ sample_check_mat: '1' }), 'explicit')).toBe(true);
    // qualifying substance but no explicit flag → false under explicit
    expect(
      dyadicMaternalEligible(row({ substances_used_2___3: '1' }), 'explicit'),
    ).toBe(false);
  });

  it('either mode: explicit OR derived', () => {
    expect(dyadicMaternalEligible(row({ sample_check_mat: '1' }), 'either')).toBe(true);
    expect(dyadicMaternalEligible(row({ substances_used_2___3: '1' }), 'either')).toBe(true);
    expect(dyadicMaternalEligible(row(), 'either')).toBe(false);
  });
});

describe('countDenverHealthDyadicForms', () => {
  it('counts eligible forms per period, cohort-year filtered first', () => {
    const rows: RedcapRow[] = [
      row({ substances_used_2___1: '1', delivery_date_1: '2026-05-03' }), // eligible, May
      row({ substances_used_2___2: '1', delivery_date_1: '2026-05-28' }), // eligible, May
      row({ substances_used_2___4: '1', delivery_date_1: '2026-06-10' }), // eligible, Jun
      row({ substances_used_2___7: '1', delivery_date_1: '2026-06-11' }), // code 7 → ineligible
      row({ substances_used_2___1: '1', delivery_date_1: '2025-12-30' }), // wrong year → dropped
      row({ substances_used_2___1: '1', delivery_date_1: '' }), // no delivery date → dropped
    ];
    const res = countDenverHealthDyadicForms(rows, 2026, 'derived');
    expect(res.eligibleTotal).toBe(3);
    expect(res.dhRows).toBe(6);
    expect(res.countsByPeriod.get('2026-05')).toBe(2);
    expect(res.countsByPeriod.get('2026-06')).toBe(1);
    expect(res.countsByPeriod.has('2025-12')).toBe(false);
  });

  it('returns an empty map when nothing is eligible', () => {
    const res = countDenverHealthDyadicForms([row(), row()], 2026, 'derived');
    expect(res.eligibleTotal).toBe(0);
    expect(res.countsByPeriod.size).toBe(0);
  });

  it('Denver Health CHA_ID is 428', () => {
    expect(DENVER_HEALTH_CHA_ID).toBe(428);
  });
});
