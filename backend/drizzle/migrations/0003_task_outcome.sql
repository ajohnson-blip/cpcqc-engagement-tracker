DO $$ BEGIN
 CREATE TYPE "public"."task_outcome" AS ENUM('on_time', 'late', 'attended', 'missed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "task_instances" ADD COLUMN IF NOT EXISTS "outcome" "task_outcome";
