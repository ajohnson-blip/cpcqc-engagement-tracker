-- Delete hospital_staff_members rows that are leftover garbage from the
-- pre-fix Enrollment Forms importer:
--
--   1. name = '[object Object]' — happened when a rich-text cell was
--      stringified before commit 36ebc66 fixed cellString().
--   2. name matches an email shape — happened when the importer used the
--      19-col positional layout against TTT's 14-col workbook (commit
--      36ebc66 header-driven mapping fixed that).
--   3. role / email cells that hold '[object Object]' from the same
--      cellString bug.
--
-- Re-running the workbook import via /staff/imports (which uses the fixed
-- code path) creates the correct rows alongside these; this migration just
-- drops the orphans so the hospital roster reads cleanly.
--
-- Scoped via OR predicates so it only touches genuinely-broken rows.
-- Idempotent.
DELETE FROM "hospital_staff_members"
WHERE
  "name" = '[object Object]'
  OR "role" = '[object Object]'
  OR "email" = '[object Object]'
  OR ("name" LIKE '%@%' AND "name" ~ '^\S+@\S+\.\S+$');
