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
  /** Restrict to several instruments (e.g. NEST's two repeating forms). */
  forms?: string[];
  /** Defaults to env.REDCAP_API_URL. */
  apiUrl?: string;
  /** Force-request the `record_id` field so longitudinal form-only exports keep
   *  their structural columns (default true). Set false for projects whose
   *  record-ID field isn't named `record_id` — e.g. the CHoSEN Dyadic project,
   *  where naming a missing field would make REDCap reject the whole export. */
  includeRecordId?: boolean;
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
  if (opts.includeRecordId !== false) {
    body.append('fields[0]', 'record_id');
  }
  const formList = [...(opts.form ? [opts.form] : []), ...(opts.forms ?? [])];
  formList.forEach((f, i) => body.append(`forms[${i}]`, f));

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

/** POST a content=<kind> request and return the parsed JSON array. */
async function postJsonArray(
  apiUrl: string,
  body: URLSearchParams,
  what: string,
): Promise<Array<Record<string, string>>> {
  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    logger.error({ err, what }, 'REDCap request failed (transport)');
    throw new Error(
      `Could not reach REDCap at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`REDCap ${what} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`REDCap ${what} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'error' in parsed) {
    throw new Error(`REDCap ${what} error: ${(parsed as { error: string }).error}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`REDCap ${what} did not return an array.`);
  return parsed as Array<Record<string, string>>;
}

/**
 * Export the data dictionary. TtT derives its required-field list from this
 * (required_field='y', minus @HIDDEN/retired) rather than hard-coding ~40 fields.
 */
export async function exportMetadata(opts: { token: string; apiUrl?: string }): Promise<
  Array<Record<string, string>>
> {
  const apiUrl = opts.apiUrl ?? env.REDCAP_API_URL;
  const body = new URLSearchParams({
    token: opts.token,
    content: 'metadata',
    format: 'json',
    returnFormat: 'json',
  });
  return postJsonArray(apiUrl, body, 'metadata export');
}

/**
 * Export the record-level audit log. TtT takes a report's submission time from
 * the "Create Record" entry (no @TODAY field on the monthly hospital form).
 */
export async function exportLog(opts: {
  token: string;
  /** e.g. "2026-01-01 00:00" — REDCap wants 'YYYY-MM-DD HH:MM'. */
  beginTime?: string;
  apiUrl?: string;
}): Promise<Array<Record<string, string>>> {
  const apiUrl = opts.apiUrl ?? env.REDCAP_API_URL;
  const body = new URLSearchParams({
    token: opts.token,
    content: 'log',
    logtype: 'record',
    format: 'json',
    returnFormat: 'json',
  });
  if (opts.beginTime) body.append('beginTime', opts.beginTime);
  return postJsonArray(apiUrl, body, 'log export');
}
