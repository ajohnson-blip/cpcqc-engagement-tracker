/**
 * Thin REDCap (Vanderbilt) API client. One method we need today: export the
 * flat records for a form. Uses native fetch (same pattern as the SendGrid
 * client). Tokens are per-project secrets supplied by the caller — never logged.
 */
import { env } from '@/config/env.js';
import { logger } from '@/config/logger.js';
import type { RedcapRow } from './spark-engagement.js';

export interface ExportRecordsOptions {
  token: string;
  /** Restrict to one instrument, e.g. 'quarterly_measures'. */
  form?: string;
  /** Defaults to env.REDCAP_API_URL. */
  apiUrl?: string;
}

/**
 * Export records as a flat JSON array. Includes the Data Access Group on each
 * row (exportDataAccessGroups=true) so callers can map rows → hospitals.
 * Throws on transport errors or a REDCap-level `{ error }` payload.
 */
export async function exportRecords(opts: ExportRecordsOptions): Promise<RedcapRow[]> {
  const apiUrl = opts.apiUrl ?? env.REDCAP_API_URL;
  const body = new URLSearchParams({
    token: opts.token,
    content: 'record',
    format: 'json',
    type: 'flat',
    returnFormat: 'json',
    exportDataAccessGroups: 'true',
    rawOrLabel: 'raw',
  });
  // Always request the record-ID field explicitly. In longitudinal projects the
  // record-ID field lives on the FIRST instrument, so a forms-only export omits
  // both record_id and redcap_event_name. Asking for record_id by name brings
  // the structural columns (record_id, redcap_event_name, DAG) back; REDCap then
  // returns the UNION of the named field and every field on the named form.
  body.append('fields[0]', 'record_id');
  if (opts.form) body.append('forms[0]', opts.form);

  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    logger.error({ err }, 'REDCap request failed (transport)');
    throw new Error(
      `Could not reach REDCap at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    // REDCap returns errors as JSON {error: "..."} even with non-2xx in some cases.
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: string };
      if (j.error) detail = j.error;
    } catch {
      /* keep raw text */
    }
    throw new Error(`REDCap export failed (HTTP ${res.status}): ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`REDCap returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw new Error(`REDCap error: ${(parsed as { error: string }).error}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('REDCap export did not return an array of records.');
  }
  return parsed as RedcapRow[];
}
