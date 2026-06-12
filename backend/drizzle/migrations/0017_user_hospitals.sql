CREATE TABLE IF NOT EXISTS "user_hospitals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"hospital_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_hospitals" ADD CONSTRAINT "user_hospitals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_hospitals" ADD CONSTRAINT "user_hospitals_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_hospitals_user_hospital_uniq" ON "user_hospitals" USING btree ("user_id","hospital_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_hospitals_user_idx" ON "user_hospitals" USING btree ("user_id");