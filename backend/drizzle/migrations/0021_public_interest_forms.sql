-- Public (accountless) interest-form submission.
--
-- Interest forms were portal-only, which meant a submission was provably from
-- someone holding that hospital's login — the form never had to ask which
-- hospital you were. CPCQC needs people without accounts to submit, so identity
-- now comes from a verified email address instead.
--
-- verification_token_hash: SHA-256 of a token emailed to the submitter. Clicking
-- it confirms the submission AND is the only way to edit it later, so a stranger
-- who guesses a hospital name cannot overwrite that hospital's real entry — the
-- unique index on (program_year, hospital_id) means an unguarded public write
-- would otherwise replace it silently.
--
-- Nullable throughout: existing rows and signed-in submissions have no token and
-- are verified implicitly by their login.
ALTER TABLE "annual_interest_forms"
  ADD COLUMN IF NOT EXISTS "verification_token_hash" text,
  ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone,
  -- How the submitter was identified, for staff triage: a portal login is
  -- self-evidently that hospital; a public submission is only as good as the
  -- email behind it.
  ADD COLUMN IF NOT EXISTS "submitted_via" text NOT NULL DEFAULT 'portal';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annual_interest_forms_verification_idx"
  ON "annual_interest_forms" ("verification_token_hash");
--> statement-breakpoint
-- Everything already in the table came through the portal while signed in.
UPDATE "annual_interest_forms"
  SET "verified_at" = COALESCE("verified_at", "created_at"),
      "submitted_via" = 'portal'
  WHERE "verified_at" IS NULL;
