ALTER TABLE "item_version" ADD COLUMN "cutoutOutput" jsonb;--> statement-breakpoint
ALTER TABLE "render_result" ADD COLUMN "workflowRunId" text;--> statement-breakpoint
ALTER TABLE "render_result" ADD COLUMN "outputCheckpoint" jsonb;