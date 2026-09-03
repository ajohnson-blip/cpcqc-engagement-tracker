-- Cohort tags: arbitrary groupings of hospitals CPCQC reports on as a set.
--
-- Built generic rather than as a scholarship_recipient boolean because the
-- reporting need is not specific to scholarships — funders ask about whichever
-- group they funded, and CPCQC already thinks in cohorts that cut across
-- initiatives (rural, safety-net, a particular grant's recipients). A column
-- per grant would mean a migration per grant.
--
-- The tag is the display label, stored as typed and trimmed, so it reads
-- correctly in a grant report without a lookup table. Matching is
-- case-insensitive so "Scholarship recipient" and "scholarship recipient"
-- cannot become two cohorts.
CREATE TABLE IF NOT EXISTS "hospital_tags" (
  "hospital_id" text NOT NULL,
  "tag" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hospital_tags_pk" PRIMARY KEY ("hospital_id", "tag")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hospital_tags" ADD CONSTRAINT "hospital_tags_hospital_id_fk"
   FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hospital_tags_tag_idx" ON "hospital_tags" (lower("tag"));
--> statement-breakpoint
-- One cohort per hospital per label, regardless of how it was capitalised.
CREATE UNIQUE INDEX IF NOT EXISTS "hospital_tags_hospital_lower_tag_uniq"
  ON "hospital_tags" ("hospital_id", lower("tag"));
--> statement-breakpoint
-- Seed the 2026 scholarship recipients. Matched by name against the unique
-- hospitals_name_idx; a name that does not match simply inserts nothing rather
-- than failing the migration, since the roster differs between environments.
INSERT INTO "hospital_tags" ("hospital_id", "tag")
SELECT h.id, 'Scholarship recipient'
FROM "hospitals" h
WHERE h.name IN (
  'Denver Health Medical Center',
  'Gunnison Valley Health',
  'Montrose Regional Health',
  'San Luis Valley Health'
)
ON CONFLICT DO NOTHING;
