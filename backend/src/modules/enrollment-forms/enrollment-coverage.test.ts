import { describe, expect, it } from 'vitest';
import { computeCoverage } from './enrollment-coverage.js';

const NAMES: Record<string, string> = {
  'ex-001': 'Example Valley Hospital',
  'ex-002': 'Example Mountain Medical Center',
  'ex-003': 'Example Plains Health',
};
const nameOf = (id: string) => NAMES[id] ?? 'Unknown hospital';
const codes = ['SPARK', 'SOAR', 'NEST', 'TTT'] as const;

describe('computeCoverage', () => {
  it('expects accepted hospitals and continuing TtT hospitals', () => {
    const [spark, , , ttt] = computeCoverage({
      codes,
      filed: [{ hospitalId: 'ex-001', initiativeCode: 'SPARK' }],
      accepted: [
        { hospitalId: 'ex-001', decidedInitiatives: ['SPARK'] },
        { hospitalId: 'ex-002', decidedInitiatives: ['SPARK', 'NEST'] },
        { hospitalId: 'ex-003', decidedInitiatives: null },
      ],
      tttContinuing: ['ex-003'],
      sent: [],
      nameOf,
    });
    expect(spark!.expected.map((h) => h.id)).toEqual(['ex-002', 'ex-001']);
    expect(spark!.submittedCount).toBe(1);
    expect(spark!.outstanding).toEqual([{ id: 'ex-002', name: 'Example Mountain Medical Center' }]);
    expect(ttt!.outstanding.map((h) => h.id)).toEqual(['ex-003']);
  });

  it('expects a hospital staff sent the form to, though it has no interest form', () => {
    // Without the send, its filed form would count as unexpected and an unfiled
    // one would never show as outstanding.
    const [, soar, nest] = computeCoverage({
      codes,
      filed: [{ hospitalId: 'ex-003', initiativeCode: 'SOAR' }],
      accepted: [],
      tttContinuing: [],
      sent: [
        { hospitalId: 'ex-003', initiativeCode: 'SOAR' },
        { hospitalId: 'ex-003', initiativeCode: 'NEST' },
        { hospitalId: 'ex-003', initiativeCode: 'NEST' },
      ],
      nameOf,
    });
    expect(soar!.submittedCount).toBe(1);
    expect(soar!.unexpectedCount).toBe(0);
    expect(nest!.expected).toEqual([{ id: 'ex-003', name: 'Example Plains Health' }]);
    expect(nest!.outstanding.map((h) => h.id)).toEqual(['ex-003']);
  });

  it('counts a form nobody expected without adding it to the expected list', () => {
    const [spark] = computeCoverage({
      codes,
      filed: [{ hospitalId: 'ex-002', initiativeCode: 'SPARK' }],
      accepted: [],
      tttContinuing: [],
      sent: [],
      nameOf,
    });
    expect(spark!.expected).toEqual([]);
    expect(spark!.unexpectedCount).toBe(1);
  });
});
