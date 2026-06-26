import { describe, expect, it } from 'vitest';
import {
  secondFriday,
  monthDeadline,
  eventToPeriod,
  checkSspRow,
  checkChartRow,
  buildNestGrid,
  type RedcapRow,
} from './nest-engagement.js';

describe('deadlines (2nd Friday of the following month)', () => {
  it('matches the published NEST schedule', () => {
    expect(monthDeadline(2026, 1)).toBe('2026-02-13'); // January → Feb 13
    expect(monthDeadline(2026, 3)).toBe('2026-04-10'); // March → Apr 10
    expect(monthDeadline(2026, 5)).toBe('2026-06-12'); // May → Jun 12
    expect(monthDeadline(2026, 6)).toBe('2026-07-10'); // June → Jul 10
    expect(monthDeadline(2026, 12)).toBe('2027-01-08'); // December → Jan 8 2027
  });
  it('computes the 2nd Friday', () => {
    expect(secondFriday(2026, 2)).toBe('2026-02-13');
  });
});

describe('eventToPeriod', () => {
  it('maps monthly events to YYYY-MM', () => {
    expect(eventToPeriod('january_2026_arm_1')).toBe('2026-01');
    expect(eventToPeriod('sept_2026_arm_1')).toBe('2026-09');
    expect(eventToPeriod('dec_2026_arm_1')).toBe('2026-12');
  });
  it('returns null for readiness / empty events', () => {
    expect(eventToPeriod('baseline_assessmen_arm_1')).toBeNull();
    expect(eventToPeriod('readiness_assessme_arm_1')).toBeNull();
    expect(eventToPeriod('')).toBeNull();
  });
});

describe('checkSspRow', () => {
  it('compliant row is complete', () => {
    expect(checkSspRow({ compliant_ssp: '1' }).complete).toBe(true);
  });
  it('non-compliant row needs noncomp_addressed AND the reasons checkbox', () => {
    expect(checkSspRow({ compliant_ssp: '0' }).complete).toBe(false);
    expect(checkSspRow({ compliant_ssp: '0', noncomp_addressed: '1' }).complete).toBe(false); // checkbox still missing
    const ok = checkSspRow({ compliant_ssp: '0', noncomp_addressed: '1', notcompliant_reasons___3: '1' });
    expect(ok.complete).toBe(true);
  });
  it('blank compliant_ssp is incomplete', () => {
    expect(checkSspRow({ compliant_ssp: '' }).missing).toContain('compliant_ssp');
  });
});

function fullChart(extra: RedcapRow = {}): RedcapRow {
  return {
    race___1: '1',
    ethnicity: '1',
    language: '1',
    payor: '2',
    ss_education_doc: '1',
    ss_screening_doc: '2', // "not documented" → complete answer, no homeneeds required
    ss_resources_doc: '1',
    ...extra,
  };
}

describe('checkChartRow', () => {
  it('a fully-answered row is complete ("not documented" counts as filled)', () => {
    expect(checkChartRow(fullChart()).complete).toBe(true);
  });
  it('missing the race checkbox is incomplete', () => {
    const r = checkChartRow(fullChart({ race___1: '0' }));
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('race');
  });
  it('a blank required field is incomplete', () => {
    expect(checkChartRow(fullChart({ language: '' })).missing).toContain('language');
  });
  it('requires homeneeds_doc when screening is documented', () => {
    expect(checkChartRow(fullChart({ ss_screening_doc: '1' })).missing).toContain('homeneeds_doc');
    expect(checkChartRow(fullChart({ ss_screening_doc: '1', homeneeds_doc: '2' })).complete).toBe(true);
  });
});

describe('buildNestGrid', () => {
  const dag = 'wray_community_dis';
  const ev = 'march_2026_arm_1'; // → 2026-03, deadline 2026-04-10
  function ssp(date: string, extra: RedcapRow = {}): RedcapRow {
    return {
      redcap_repeat_instrument: 'safe_sleep_audit',
      redcap_event_name: ev,
      redcap_data_access_group: dag,
      compliant_ssp: '1',
      data_entry_date_ssp: date,
      ...extra,
    };
  }
  function chart(date: string, extra: RedcapRow = {}): RedcapRow {
    return {
      redcap_repeat_instrument: 'chart_reviews',
      redcap_event_name: ev,
      redcap_data_access_group: dag,
      data_entry_date: date,
      ...fullChart(),
      ...extra,
    };
  }

  it('both forms, all rows complete, on time → dataComplete + onTime', () => {
    const grid = buildNestGrid([ssp('2026-04-05'), ssp('2026-04-05'), chart('2026-04-05')]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.bothSubmitted).toBe(true);
    expect(cell.dataComplete).toBe(true);
    expect(cell.onTime).toBe(true);
    expect(cell.ssp.nRows).toBe(2);
  });

  it('one bad row fails the whole month (strict all-rows rule)', () => {
    const grid = buildNestGrid([ssp('2026-04-05'), chart('2026-04-05'), chart('2026-04-05', { language: '' })]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.bothSubmitted).toBe(true);
    expect(cell.dataComplete).toBe(false);
    expect(cell.chart.nComplete).toBe(1);
    expect(cell.chart.nRows).toBe(2);
  });

  it('only one form submitted → not bothSubmitted', () => {
    const grid = buildNestGrid([ssp('2026-04-05')]);
    expect(grid.get(`${dag}::2026-03`)!.bothSubmitted).toBe(false);
  });

  it('late submission → onTime false', () => {
    const grid = buildNestGrid([ssp('2026-04-20'), chart('2026-04-20')]);
    const cell = grid.get(`${dag}::2026-03`)!;
    expect(cell.dataComplete).toBe(true);
    expect(cell.onTime).toBe(false); // 2026-04-20 is past the 2026-04-10 deadline
  });

  it('ignores test DAGs and readiness events', () => {
    const rows: RedcapRow[] = [
      ssp('2026-04-05', { redcap_data_access_group: 'test' }),
      { redcap_repeat_instrument: '', redcap_event_name: 'baseline_assessmen_arm_1', redcap_data_access_group: dag },
    ];
    expect(buildNestGrid(rows).size).toBe(0);
  });
});
