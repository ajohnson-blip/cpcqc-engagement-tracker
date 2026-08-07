-- Uploaded CE program logos.
--
-- These live in the DATABASE rather than on disk because Render's filesystem is
-- ephemeral: a logo written to backend/assets/ at runtime survives until the
-- next deploy and then silently disappears, taking the branding off every
-- certificate issued afterwards. The files committed to assets/ still work and
-- act as the fallback — an upload simply takes precedence over one.
--
-- Bytes are base64 text rather than bytea: logos are tens of kilobytes, there
-- are a handful of them, and this avoids a custom Drizzle column type for no
-- practical gain.
CREATE TABLE IF NOT EXISTS "ce_program_logos" (
  "program_code" text PRIMARY KEY NOT NULL,
  "mime_type" text NOT NULL,
  "bytes_base64" text NOT NULL,
  "byte_size" integer NOT NULL,
  "original_filename" text,
  "uploaded_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ce_program_logos" ADD CONSTRAINT "ce_program_logos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
