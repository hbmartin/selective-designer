CREATE TABLE "provider_call_receipt" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT (now() at time zone 'UTC') NOT NULL,
	"userId" text,
	"designId" text,
	"subjectId" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"providerRequestId" text,
	"status" text NOT NULL,
	"costUsdMicros" bigint,
	"costSource" text NOT NULL,
	"details" jsonb NOT NULL,
	"startedAt" timestamp (3) NOT NULL,
	"completedAt" timestamp (3),
	"deliveredAt" timestamp (3),
	"deliveryAttempts" integer DEFAULT 0 NOT NULL,
	"lastErrorCode" text
);
--> statement-breakpoint
ALTER TABLE "render_result" ADD COLUMN "accountingIdentity" jsonb;--> statement-breakpoint
CREATE INDEX "provider_call_receipt_pending_idx" ON "provider_call_receipt" USING btree ("deliveredAt","createdAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_call_receipt_request_idx" ON "provider_call_receipt" USING btree ("provider","endpoint","providerRequestId");--> statement-breakpoint
CREATE INDEX "image_original_key_idx" ON "image" USING btree ("originalKey");--> statement-breakpoint
CREATE INDEX "image_working_key_idx" ON "image" USING btree ("workingKey");--> statement-breakpoint
CREATE INDEX "render_result_output_key_idx" ON "render_result" USING btree (("outputCheckpoint"->>'objectKey'));