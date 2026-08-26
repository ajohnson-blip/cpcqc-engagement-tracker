-- Which initiatives a hospital is accepted into.
--
-- The form-level status (submitted/accepted/declined) can't answer "send this
-- hospital a SPARK enrollment form but not a NEST one" — acceptance is per
-- initiative, and enrollment forms go out per initiative. Stored as JSONB
-- because it is always read and written whole, and the initiative list changes
-- between years.
ALTER TABLE "annual_interest_forms"
  ADD COLUMN IF NOT EXISTS "accepted_initiatives" jsonb,
  ADD COLUMN IF NOT EXISTS "acceptance_decided_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "acceptance_decided_by" text;
