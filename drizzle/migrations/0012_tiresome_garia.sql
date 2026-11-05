ALTER TABLE "active_detection" ADD COLUMN "imageWriteId" text;--> statement-breakpoint
ALTER TABLE "active_detection" ADD COLUMN "completedAt" timestamp (3);--> statement-breakpoint
CREATE INDEX "region_mask_key_idx" ON "region" USING btree ("maskKey");--> statement-breakpoint
ALTER TABLE "active_detection" ADD CONSTRAINT "active_detection_imageWriteId_unique" UNIQUE("imageWriteId");