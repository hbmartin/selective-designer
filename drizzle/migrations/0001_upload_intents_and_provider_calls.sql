CREATE TABLE "provider_call" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"userId" text,
	"designId" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"subjectId" text,
	"providerRequestId" text,
	"status" text NOT NULL,
	"costUsdMicros" bigint,
	"costSource" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"startedAt" timestamp (3) NOT NULL,
	"completedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "upload_intent" (
	"objectKey" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"purpose" text NOT NULL,
	"contentType" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"consumedAt" timestamp (3)
);
--> statement-breakpoint
CREATE INDEX "provider_call_design_idx" ON "provider_call" USING btree ("designId");--> statement-breakpoint
CREATE INDEX "provider_call_subject_idx" ON "provider_call" USING btree ("subjectId");--> statement-breakpoint
CREATE INDEX "provider_call_started_at_idx" ON "provider_call" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "upload_intent_user_idx" ON "upload_intent" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "upload_intent_expires_at_idx" ON "upload_intent" USING btree ("expiresAt");