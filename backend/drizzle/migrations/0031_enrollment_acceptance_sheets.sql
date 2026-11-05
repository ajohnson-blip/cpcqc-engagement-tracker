-- The enrollment-decisions sheet staff upload for the welcome-to-enroll
-- emails. Kept so a page refresh doesn't lose it and any staff member can
-- send or resend from it; the latest upload for a year is the one in use.
CREATE TABLE IF NOT EXISTS "enrollment_acceptance_sheets" (
  "id" text PRIMARY KEY NOT NULL,
  "program_year" integer NOT NULL,
  "file_name" text,
  "rows" jsonb NOT NULL,
  "uploaded_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_acceptance_sheets" ADD CONSTRAINT "enrollment_acceptance_sheets_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrollment_acceptance_sheets_year_idx" ON "enrollment_acceptance_sheets" ("program_year");
