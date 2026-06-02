-- enrollments.enrolled_on was set to "the day the PM ran auto-enroll" because
-- the script omitted enrolledOn and createEnrollment defaulted to today's
-- date. That date — e.g. May 21, 2026 — misrepresents when the hospital
-- actually enrolled, which is the cohort's start date (Jan 1, 2026 for every
-- current cohort).
--
-- Realign every row to its cohort.start_date. This is also the new default
-- in createEnrollment going forward, so future enrollments stay consistent
-- without needing this migration to be re-run.
UPDATE "enrollments" AS e
SET "enrolled_on" = c."start_date"
FROM "cohorts" c
WHERE e."cohort_id" = c."id"
  AND e."enrolled_on" <> c."start_date";
