-- Backfill task_instances.staff_note from the legacy payload.notes location.
--
-- Background: the Manage Task modal used to write the user's note into the
-- per-type JSONB payload (`payload.notes`) instead of the dedicated
-- `staff_note` column. The commit that introduced the Notes column
-- (3fa0030) made the modal also write to staff_note going forward and the
-- read paths fall back to payload.notes for back-compat.
--
-- That fallback created a follow-on bug: clearing the Notes field in the
-- modal would null out staff_note but leave payload.notes intact, so the
-- table reader would fall back to the stale value and the note would
-- appear to "stick" even after the user cleared it. Fixing that requires
-- removing the read fallback, which requires backfilling staff_note first
-- so we don't blank out notes saved before the new write path existed.
--
-- Scope: only rows where staff_note IS NULL and payload->>'notes' is a
-- non-empty string. Idempotent: re-runs find nothing to update.

UPDATE "task_instances"
SET "staff_note" = "payload"->>'notes'
WHERE "staff_note" IS NULL
  AND "payload" IS NOT NULL
  AND "payload" ? 'notes'
  AND NULLIF(TRIM("payload"->>'notes'), '') IS NOT NULL;
