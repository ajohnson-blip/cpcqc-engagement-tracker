-- Restore Valley View Hospital's SOAR sustainability 2026 enrollment.
--
-- Backstory: an earlier run of scripts/fix-southwest-soar-track.ts (when
-- Valley View was in its hospital list) withdrew Valley View's
-- sustainability enrollment and created an active one. Then migration
-- 0008 withdrew that active enrollment when we learned Valley View should
-- be sustainability, and migration 0009 deleted ALL withdrawn rows. Net
-- effect: Valley View has NO SOAR enrollment at all, which is wrong —
-- per the SOAR PM workbook they are enrolled in SOAR sustainability for
-- 2026 (since Jan 1).
--
-- Insert the enrollment row + the 2026 program_year row, copying the
-- requirement thresholds from initiative_track_config exactly the way
-- enrollments.service.ts would. The post-deploy backfill-task-instances
-- step (per render.yaml) creates the matching TaskInstance rows.
--
-- Idempotent via NOT EXISTS guards.

-- Step 1: enrollment row.
INSERT INTO "enrollments" (
  "id", "hospital_id", "cohort_id", "status", "enrolled_on",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  h."id",
  c."id",
  'enrolled',
  c."start_date",
  NOW(),
  NOW()
FROM "hospitals" h
CROSS JOIN "cohorts" c
INNER JOIN "initiatives" i ON i."id" = c."initiative_id"
WHERE h."name" = 'Valley View Hospital'
  AND i."code" = 'SOAR'
  AND c."track" = 'sustainability'
  AND EXTRACT(YEAR FROM c."start_date") = 2026
  AND NOT EXISTS (
    SELECT 1 FROM "enrollments" e
    WHERE e."hospital_id" = h."id" AND e."cohort_id" = c."id"
  );

-- Step 2: program_year row for 2026 (gets requirement thresholds from
-- initiative_track_config). SOAR sustainability uses the default Q1+Q4
-- HRA schedule (hra_schedule = NULL).
INSERT INTO "program_years" (
  "id", "enrollment_id", "year",
  "required_meetings", "required_advising", "required_data_periods",
  "data_submissions_min", "required_assessments", "hra_schedule",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  e."id",
  2026,
  itc."required_meetings",
  itc."required_advising",
  itc."required_data_periods",
  itc."data_submissions_min",
  itc."required_assessments",
  NULL,
  NOW(),
  NOW()
FROM "enrollments" e
INNER JOIN "cohorts" c ON c."id" = e."cohort_id"
INNER JOIN "initiatives" i ON i."id" = c."initiative_id"
INNER JOIN "hospitals" h ON h."id" = e."hospital_id"
INNER JOIN "initiative_track_config" itc
  ON itc."initiative_id" = i."id" AND itc."track" = c."track"
WHERE h."name" = 'Valley View Hospital'
  AND i."code" = 'SOAR'
  AND c."track" = 'sustainability'
  AND e."status" = 'enrolled'
  AND NOT EXISTS (
    SELECT 1 FROM "program_years" py
    WHERE py."enrollment_id" = e."id" AND py."year" = 2026
  );
