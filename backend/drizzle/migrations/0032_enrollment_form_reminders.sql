-- Reminders sent to hospitals that still owe an enrollment form, one row per
-- person per form: when each hospital was last reminded, and a guard against
-- sending the same day's reminders twice.
CREATE TABLE IF NOT EXISTS "enrollment_form_reminders" (
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
 ALTER TABLE "enrollment_form_reminders" ADD CONSTRAINT "enrollment_form_reminders_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_form_reminders" ADD CONSTRAINT "enrollment_form_reminders_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrollment_form_reminders_year_idx" ON "enrollment_form_reminders" ("program_year");
