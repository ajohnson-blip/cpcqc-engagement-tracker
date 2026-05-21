DO $$ BEGIN
 CREATE TYPE "public"."staff_role_kind" AS ENUM('program_manager', 'qi_advisor');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_initiative_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"initiative_id" text NOT NULL,
	"staff_role" "staff_role_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_initiative_assignments" ADD CONSTRAINT "staff_initiative_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_initiative_assignments" ADD CONSTRAINT "staff_initiative_assignments_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_initiative_assignments_unique" ON "staff_initiative_assignments" USING btree ("user_id","initiative_id","staff_role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_initiative_assignments_initiative_idx" ON "staff_initiative_assignments" USING btree ("initiative_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_initiative_assignments_user_idx" ON "staff_initiative_assignments" USING btree ("user_id");