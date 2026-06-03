DO $$ BEGIN
 CREATE TYPE "public"."issue_report_status" AS ENUM('open', 'in_progress', 'resolved');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."issue_report_category" AS ENUM('bug', 'data_correction', 'feature_request', 'other');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_reports" (
  "id" text PRIMARY KEY NOT NULL,
  "reporter_user_id" text,
  "reporter_email" text NOT NULL,
  "reporter_role" text NOT NULL,
  "reporter_hospital_id" text,
  "subject" text NOT NULL,
  "body" text NOT NULL,
  "category" "issue_report_category" DEFAULT 'other' NOT NULL,
  "status" "issue_report_status" DEFAULT 'open' NOT NULL,
  "resolution_note" text,
  "resolved_at" timestamp with time zone,
  "resolved_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_reports" ADD CONSTRAINT "issue_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_reports" ADD CONSTRAINT "issue_reports_reporter_hospital_id_hospitals_id_fk" FOREIGN KEY ("reporter_hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_reports" ADD CONSTRAINT "issue_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_reports_status_idx" ON "issue_reports" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_reports_created_idx" ON "issue_reports" ("created_at");
