-- Valley View Hospital was auto-enrolled in SOAR ACTIVE based on the CHA
-- master list (status2026: 'Active'), but the SOAR PM confirmed per the
-- PM workbook that they're enrolled in SOAR SUSTAINABILITY for 2026 (and
-- have been since Jan 1). The result is a duplicate listing on the SOAR
-- landing page — one active, one sustainability, both showing AT RISK.
--
-- Withdraw the wrong active enrollment so only the sustainability one
-- remains visible. The CHA master list is corrected in the same commit so
-- a future re-seed doesn't recreate it. Sustainability is already enrolled
-- so no restore step is needed.
--
-- Idempotent via the != 'withdrawn' guard.
UPDATE "enrollments" AS e
SET
  "status" = 'withdrawn',
  "withdrawn_on" = CURRENT_DATE,
  "notes" = COALESCE(e."notes" || E'\n', '')
            || 'Withdrawn ' || CURRENT_DATE
            || ': reclassified to SOAR sustainability per SOAR PM (see 0008).',
  "updated_at" = NOW()
FROM "hospitals" h, "cohorts" c, "initiatives" i
WHERE e."hospital_id" = h."id"
  AND e."cohort_id" = c."id"
  AND c."initiative_id" = i."id"
  AND h."name" = 'Valley View Hospital'
  AND i."code" = 'SOAR'
  AND c."track" = 'active'
  AND e."status" <> 'withdrawn';
