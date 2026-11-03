-- Enrollment forms staff sent a hospital from the enrollment-forms screen.
--
-- The chase list works out who owes a form from interest-form acceptances and
-- TtT cohorts. A hospital CPCQC enrolls without an interest form fits neither,
-- so it never showed as outstanding. Sending it the form is the staff decision
-- that it owes one, recorded here one row per initiative per send.
--
-- Re-sends add rows rather than replace them: which address got the link, and
-- when, is what a PM checks when a hospital says it never arrived.
CREATE TABLE IF NOT EXISTS "enrollment_form_invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "program_year" integer NOT NULL,
  "hospital_id" text NOT NULL,
  "initiative_code" text NOT NULL,
  "to_email" text NOT NULL,
  "to_name" text,
  "sent_by_user_id" text,
  -- False when SendGrid refused it, or in dev with no SendGrid key.
  "email_sent" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_form_invitations" ADD CONSTRAINT "enrollment_form_invitations_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_form_invitations" ADD CONSTRAINT "enrollment_form_invitations_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrollment_form_invitations_year_idx" ON "enrollment_form_invitations" ("program_year");
