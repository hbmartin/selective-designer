CREATE TABLE "render_output_cleanup" (
	"objectKey" text PRIMARY KEY NOT NULL,
	"resultId" text NOT NULL,
	"attempt" integer NOT NULL,
	"createdAt" timestamp (3) NOT NULL,
	"nextAttemptAt" timestamp (3) NOT NULL,
	"leaseUntil" timestamp (3),
	"claimToken" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastErrorCode" text,
	"outcome" text,
	"completedAt" timestamp (3)
);
--> statement-breakpoint
CREATE INDEX "render_output_cleanup_pending_idx" ON "render_output_cleanup" USING btree ("nextAttemptAt","objectKey") WHERE "render_output_cleanup"."completedAt" is null;