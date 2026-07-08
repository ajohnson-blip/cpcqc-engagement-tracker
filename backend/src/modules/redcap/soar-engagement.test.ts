import { describe, expect, it } from 'vitest';
import {
  thirdFriday,
  monthDeadline,
  checkNtsvRow,
  checkNoNtsvRow,
  buildSoarGrid,
  type RedcapRow,
} from './soar-engagement.js';

describe('deadlines (3rd Friday of the following month)', () => {
  it('matches the published SOAR schedule', () => {
    expect(monthDeadline(2026, 1)).toBe('2026-02-20'); // January → Feb 20
    expect(monthDeadline(2026, 3)).toBe('2026-04-17'); // March → Apr 17
    expect(monthDeadline(2026, 4)).toBe('2026-05-15'); // April → May 15
    expect(monthDeadline(2026, 6)).toBe('2026-07-17'); // June → Jul 17
    expect(monthDeadline(2026, 12)).toBe('2027-01-15'); // December → Jan 15 2027
  });
  it('computes the 3rd Friday', () => {
    expect(thirdFriday(2026, 2)).toBe('2026-02-20');
    expect(thirdFriday(2026, 1)).toBe('2026-01-16');
  });
});

/** A fully-complete NTSV row with a non-branching indication (no conditionals). */
function fullNtsv(extra: RedcapRow = {}): RedcapRow {
  return {
    redcap_repeat_instrument: 'ntsv_cesarean_section',
    checklist_comms_tool: '1',
    who_managed_labor_2: '2',
    age: '30',
    delivery_date: '2026-03-10',
    gest_age: '39.0',
    c_sect_indication_primary: '5', // Malpresentation → no conditional fields
    admit_reason___1: '1', // admitted (not "for induction")
    date: '2026-04-10',
    ...extra,
  };
}

describe('checkNtsvRow — always-required + admit checkbox', () => {
  it('a fully-answered non-branching row is complete', () => {
    expect(checkNtsvRow(fullNtsv()).complete).toBe(true);
  });
  it('missing checklist_comms_tool is incomplete (Denver Health case)', () => {
    const r = checkNtsvRow(fullNtsv({ checklist_comms_tool: '' }));
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('checklist_comms_tool');
  });
  it('missing the admit_reason checkbox is incomplete', () => {
    const r = checkNtsvRow(fullNtsv({ admit_reason___1: '0' }));
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('admit_reason');
  });
});

describe('checkNtsvRow — induction branch (admit_reason includes 4)', () => {
  it('requires induction_reason + induction_method when admitted for induction', () => {
    const r = checkNtsvRow(fullNtsv({ admit_reason___1: '0', admit_reason___4: '1' }));
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['induction_reason', 'induction_method']));
  });
  it('is complete when both induction checkboxes are filled', () => {
    const r = checkNtsvRow(
      fullNtsv({ admit_reason___4: '1', induction_reason___1: '1', induction_method___5: '1' }),
    );
    expect(r.complete).toBe(true);
  });
});

describe('checkNtsvRow — primary-indication branches', () => {
  it('failed induction (1) requires its 3 fields', () => {
    expect(checkNtsvRow(fullNtsv({ c_sect_indication_primary: '1' })).complete).toBe(false);
    const ok = checkNtsvRow(
      fullNtsv({
        c_sect_indication_primary: '1',
        failed_induct_rupt_mem_y_n: '3',
        failed_induction_y_n: '1',
        fail_induct_six_cm_dil: '1',
      }),
    );
    expect(ok.complete).toBe(true);
  });
  it('arrest of dilation (2) requires its 4 fields', () => {
    const miss = checkNtsvRow(fullNtsv({ c_sect_indication_primary: '2' }));
    expect(miss.missing).toEqual(
      expect.arrayContaining(['arrest_dil_six_cm_dil', 'arrest_dil_rupt_mem', 'adequate_contraction', 'iupc_placed_y_n']),
    );
  });
  it('arrest of descent (3) requires its 2 fields', () => {
    const ok = checkNtsvRow(fullNtsv({ c_sect_indication_primary: '3', push_3hours: '1', op_vag_delivery: '0' }));
    expect(ok.complete).toBe(true);
  });
});

describe('checkNoNtsvRow — zero-case attestation', () => {
  it('month + checkbox → complete', () => {
    expect(checkNoNtsvRow({ month_year_nontsv: '3', self_report_nontsv___1: '1' }).complete).toBe(true);
  });
  it('missing the checkbox is incomplete', () => {
    const r = checkNoNtsvRow({ month_year_nontsv: '3' });
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('self_report_nontsv');
  });
});

describe('buildSoarGrid', () => {
  const dag = 'wray_community_dis';
  function ntsv(deliveryDate: string, submitDate: string, extra: RedcapRow = {}): RedcapRow {
    return { ...fullNtsv({ delivery_date: deliveryDate, date: submitDate }), redcap_data_access_group: dag, ...extra };
  }
  function attestation(month: string, submitDate: string, extra: RedcapRow = {}): RedcapRow {
    return {
      redcap_repeat_instrument: 'no_ntsv_csections',
      redcap_data_access_group: dag,
      month_year_nontsv: month,
      self_report_nontsv___1: '1',
      date: submitDate,
      ...extra,
    };
  }

  it('NTSV cases all complete + on time → dataComplete, onTime, not attestation-only', () => {
    const grid = buildSoarGrid([ntsv('2026-03-10', '2026-04-10'), ntsv('2026-03-12', '2026-04-11')]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.ntsv.nRows).toBe(2);
    expect(cell.dataComplete).toBe(true);
    expect(cell.onTime).toBe(true); // on/before 2026-04-17
    expect(cell.attestationOnly).toBe(false);
  });

  it('one bad NTSV row fails the whole month', () => {
    const grid = buildSoarGrid([ntsv('2026-03-10', '2026-04-10'), ntsv('2026-03-12', '2026-04-10', { age: '' })]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.dataComplete).toBe(false);
    expect(cell.ntsv.nComplete).toBe(1);
    expect(cell.ntsv.nRows).toBe(2);
  });

  it('valid No-NTSV attestation alone → submitted + complete + attestationOnly', () => {
    const grid = buildSoarGrid([attestation('3', '2026-04-10')]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.submitted).toBe(true);
    expect(cell.attestationOnly).toBe(true);
    expect(cell.dataComplete).toBe(true);
    expect(cell.onTime).toBe(true);
  });

  it('incomplete attestation → submitted but not complete', () => {
    const grid = buildSoarGrid([attestation('3', '2026-04-10', { self_report_nontsv___1: '0' })]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.submitted).toBe(true);
    expect(cell.dataComplete).toBe(false);
  });

  it('NTSV cases take precedence over an attestation for completeness', () => {
    // A real case that's incomplete + an attestation in the same month → not complete.
    const grid = buildSoarGrid([ntsv('2026-03-10', '2026-04-10', { gest_age: '' }), attestation('3', '2026-04-10')]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.attestationOnly).toBe(false);
    expect(cell.dataComplete).toBe(false);
  });

  it('late submission → onTime false', () => {
    const grid = buildSoarGrid([ntsv('2026-03-10', '2026-04-20')]);
    expect(grid.get(`${dag}::2026-03`)!.onTime).toBe(false); // past 2026-04-17
  });

  it('flags future-dated deliveries when todayIso is given', () => {
    const grid = buildSoarGrid([ntsv('2026-12-03', '2026-07-05')], { todayIso: '2026-07-08' });
    expect(grid.get(`${dag}::2026-12`)!.futureDated).toBe(1);
  });

  it('ignores the test DAG', () => {
    const grid = buildSoarGrid([ntsv('2026-03-10', '2026-04-10', { redcap_data_access_group: 'test' })]);
    expect(grid.size).toBe(0);
  });
});
