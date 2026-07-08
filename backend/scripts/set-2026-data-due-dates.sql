-- Set the 2026 data-submission task due dates to CPCQC's official deadlines.
--
-- Source: "CPCQC QI Data Deadlines 2026-2027" (column B "Start Date"). These
-- are year-specific and change next year, so this is a one-off DATA update
-- (not part of the auto-generated due-date rule and NOT a repeating migration).
-- The deploy-time backfill only INSERTS missing task instances, so it never
-- overwrites these updated due_on values.
--
-- Scope: only the periods present in the CSV (June 2026 data onward; SPARK
-- Q2-Q4). SPARK Q1 and the Jan-May monthly deadlines already passed and aren't
-- in the CSV, and SOAR sustainability (quarterly) isn't in the CSV — all left
-- as-is. SPARK is quarterly; NEST/SOAR/TTT active are monthly.
--
-- Applied to prod 2026-07-xx (376 task instances). Re-runnable (idempotent).
--   psql "$DATABASE_URL" -f scripts/set-2026-data-due-dates.sql

WITH d(code, track, period, due) AS (
  VALUES
    ('SPARK','active','2026-Q2', DATE '2026-07-07'),
    ('SPARK','active','2026-Q3', DATE '2026-10-07'),
    ('SPARK','active','2026-Q4', DATE '2027-01-07'),
    ('SOAR','active','2026-06', DATE '2026-07-10'),
    ('SOAR','active','2026-07', DATE '2026-08-14'),
    ('SOAR','active','2026-08', DATE '2026-09-11'),
    ('SOAR','active','2026-09', DATE '2026-10-09'),
    ('SOAR','active','2026-10', DATE '2026-11-13'),
    ('SOAR','active','2026-11', DATE '2026-12-11'),
    ('SOAR','active','2026-12', DATE '2027-01-08'),
    ('NEST','active','2026-06', DATE '2026-07-10'),
    ('NEST','active','2026-07', DATE '2026-08-14'),
    ('NEST','active','2026-08', DATE '2026-09-11'),
    ('NEST','active','2026-09', DATE '2026-10-09'),
    ('NEST','active','2026-10', DATE '2026-11-13'),
    ('NEST','active','2026-11', DATE '2026-12-11'),
    ('NEST','active','2026-12', DATE '2027-01-08'),
    ('TTT','active','2026-06', DATE '2026-07-17'),
    ('TTT','active','2026-07', DATE '2026-08-21'),
    ('TTT','active','2026-08', DATE '2026-09-18'),
    ('TTT','active','2026-09', DATE '2026-10-16'),
    ('TTT','active','2026-10', DATE '2026-11-20'),
    ('TTT','active','2026-11', DATE '2026-12-18'),
    ('TTT','active','2026-12', DATE '2027-01-22')
)
UPDATE task_instances ti
SET due_on = d.due, updated_at = now(), updated_by = 'due-date-2026'
FROM task_templates t, initiatives i, enrollments e, cohorts co, program_years py, d
WHERE ti.task_template_id = t.id AND t.initiative_id = i.id
  AND ti.enrollment_id = e.id AND e.cohort_id = co.id
  AND ti.program_year_id = py.id
  AND t.task_type = 'data_submission' AND py.year = 2026
  AND i.code::text = d.code AND co.track::text = d.track AND ti.period = d.period;
