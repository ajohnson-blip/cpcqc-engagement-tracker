-- Continuing-education (CE) certificates.
--
-- CPCQC is an accredited CE provider (Colorado Nurses Association / ANCC) and
-- must issue a certificate to every participant of an educational training, then
-- retain the record. Two tables:
--
--   ce_trainings    one row per training/activity (the certificate content that
--                   is the same for everyone: program, title, date, contact
--                   hours, activity ID)
--   ce_certificates one row per participant (name + email), carrying its own
--                   delivery state so a 100-person send can partially fail and
--                   be retried per recipient
--
-- program_code is text rather than an enum on purpose: the CE program list
-- (SPARK, SOAR, NEST, TTT, IMPACT, …) is a branding/presentation list that
-- evolves independently of the `initiatives` table — IMPACT, for instance, runs
-- CE trainings but is not a QI initiative in this tracker. Validation lives in
-- code (CE_PROGRAMS) so adding a program is a one-line change plus a logo file.
CREATE TABLE IF NOT EXISTS "ce_trainings" (
  "id" text PRIMARY KEY NOT NULL,
  "program_code" text NOT NULL,
  "title" text NOT NULL,
  "training_date" date NOT NULL,
  "contact_hours" numeric(5, 2) NOT NULL,
  "activity_id" text NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ce_certificates" (
  "id" text PRIMARY KEY NOT NULL,
  "training_id" text NOT NULL,
  "certificate_code" text NOT NULL,
  "recipient_name" text NOT NULL,
  "recipient_email" text NOT NULL,
  "sent_at" timestamp with time zone,
  "send_error" text,
  "send_count" integer DEFAULT 0 NOT NULL,
  "last_sent_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ce_trainings" ADD CONSTRAINT "ce_trainings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ce_certificates" ADD CONSTRAINT "ce_certificates_training_id_ce_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "public"."ce_trainings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ce_certificates" ADD CONSTRAINT "ce_certificates_last_sent_by_users_id_fk" FOREIGN KEY ("last_sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ce_certificates_code_idx" ON "ce_certificates" ("certificate_code");
--> statement-breakpoint
-- One certificate per person per training. Case-insensitive on email so a
-- re-uploaded roster updates the existing row instead of issuing a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "ce_certificates_training_email_idx" ON "ce_certificates" ("training_id", lower("recipient_email"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ce_certificates_training_idx" ON "ce_certificates" ("training_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ce_certificates_sent_idx" ON "ce_certificates" ("sent_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ce_trainings_date_idx" ON "ce_trainings" ("training_date");
