-- Delete the redundant "Q1 early" QI advising template for SOAR
-- sustainability hospitals, plus every TaskInstance that template spawned.
--
-- Background: bi-annual QI 1:1 advising means one session in the first half
-- of the year (deadline Jun 30 / Q2) and one in the second half (deadline
-- Dec 31 / Q4) — TWO tasks per year, not three. An "early" Q1 placeholder
-- template snuck into task_templates_starter.xlsx and produced an extra
-- Q1 task instance per SOAR sustainability hospital, even though the
-- compliance engine never counted it toward the required 2 of 2.
--
-- The compliance verdict (defaultAdvisingQuarters(2) → ['Q2','Q4']) was
-- already correct — this migration just removes the stray UI row.
--
-- Idempotent: re-runs find nothing.

WITH ttt AS (
  SELECT id
  FROM "task_templates"
  WHERE "track" = 'sustainability'
    AND "task_type" = 'qi_advising'
    AND "period_label" = 'Q1'
    AND "name" ILIKE '%early%'
    AND "initiative_id" = (SELECT id FROM "initiatives" WHERE code = 'SOAR')
)
DELETE FROM "task_instances"
WHERE "task_template_id" IN (SELECT id FROM ttt);

DELETE FROM "task_templates"
WHERE "track" = 'sustainability'
  AND "task_type" = 'qi_advising'
  AND "period_label" = 'Q1'
  AND "name" ILIKE '%early%'
  AND "initiative_id" = (SELECT id FROM "initiatives" WHERE code = 'SOAR');
