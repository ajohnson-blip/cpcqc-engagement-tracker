-- Step 2 of annual enrollment: the legally mandated enrollment form.
--
-- One row per (program_year, hospital, initiative) — a hospital enrolling in
-- two initiatives files two forms, which is why the champion roster is captured
-- per form rather than per hospital: CPCQC confirmed champions often differ
-- between initiatives.
--
-- Identity mirrors the public interest form: no account required, confirmed by
-- an emailed token which is also the only way to edit afterwards. The unique
-- index means an unguarded public write could otherwise replace a hospital's
-- real enrollment — and this is the record that satisfies the statute, so a
-- silent overwrite would be considerably worse here than on the interest form.
--
-- champions is JSONB rather than its own table: it is always read and written
-- whole, never queried across hospitals, and the shape (which roles exist, what
-- access each needs) is still settling.
CREATE TABLE IF NOT EXISTS "enrollment_forms" (
  "id" text PRIMARY KEY NOT NULL,
  "program_year" integer NOT NULL,
  "hospital_id" text NOT NULL,
  "initiative_code" text NOT NULL,
  "ehr" text,
  "ehr_other" text,
  -- [{ role, name, email, title, isPrimary, redcapAccess, dashboardAccess }]
  "champions" jsonb,
  -- TtT hospitals continue a two-year cohort; they attest rather than enroll,
  -- so the champion roster is not collected and this is the whole submission.
  "ttt_continuation_attested" boolean NOT NULL DEFAULT false,
  "submitter_name" text NOT NULL,
  "submitter_role" text NOT NULL,
  "submitter_email" text NOT NULL,
  "submitter_user_id" text,
  "verification_token_hash" text,
  "verified_at" timestamp with time zone,
  "submitted_via" text NOT NULL DEFAULT 'public',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_forms" ADD CONSTRAINT "enrollment_forms_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_forms" ADD CONSTRAINT "enrollment_forms_submitter_user_id_users_id_fk" FOREIGN KEY ("submitter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "enrollment_forms_year_hospital_initiative_uniq"
  ON "enrollment_forms" ("program_year", "hospital_id", "initiative_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrollment_forms_year_idx" ON "enrollment_forms" ("program_year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrollment_forms_verification_idx" ON "enrollment_forms" ("verification_token_hash");
--> statement-breakpoint
-- The enrollment step has its own dates (Nov 15 - Dec 1) distinct from the
-- interest window (Sep 15 - Oct 15) already held in this table. NULL means the
-- enrollment step simply isn't open for that year.
ALTER TABLE "enrollment_windows"
  ADD COLUMN IF NOT EXISTS "enrollment_opens_at" date,
  ADD COLUMN IF NOT EXISTS "enrollment_closes_at" date;
