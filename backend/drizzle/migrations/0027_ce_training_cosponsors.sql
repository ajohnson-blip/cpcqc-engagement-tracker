-- Co-sponsor logos for CE certificates.
--
-- A training already carries its host program's logo and CPCQC's. Some are
-- co-sponsored with an outside organisation — Connecting the Dots with CU
-- Anschutz — and that organisation's mark belongs on the certificate too.
--
-- An array rather than a single column: co-sponsorship is not inherently
-- limited to one partner, and a second column would be the wrong shape the
-- first time a training had two.
ALTER TABLE ce_trainings
  ADD COLUMN IF NOT EXISTS co_sponsor_logo_codes jsonb NOT NULL DEFAULT '[]'::jsonb;
