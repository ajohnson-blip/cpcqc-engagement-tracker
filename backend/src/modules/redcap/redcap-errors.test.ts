import { describe, expect, it } from 'vitest';
import { describeBody, redcapErrorOrShape } from './redcap-errors.js';

/**
 * A realistic truncated patient-level response — the exact thing that used to
 * reach an exception message, and from there the service logs.
 */
const PATIENT_ROWS =
  '[{"record_id":"1041","redcap_data_access_group":"aspen_valley",' +
  '"delivery_date_1":"2026-03-14","sample_check_patient":"1","substances_used_2___1":"1"';

describe('describeBody', () => {
  it('never reproduces any of the body', () => {
    const out = describeBody(PATIENT_ROWS);
    for (const leak of ['1041', 'aspen_valley', '2026-03-14', 'substances_used_2', 'record_id']) {
      expect(out).not.toContain(leak);
    }
  });

  it('still says enough to diagnose a malformed JSON response', () => {
    expect(describeBody(PATIENT_ROWS)).toContain('JSON-like');
    expect(describeBody(PATIENT_ROWS)).toContain(String(PATIENT_ROWS.length));
  });

  it('names the usual real cause when the body is HTML', () => {
    // A proxy or SSO login page is the common reason REDCap "returns non-JSON".
    const out = describeBody('\n  <!doctype html><html><body>Sign in</body></html>');
    expect(out).toContain('HTML');
    expect(out).toContain('proxy');
    expect(out).not.toContain('Sign in');
  });

  it('handles an empty body', () => {
    expect(describeBody('')).toBe('empty response');
  });

  it('describes unrecognised content without quoting it', () => {
    const out = describeBody('BEGIN PGP MESSAGE hunter2');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('bytes');
  });
});

describe('redcapErrorOrShape', () => {
  it("surfaces REDCap's own error text, which is about the request, not the data", () => {
    expect(redcapErrorOrShape('{"error":"You do not have permission to use the API"}')).toBe(
      'You do not have permission to use the API',
    );
  });

  it('falls back to a content-free description when the body is not a REDCap error', () => {
    const out = redcapErrorOrShape(PATIENT_ROWS);
    expect(out).not.toContain('aspen_valley');
    expect(out).not.toContain('1041');
  });

  it('does not treat record data as an error message even if it parses', () => {
    // A well-formed array of records parses fine but has no `error` key, so it
    // must fall through to the description rather than being quoted.
    const parseable = '[{"record_id":"1041","delivery_date_1":"2026-03-14"}]';
    const out = redcapErrorOrShape(parseable);
    expect(out).not.toContain('1041');
    expect(out).not.toContain('2026-03-14');
  });

  it('ignores a non-string error field', () => {
    const out = redcapErrorOrShape('{"error":{"nested":"1041"}}');
    expect(out).not.toContain('1041');
  });
});
