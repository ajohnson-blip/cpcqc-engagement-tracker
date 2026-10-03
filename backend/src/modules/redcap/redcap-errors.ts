/**
 * Content-free descriptions of REDCap responses, for error messages.
 *
 * Pure and dependency-free so it can be unit tested: redcap.client.ts reaches
 * `@/config/env.js`, and the `@/` alias does not resolve under vitest.
 */

/**
 * Describe a response body without reproducing any of it.
 *
 * These clients talk to patient-level projects, so an error message must never
 * echo the body: a malformed 200 would otherwise put the first bytes of the
 * record array into an exception, and from there into service logs. Render's
 * HIPAA terms prohibit PHI in logs outright, so this is a contractual
 * requirement and not only good hygiene.
 *
 * The shape is still enough to diagnose the realistic failures. An HTML body
 * nearly always means a proxy or SSO login page intercepted the call, which is
 * the usual cause of a non-JSON response from REDCap.
 */
export function describeBody(text: string): string {
  const bytes = text.length;
  const first = text.trimStart().charAt(0);
  if (first === '<') return `${bytes} bytes of HTML — a proxy or login page probably intercepted the request`;
  if (first === '{' || first === '[') return `${bytes} bytes of JSON-like content that failed to parse`;
  if (bytes === 0) return 'empty response';
  return `${bytes} bytes of unrecognised content`;
}

/**
 * REDCap reports its own failures as {"error": "..."} — that text is a message
 * about the request (bad token, bad parameter), never record data, so it is
 * safe to surface. Anything else is described, not quoted.
 */
export function redcapErrorOrShape(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string };
    if (typeof j.error === 'string' && j.error) return j.error;
  } catch {
    /* fall through to a content-free description */
  }
  return describeBody(text);
}
