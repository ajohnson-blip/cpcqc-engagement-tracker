import { describe, expect, it } from 'vitest';
import { chaIdsMatch, normalizeCdpheId, normalizeChaId, stripFloatArtifact } from './identifiers.js';

describe('stripFloatArtifact', () => {
  it('removes the spreadsheet float suffix', () => {
    expect(stripFloatArtifact('632.0')).toBe('632');
    expect(stripFloatArtifact('931.00')).toBe('931');
  });

  it('leaves real values alone', () => {
    // "632b" is the tracker-only ID for UCHealth Memorial North.
    expect(stripFloatArtifact('632b')).toBe('632b');
    expect(stripFloatArtifact('01L581')).toBe('01L581');
    expect(stripFloatArtifact('NA')).toBe('NA');
  });

  it('never invents a value', () => {
    expect(stripFloatArtifact(null)).toBeNull();
    expect(stripFloatArtifact(undefined)).toBeNull();
    expect(stripFloatArtifact('   ')).toBeNull();
  });

  it('does not touch a decimal that is not a float artifact', () => {
    expect(stripFloatArtifact('632.5')).toBe('632.5');
  });
});

describe('normalizeCdpheId', () => {
  it('restores the leading zero a spreadsheet dropped', () => {
    // Confirmed against CDPHE's facility record for Memorial Central.
    expect(normalizeCdpheId('10542.0')).toBe('010542');
    expect(normalizeCdpheId('10444')).toBe('010444');
  });

  it('leaves correctly formatted IDs untouched', () => {
    expect(normalizeCdpheId('010441')).toBe('010441');
    expect(normalizeCdpheId('01A456')).toBe('01A456');
    expect(normalizeCdpheId('25017J')).toBe('25017J');
  });

  it('leaves placeholders and anything unexpected alone rather than guessing', () => {
    expect(normalizeCdpheId('NA')).toBe('NA');
    // Children's Hospital Colorado — the letter O may be a mistyped zero, but
    // that is for CPCQC to confirm with CDPHE, not for this to assume.
    expect(normalizeCdpheId('10O533')).toBe('10O533');
    // Longer than six characters means the padding assumption is wrong.
    expect(normalizeCdpheId('1234567')).toBe('1234567');
    expect(normalizeCdpheId(null)).toBeNull();
  });
});

describe('chaIdsMatch', () => {
  it('matches across the import formats, so a re-import still finds the hospital', () => {
    expect(chaIdsMatch('632.0', '632')).toBe(true);
    expect(chaIdsMatch('632', '632')).toBe(true);
    expect(chaIdsMatch('632B', '632b')).toBe(true);
  });

  it('does not match different hospitals, or treat missing as equal', () => {
    expect(chaIdsMatch('632', '633')).toBe(false);
    expect(chaIdsMatch('632', '632b')).toBe(false);
    expect(chaIdsMatch(null, null)).toBe(false);
    expect(chaIdsMatch('632', null)).toBe(false);
  });
});

describe('normalizeChaId', () => {
  it('is the float-artifact rule', () => {
    expect(normalizeChaId('502.0')).toBe('502');
    expect(normalizeChaId('632b')).toBe('632b');
  });
});
