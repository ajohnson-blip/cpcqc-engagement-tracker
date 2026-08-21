-- Per-participant completion date.
--
-- Asynchronous courses (IMPACT BH runs one) are completed on different days by
-- different people, so the training's single date is wrong on those
-- certificates. NULL means "use the training date", which is correct for the
-- live sessions that make up most of the catalogue.
ALTER TABLE "ce_certificates"
  ADD COLUMN IF NOT EXISTS "completion_date" date;
