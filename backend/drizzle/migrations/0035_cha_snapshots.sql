-- Files delivered by CHA's nightly assessment script (docs/cha-sync-contract.md).
--
-- CHA runs the REDCap queries and delivers one file a night holding, per
-- program and program year, an assessment for each hospital and period — or
-- the error that stopped that program. Syncs on a deployment with
-- SYNC_SOURCE=cha build their previews from the newest successful run.
--
-- Two tables rather than one jsonb blob: "newest successful run for SOAR
-- 2026" is the question every sync asks, and an error in one program must not
-- hide another program's good data from the same night.
--
-- Files are validated strictly before anything is stored, so nothing here can
-- hold a field the contract does not define.
CREATE TABLE IF NOT EXISTS "cha_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "snapshot_id" text NOT NULL,
  "format_version" text NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "generator_name" text NOT NULL,
  "generator_version" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" integer NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cha_snapshots_snapshot_id_uniq" ON "cha_snapshots" ("snapshot_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cha_snapshot_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "cha_snapshot_id" text NOT NULL,
  "program" text NOT NULL,
  "program_year" integer NOT NULL,
  "status" text NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "methodology_version" text,
  "records_read" integer,
  "redcap_project" text,
  "assessments" jsonb,
  "warnings" jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cha_snapshot_runs_program_check" CHECK ("program" IN ('SPARK', 'NEST', 'SOAR', 'TTT')),
  CONSTRAINT "cha_snapshot_runs_status_check" CHECK ("status" IN ('ok', 'error')),
  -- A run is either complete or an error, never partly both.
  CONSTRAINT "cha_snapshot_runs_shape_check" CHECK (
    ("status" = 'ok' AND "assessments" IS NOT NULL AND "error_code" IS NULL)
    OR ("status" = 'error' AND "assessments" IS NULL AND "error_code" IS NOT NULL)
  )
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cha_snapshot_runs" ADD CONSTRAINT "cha_snapshot_runs_cha_snapshot_id_fk"
   FOREIGN KEY ("cha_snapshot_id") REFERENCES "public"."cha_snapshots"("id")
   ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cha_snapshot_runs_snapshot_program_year_uniq"
  ON "cha_snapshot_runs" ("cha_snapshot_id", "program", "program_year");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cha_snapshot_runs_latest_idx"
  ON "cha_snapshot_runs" ("program", "program_year", "generated_at");
