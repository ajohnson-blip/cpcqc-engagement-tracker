-- 0004 set SPARK 2026 program_years.hra_schedule to ["Q3","Q4"], but the actual
-- business rule is Q2 + Q4. 0004 is already applied to production, so we correct
-- forward rather than editing the applied migration. Unconditional UPDATE keyed
-- on (initiative=SPARK, year=2026) so a fresh-DB run from 0004 → 0005 also lands
-- in the right place.
UPDATE "program_years" AS py
SET "hra_schedule" = '["Q2","Q4"]'::jsonb
FROM "enrollments" e, "cohorts" c, "initiatives" i
WHERE py."enrollment_id" = e."id"
  AND e."cohort_id" = c."id"
  AND c."initiative_id" = i."id"
  AND i."code" = 'SPARK'
  AND py."year" = 2026;
