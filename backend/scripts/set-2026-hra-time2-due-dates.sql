-- Move 2026 HRA time 2 from December 31 to December 1, every program.
--
-- Time 2 was generated as December 31: the task-template starter's due-date
-- rule reads "End of December", and the generic quarter-end date every
-- quarterly task gets agreed with it. The official deadline sheet ("CPCQC QI
-- Data Deadlines 2026-2027") lists data submissions only, so nothing had
-- corrected it. A SOAR QI advisor flagged it; CPCQC confirmed December 1 for
-- all programs on 2026-09-10.
--
-- The generation rule now encodes this (hraDueDate in
-- src/modules/compliance/hra.ts), so 2027 onward is created correctly. This is
-- the one-off correction for the 2026 rows that already exist; the deploy-time
-- backfill only INSERTS missing task instances, so it will not undo it.
--
-- Scope: readiness_assessment tasks, program year 2026, period 2026-Q4, still
-- on the old default date. Guarded on due_on = 2026-12-31 so it is idempotent
-- and cannot overwrite a date someone set deliberately. At time of writing: 74
-- rows (TtT 24, SPARK 11, SOAR active 16, SOAR sustainability 14, NEST 9), none
-- complete, none finalized. updated_by is left alone so nothing reads this as
-- a human edit to the task.
--
-- Applied to prod 2026-09-10: 74 rows updated; the 74 time-1 rows were verified
-- untouched. Re-runnable (the due_on guard makes a second run a no-op).
--   psql "$DATABASE_URL" -f scripts/set-2026-hra-time2-due-dates.sql

UPDATE task_instances ti
SET due_on = DATE '2026-12-01',
    updated_at = now()
FROM task_templates tt, program_years py
WHERE ti.task_template_id = tt.id
  AND ti.program_year_id = py.id
  AND tt.task_type = 'readiness_assessment'
  AND py.year = 2026
  AND ti.period = '2026-Q4'
  AND ti.due_on = DATE '2026-12-31';
