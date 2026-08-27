-- Undo 0024: per-initiative acceptance already had a home.
--
-- 0024 added accepted_initiatives alongside the older decided_initiatives,
-- which stores the same thing — the initiative codes a hospital was accepted
-- into. Two columns with one meaning is a trap: bulk-accept, the XLSX export,
-- the acceptance email and the hospital's own portal view all read
-- decided_initiatives, so a checkbox UI written against accepted_initiatives
-- would have disagreed with the badge beside it.
--
-- Safe to drop outright: no UI ever wrote these, and every environment has
-- them empty (verified in production before writing this).
ALTER TABLE "annual_interest_forms"
  DROP COLUMN IF EXISTS "accepted_initiatives",
  DROP COLUMN IF EXISTS "acceptance_decided_at",
  DROP COLUMN IF EXISTS "acceptance_decided_by";
