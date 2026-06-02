-- Add 'not_submitted' to the task_outcome enum so PMs can distinguish
-- "submitted but late" from "never submitted" for data_submission and
-- readiness_assessment tasks. Compliance counting already only rewards
-- on_time / attended, so the new value naturally doesn't count toward
-- thresholds — no engine change required.
ALTER TYPE "task_outcome" ADD VALUE IF NOT EXISTS 'not_submitted';
