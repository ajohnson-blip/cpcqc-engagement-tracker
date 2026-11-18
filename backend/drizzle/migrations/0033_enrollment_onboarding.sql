-- Each initiative's onboarding message per year, written by its PM, and every
-- time a hospital was sent it. Each save bumps `version`, so staff can see who
-- got an earlier version.
CREATE TABLE IF NOT EXISTS "enrollment_onboarding_details" (
  "id" text PRIMARY KEY NOT NULL,
  "program_year" integer NOT NULL,
  "initiative_code" text NOT NULL,
  -- The PM's own text, from the template on the enrollment-forms page.
  "message" text DEFAULT '' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_onboarding_details" ADD CONSTRAINT "enrollment_onboarding_details_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "enrollment_onboarding_details_year_initiative_uniq" ON "enrollment_onboarding_details" ("program_year","initiative_code");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrollment_onboarding_sends" (
  "id" text PRIMARY KEY NOT NULL,
  "program_year" integer NOT NULL,
  "enrollment_form_id" text NOT NULL,
  "hospital_id" text NOT NULL,
  "initiative_code" text NOT NULL,
  "to_email" text NOT NULL,
  "to_name" text,
  -- Which save of the details went out.
  "details_version" integer NOT NULL,
  -- 'receipt' (in the submitter's receipt), 'submit' (to the champions on
  -- submission) or 'send' (from the staff page).
  "via" text NOT NULL,
  "sent_by_user_id" text,
  -- False when SendGrid refused it, or in dev with no SendGrid key.
  "email_sent" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_onboarding_sends" ADD CONSTRAINT "enrollment_onboarding_sends_enrollment_form_id_enrollment_forms_id_fk" FOREIGN KEY ("enrollment_form_id") REFERENCES "public"."enrollment_forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_onboarding_sends" ADD CONSTRAINT "enrollment_onboarding_sends_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_onboarding_sends" ADD CONSTRAINT "enrollment_onboarding_sends_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrollment_onboarding_sends_year_idx" ON "enrollment_onboarding_sends" ("program_year");
