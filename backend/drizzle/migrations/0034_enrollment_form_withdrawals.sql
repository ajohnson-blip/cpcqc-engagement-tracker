-- Hospitals staff took off an initiative's enrollment list: accepted or sent
-- the form, but no longer enrolling in it (e.g. switched to another
-- initiative). Such a hospital doesn't count toward the initiative's expected
-- total, isn't listed as outstanding and isn't reminded. Undo deletes the row.
CREATE TABLE IF NOT EXISTS "enrollment_form_withdrawals" (
  "id" text PRIMARY KEY NOT NULL,
  "program_year" integer NOT NULL,
  "hospital_id" text NOT NULL,
  "initiative_code" text NOT NULL,
  "reason" text,
  "withdrawn_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_form_withdrawals" ADD CONSTRAINT "enrollment_form_withdrawals_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrollment_form_withdrawals" ADD CONSTRAINT "enrollment_form_withdrawals_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "enrollment_form_withdrawals_unique" ON "enrollment_form_withdrawals" ("program_year","hospital_id","initiative_code");
