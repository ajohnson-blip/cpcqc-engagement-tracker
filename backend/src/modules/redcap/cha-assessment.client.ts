/**
 * HTTP client for the CHA assessment service.
 *
 * Shapes and validation live in cha-assessment.ts, which is pure; this file
 * owns the network call and the environment.
 *
 * The call is idempotent — it computes and returns, writing nothing — so a
 * failed attempt is retried. Error messages describe a response, never quote
 * it: the service is careful not to send record content, but an error path is
 * exactly where that assumption would be worth not relying on.
 */
import { env } from '@/config/env.js';
import { HttpError } from '@/middleware/errors.js';
import { logger } from '@/config/logger.js';
import { CONTRACT_VERSION, assessErrorSchema, parseAssessResponse, type AssessResponse } from './cha-assessment.js';

export interface AssessOptions {
  program: 'SPARK' | 'NEST' | 'SOAR' | 'TTT';
  programYear: number;
  periods?: string[];
  eligibilityMode?: 'derived' | 'explicit' | 'either';
}

export function chaAssessmentConfigured(): boolean {
  return Boolean(env.CHA_ASSESSMENT_URL && env.CHA_ASSESSMENT_TOKEN);
}

/** Describe a body without reproducing it. */
function describe(text: string): string {
  const n = text.length;
  const head = text.trimStart().charAt(0);
  if (head === '<') return `${n} bytes of HTML — a proxy or login page probably intercepted the request`;
  if (head === '{' || head === '[') return `${n} bytes of JSON-like content that failed to parse`;
  if (n === 0) return 'empty response';
  return `${n} bytes of unrecognised content`;
}

/** The service's own error text is about the request, never record data. */
function errorOrShape(text: string): string {
  try {
    const parsed = assessErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.error.message;
  } catch {
    /* fall through */
  }
  return describe(text);
}

const RETRYABLE = new Set([502, 503, 504]);

export async function fetchAssessment(opts: AssessOptions): Promise<AssessResponse> {
  if (!chaAssessmentConfigured()) {
    throw new HttpError(
      503,
      'The CHA assessment service is not configured on this environment (CHA_ASSESSMENT_URL / CHA_ASSESSMENT_TOKEN).',
    );
  }
  const url = `${env.CHA_ASSESSMENT_URL!.replace(/\/+$/, '')}/v1/engagement/assess`;
  const body = JSON.stringify({
    contract_version: CONTRACT_VERSION,
    program: opts.program,
    program_year: opts.programYear,
    ...(opts.periods?.length ? { periods: opts.periods } : {}),
    ...(opts.eligibilityMode ? { options: { eligibility_mode: opts.eligibilityMode } } : {}),
  });

  let lastError = '';
  // Three attempts: the call is idempotent, and a transient REDCap timeout at
  // CHA's end should not make a program manager re-run the whole sync.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.CHA_ASSESSMENT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.CHA_ASSESSMENT_TOKEN}`,
        },
        body,
        signal: controller.signal,
      });
      const text = await res.text();

      if (!res.ok) {
        const detail = errorOrShape(text);
        if (RETRYABLE.has(res.status) && attempt < 3) {
          lastError = `HTTP ${res.status}: ${detail}`;
          logger.warn({ attempt, status: res.status }, 'CHA assessment retrying');
          await new Promise((r) => setTimeout(r, attempt * 2000));
          continue;
        }
        // 401/403/400 are configuration or contract problems; retrying a
        // rejected token just delays the person finding out.
        throw new HttpError(502, `Assessment service returned HTTP ${res.status}: ${detail}`);
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new HttpError(502, `Assessment service returned non-JSON: ${describe(text)}`);
      }
      return parseAssessResponse(raw);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      lastError = aborted
        ? `timed out after ${env.CHA_ASSESSMENT_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      if (attempt === 3) break;
      logger.warn({ attempt, err: lastError }, 'CHA assessment retrying');
      await new Promise((r) => setTimeout(r, attempt * 2000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(502, `Could not reach the assessment service after 3 attempts: ${lastError}`);
}
