-- Finalize/lock support for the REDCap sync. When finalized_at is set, the
-- sync leaves the task alone (no recompute, no overwrite). Set per month via
-- the sync's Finalize control; finalized_by records who locked it.
ALTER TABLE "task_instances" ADD COLUMN IF NOT EXISTS "finalized_at" timestamptz;
ALTER TABLE "task_instances" ADD COLUMN IF NOT EXISTS "finalized_by" text;
