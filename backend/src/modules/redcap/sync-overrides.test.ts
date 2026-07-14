import { describe, expect, it } from 'vitest';
import {
  dispositionToTask,
  categoryToDisposition,
  isHumanEdit,
  periodEndIso,
  resolveDeadline,
  toIsoDateOrNull,
} from './sync-overrides.js';

describe('dispositionToTask', () => {
  it('maps each disposition to the right task state', () => {
    expect(dispositionToTask('counts', '2026-04-07', '2026-06-25')).toEqual({
      status: 'complete',
      outcome: 'on_time',
      completedOn: '2026-04-07',
    });
    expect(dispositionToTask('late', null, '2026-06-25')).toEqual({
      status: 'complete',
      outcome: 'late',
      completedOn: '2026-06-25', // falls back to today when no submission date
    });
    expect(dispositionToTask('incomplete', '2026-04-07', '2026-06-25')).toEqual({
      status: 'needs_revision',
      outcome: null,
      completedOn: null,
    });
    expect(dispositionToTask('not_submitted', '2026-04-07', '2026-06-25')).toEqual({
      status: 'complete',
      outcome: 'not_submitted',
      completedOn: null,
    });
    expect(dispositionToTask('pending', '2026-04-07', '2026-06-25')).toEqual({
      status: 'not_started',
      outcome: null,
      completedOn: null,
    });
  });
});

describe('categoryToDisposition (dropdown default)', () => {
  it('maps computed categories to the default disposition', () => {
    expect(categoryToDisposition('counting')).toBe('counts');
    expect(categoryToDisposition('complete_nodate')).toBe('counts');
    expect(categoryToDisposition('complete_late')).toBe('late');
    expect(categoryToDisposition('incomplete')).toBe('incomplete');
    expect(categoryToDisposition('not_submitted')).toBe('not_submitted');
    expect(categoryToDisposition('pending')).toBe('pending');
  });
});

describe('isHumanEdit', () => {
  it('treats a user-id (UUID) as a human edit', () => {
    expect(isHumanEdit('67436309-c5ac-41e7-a74c-5105d28a15d9')).toBe(true);
  });
  it('treats system writers as non-human', () => {
    expect(isHumanEdit('redcap-soar-sync')).toBe(false);
    expect(isHumanEdit('redcap-nest-sync')).toBe(false);
    expect(isHumanEdit('pm-data-importer')).toBe(false);
    expect(isHumanEdit('due-date-2026')).toBe(false);
  });
  it('treats null/undefined (never edited) as non-human', () => {
    expect(isHumanEdit(null)).toBe(false);
    expect(isHumanEdit(undefined)).toBe(false);
  });
});

describe('periodEndIso', () => {
  it('handles monthly periods', () => {
    expect(periodEndIso('2026-01')).toBe('2026-01-31');
    expect(periodEndIso('2026-02')).toBe('2026-02-28');
    expect(periodEndIso('2026-06')).toBe('2026-06-30');
  });
  it('handles quarterly periods', () => {
    expect(periodEndIso('2026-Q1')).toBe('2026-03-31');
    expect(periodEndIso('2026-Q2')).toBe('2026-06-30');
    expect(periodEndIso('2026-Q4')).toBe('2026-12-31');
  });
});

describe('resolveDeadline', () => {
  it('honors due_on when it is after the period ends (a real CSV deadline)', () => {
    // SPARK Q2: sheet says 7/7, period ends 6/30 → use the sheet.
    expect(resolveDeadline('2026-07-07', periodEndIso('2026-Q2'), '2026-07-10')).toBe('2026-07-07');
    // NEST June: sheet says 7/10, period ends 6/30 → use the sheet.
    expect(resolveDeadline('2026-07-10', periodEndIso('2026-06'), '2026-07-10')).toBe('2026-07-10');
  });
  it('falls back to the computed rule for pre-CSV same-period placeholders', () => {
    // SPARK Q1 placeholder 3/31 is not after the 3/31 quarter end → computed.
    expect(resolveDeadline('2026-03-31', periodEndIso('2026-Q1'), '2026-04-10')).toBe('2026-04-10');
    // NEST Jan placeholder 1/31 is not after the 1/31 month end → computed.
    expect(resolveDeadline('2026-01-31', periodEndIso('2026-01'), '2026-02-13')).toBe('2026-02-13');
  });
  it('falls back when due_on is missing', () => {
    expect(resolveDeadline(null, periodEndIso('2026-06'), '2026-07-10')).toBe('2026-07-10');
  });
});

describe('toIsoDateOrNull', () => {
  it('keeps a valid date', () => {
    expect(toIsoDateOrNull('2026-07-05')).toBe('2026-07-05');
    expect(toIsoDateOrNull('2026-07-05 14:00')).toBe('2026-07-05');
  });
  it('rejects corrupt / empty values', () => {
    expect(toIsoDateOrNull('#C@9J&ikv$fU%!KF')).toBeNull();
    expect(toIsoDateOrNull('')).toBeNull();
    expect(toIsoDateOrNull(null)).toBeNull();
    expect(toIsoDateOrNull('not-a-date')).toBeNull();
  });
});
