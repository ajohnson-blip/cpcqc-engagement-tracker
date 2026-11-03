-- Open the 2027 enrollment step early: forms accepted from 2026-11-05 through
-- 2026-12-01, the date Colorado law sets. CPCQC decided on 2026-11-03 to open
-- on the 5th so the welcome-to-enroll emails can go out then; the upload that
-- sends them refuses to until the step is open.
--
-- The 2027 row has existed since 0016 (it holds the interest-form window
-- too), so this only moves the enrollment-step dates. Running it twice
-- changes nothing.
UPDATE "enrollment_windows"
SET "enrollment_opens_at" = '2026-11-05',
    "enrollment_closes_at" = '2026-12-01',
    "updated_at" = now()
WHERE "program_year" = 2027;
