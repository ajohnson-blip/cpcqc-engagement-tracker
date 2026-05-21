ALTER TABLE "hospitals" ADD COLUMN "cha_hospital_id" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "cdphe_id" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "aim_id" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "tableau_nickname" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "system" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "county" text;--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hospitals_cha_id_idx" ON "hospitals" USING btree ("cha_hospital_id");