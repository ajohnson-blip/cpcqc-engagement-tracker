ALTER TABLE "program_years" ADD COLUMN IF NOT EXISTS "hra_schedule" jsonb;--> statement-breakpoint
-- Backfill the SPARK 2026 one-off schedule (HRAs due Q3 + Q4 instead of Q1 + Q4)
-- onto existing program-year rows. New rows get this set at creation time.
UPDATE "program_years" AS py
SET "hra_schedule" = '["Q3","Q4"]'::jsonb
FROM "enrollments" e, "cohorts" c, "initiatives" i
WHERE py."enrollment_id" = e."id"
  AND e."cohort_id" = c."id"
  AND c."initiative_id" = i."id"
  AND i."code" = 'SPARK'
  AND py."year" = 2026
  AND py."hra_schedule" IS NULL;
