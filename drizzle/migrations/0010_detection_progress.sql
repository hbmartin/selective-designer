ALTER TABLE "active_detection" ADD COLUMN "failed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "active_detection" ADD COLUMN "progress" jsonb;