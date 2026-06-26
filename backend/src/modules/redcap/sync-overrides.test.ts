import { describe, expect, it } from 'vitest';
import { dispositionToTask, categoryToDisposition } from './sync-overrides.js';

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
