ALTER TABLE "active_detection" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "active_detection" ADD COLUMN "workerId" text;--> statement-breakpoint
CREATE INDEX "item_version_cutout_key_idx" ON "item_version" USING btree ("cutoutKey");--> statement-breakpoint
CREATE INDEX "item_version_photo_key_idx" ON "item_version" USING btree ("photoKey");--> statement-breakpoint
CREATE INDEX "item_version_mask_key_idx" ON "item_version" USING btree ("maskKey");