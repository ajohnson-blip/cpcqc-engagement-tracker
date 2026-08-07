import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_BASE_URL: z.string().url().default('http://localhost:3001'),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  // Session length. The access token is a stateless JWT: it cannot be revoked
  // before it expires, so this is also the worst-case window after a logout in
  // which a stolen token still works. 8h keeps staff signed in for a full
  // workday; the refresh token (rotated on every use) is an IDLE timeout — an
  // active user's 45 days is continually reset.
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(28800), // 8 hours
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(45),

  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),

  SENDGRID_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().default('qi@cpcqc.org'),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  /**
   * Public base URL of the FRONTEND, used to build links people click in email
   * (password reset, account setup). Optional: defaults to the first
   * CORS_ORIGIN entry, which is by definition the frontend origin and is known
   * good in production — if it were wrong the browser app wouldn't work at all.
   *
   * Deliberately NOT APP_BASE_URL: that one is documented as the backend's own
   * URL, so a link built from it would 404. Set this only if the frontend is
   * reachable at an address that isn't the first CORS origin.
   */
  PUBLIC_APP_URL: z.string().url().optional(),

  // REDCap (Vanderbilt) integration. The API URL is shared across all CPCQC
  // REDCap projects; each project has its own per-project token. Tokens are
  // SECRETS — set them as Render environment variables, never in code.
  REDCAP_API_URL: z.string().url().default('https://redcap.vumc.org/api/'),
  REDCAP_SPARK_TOKEN: z.string().optional(),
  REDCAP_NEST_TOKEN: z.string().optional(),
  REDCAP_SOAR_TOKEN: z.string().optional(),
  // TtT uses TWO projects. The patient-level token is PHI — hospital-level
  // engagement only; never export/store patient identifiers.
  REDCAP_TTT_HOSPITAL_TOKEN: z.string().optional(),
  REDCAP_TTT_PATIENT_TOKEN: z.string().optional(),
  // Denver Health enters its TtT patient forms in a THIRD project — the CHoSEN
  // Dyadic project. Optional: when set, the TtT sync folds DH's eligible Dyadic
  // maternal forms into DH's patient-form counts so it stops false-flagging as a
  // linkage gap. Also PHI — we only ever count rows. REDCAP_TTT_DYADIC_DH_DAG is
  // DH's Data Access Group *in the Dyadic project* (its DAG spelling can differ
  // from the TtT projects); defaults to 'denver_health'.
  REDCAP_TTT_DYADIC_TOKEN: z.string().optional(),
  REDCAP_TTT_DYADIC_DH_DAG: z.string().default('denver_health'),
  // CHoSEN Dyadic is a different collaborative and may live on a different
  // REDCap instance than the CPCQC projects. Leave unset to reuse
  // REDCAP_API_URL; set it only if Dyadic is hosted elsewhere.
  REDCAP_TTT_DYADIC_API_URL: z.string().url().optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;

/**
 * zod's .url() delegates to `new URL()`, which accepts ANY scheme — so a typo
 * like "ttps://example.org" parses cleanly and then silently produces dead
 * links in email. Warn rather than throw: refusing to boot over a cosmetic URL
 * would take the whole service down for a link-formatting problem.
 */
function warnIfNotHttpUrl(name: string, value: string | undefined): void {
  if (!value) return;
  if (/^https?:\/\//i.test(value.trim())) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[env] ${name}="${value}" does not start with http:// or https://. ` +
      'Links built from it will not work. Check for a typo (e.g. "ttps://").',
  );
}
warnIfNotHttpUrl('APP_BASE_URL', env.APP_BASE_URL);
warnIfNotHttpUrl('PUBLIC_APP_URL', env.PUBLIC_APP_URL);
warnIfNotHttpUrl('CORS_ORIGIN', env.CORS_ORIGIN.split(',')[0]);

/**
 * Base URL for links a human clicks in an email. Always the frontend.
 * Trailing slash stripped so callers can safely append "/path".
 *
 * Note this ignores APP_BASE_URL by design — that is the backend's own origin,
 * so a link built from it lands on the API and 404s instead of the page.
 */
export function frontendBaseUrl(): string {
  const raw = env.PUBLIC_APP_URL ?? env.CORS_ORIGIN.split(',')[0];
  return raw.trim().replace(/\/+$/, '');
}
