CREATE TABLE "render_output_cleanup_acknowledgment_request" (
	"requestId" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"canonicalRequestId" text NOT NULL,
	"createdAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "render_output_cleanup_recovery" DROP CONSTRAINT "render_output_cleanup_recovery_shape";--> statement-breakpoint
ALTER TABLE "render_output_cleanup_acknowledgment_request" ADD CONSTRAINT "render_output_cleanup_acknowledgment_request_canonicalRequestId_render_output_cleanup_recovery_requestId_fk" FOREIGN KEY ("canonicalRequestId") REFERENCES "public"."render_output_cleanup_recovery"("requestId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_output_cleanup_recovery" ADD CONSTRAINT "render_output_cleanup_recovery_shape" CHECK (("render_output_cleanup_recovery"."outcome" = 'cleanup_acknowledged' and "render_output_cleanup_recovery"."reasonCode" in ('locator_unavailable_retained', 'operator_retained') and "render_output_cleanup_recovery"."resultId" is null and "render_output_cleanup_recovery"."attempt" is null and "render_output_cleanup_recovery"."objectKey" is null) or ("render_output_cleanup_recovery"."outcome" in ('cleanup_requeued', 'cleanup_already_pending', 'cleanup_already_completed') and "render_output_cleanup_recovery"."resultId" is not null and "render_output_cleanup_recovery"."attempt" is not null and "render_output_cleanup_recovery"."objectKey" is not null and "render_output_cleanup_recovery"."reasonCode" is null));