CREATE TABLE "render_output_cleanup_recovery" (
	"requestId" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"resultId" text NOT NULL,
	"attempt" integer NOT NULL,
	"objectKey" text NOT NULL,
	"outcome" text NOT NULL,
	"previousOutcome" text,
	"previousCompletedAt" timestamp (3),
	"createdAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "render_output_cleanup_blocked" ADD COLUMN "safeObjectKey" text;--> statement-breakpoint
CREATE INDEX "render_output_cleanup_recovery_fingerprint_idx" ON "render_output_cleanup_recovery" USING btree ("fingerprint","createdAt");