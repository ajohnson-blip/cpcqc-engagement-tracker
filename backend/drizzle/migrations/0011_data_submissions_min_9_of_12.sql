-- Active monthly cohorts require at least 9 of 12 monthly data submissions —
-- same rule as meetings ("at least 9 of 12 available"). The seed had
-- previously set dataSubmissionsMin = 12 on the assumption that all 12
-- months were required; correct existing rows so monthly active enrollments
-- aren't held to a stricter standard than policy.
--
-- Scope: only rows where required_data_periods = 12 AND data_submissions_min
-- = 12 (the wrong-by-12 case). SPARK quarterly (4 / 3) and sustainability
-- annual (1 / 1) and any other configured value are untouched.
UPDATE "initiative_track_config"
SET "data_submissions_min" = 9, "updated_at" = NOW()
WHERE "required_data_periods" = 12 AND "data_submissions_min" = 12;

UPDATE "program_years"
SET "data_submissions_min" = 9, "updated_at" = NOW()
WHERE "required_data_periods" = 12 AND "data_submissions_min" = 12;
