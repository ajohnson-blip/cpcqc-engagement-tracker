-- Step 1 of CPCQC's 2-step annual enrollment flow: hospitals submit a single
-- ranked interest form per program year, CPCQC reviews in aggregate to set
-- cohort size and mix, then sends the detailed initiative-specific Enrollment
-- Forms to accepted hospitals.
--
-- Two new tables:
--   1. enrollment_windows — config row per program year holding the open/close
--      dates for the interest-form acceptance window. Banner copy, the inline
--      "accepted from X to Y" form line, and the server-side "is the window
--      open?" check all read from here.
--   2. annual_interest_forms — one row per (program_year, hospital). Unique
--      index means re-submission within the window UPDATEs in place rather
--      than duplicating, so an editable submission flow Just Works.

DO $$ BEGIN
 CREATE TYPE "public"."annual_interest_form_status" AS ENUM('submitted', 'under_review', 'accepted', 'declined');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrollment_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"program_year" integer NOT NULL,
	"opens_at" date NOT NULL,
	"closes_at" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_windows_program_year_unique" UNIQUE("program_year")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "annual_interest_forms" (
	"id" text PRIMARY KEY NOT NULL,
	"program_year" integer NOT NULL,
	"hospital_id" text NOT NULL,
	"submitter_user_id" text,
	"submitter_name" text NOT NULL,
	"submitter_role" text NOT NULL,
	"submitter_email" text NOT NULL,
	"intended_initiative_count" integer NOT NULL,
	"ranked_initiatives" jsonb NOT NULL,
	"reasoning" jsonb NOT NULL,
	"status" "annual_interest_form_status" DEFAULT 'submitted' NOT NULL,
	"staff_note" text,
	"decided_initiatives" jsonb,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "annual_interest_forms" ADD CONSTRAINT "annual_interest_forms_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "annual_interest_forms" ADD CONSTRAINT "annual_interest_forms_submitter_user_id_users_id_fk" FOREIGN KEY ("submitter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "annual_interest_forms" ADD CONSTRAINT "annual_interest_forms_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "annual_interest_forms_hospital_year_uniq" ON "annual_interest_forms" USING btree ("program_year","hospital_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annual_interest_forms_program_year_idx" ON "annual_interest_forms" USING btree ("program_year");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "annual_interest_forms_status_idx" ON "annual_interest_forms" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrollment_windows_program_year_idx" ON "enrollment_windows" USING btree ("program_year");--> statement-breakpoint
-- Seed the 2027 enrollment window. Dates can be edited via psql or a future
-- staff config UI; nothing else in the migration depends on these values.
INSERT INTO "enrollment_windows" (id, program_year, opens_at, closes_at)
VALUES (gen_random_uuid()::text, 2027, '2026-09-15', '2026-10-15')
ON CONFLICT (program_year) DO NOTHING;
