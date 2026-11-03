CREATE TABLE "render" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"designId" text NOT NULL,
	"renderSourceImageId" text NOT NULL,
	"batchId" text,
	"batchOptionItemId" text,
	"recipe" jsonb NOT NULL,
	"preferredResultId" text
);
--> statement-breakpoint
CREATE TABLE "render_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"designId" text NOT NULL,
	"renderSourceImageId" text NOT NULL,
	"editSet" jsonb NOT NULL,
	"revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_result" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"renderId" text NOT NULL,
	"modelId" text NOT NULL,
	"status" text NOT NULL,
	"skipReason" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"providerRequestId" text,
	"modelVersion" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt" text,
	"outputImageId" text,
	"framingChanged" boolean DEFAULT false NOT NULL,
	"errorMessage" text,
	"costUsdMicros" bigint,
	"costSource" text,
	"schemeName" text,
	"submittedAt" timestamp (3),
	"completedAt" timestamp (3)
);
--> statement-breakpoint
ALTER TABLE "render" ADD CONSTRAINT "render_designId_design_id_fk" FOREIGN KEY ("designId") REFERENCES "public"."design"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render" ADD CONSTRAINT "render_renderSourceImageId_image_id_fk" FOREIGN KEY ("renderSourceImageId") REFERENCES "public"."image"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_draft" ADD CONSTRAINT "render_draft_designId_design_id_fk" FOREIGN KEY ("designId") REFERENCES "public"."design"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_draft" ADD CONSTRAINT "render_draft_renderSourceImageId_image_id_fk" FOREIGN KEY ("renderSourceImageId") REFERENCES "public"."image"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_result" ADD CONSTRAINT "render_result_renderId_render_id_fk" FOREIGN KEY ("renderId") REFERENCES "public"."render"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "render_design_idx" ON "render" USING btree ("designId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "render_draft_source_key" ON "render_draft" USING btree ("renderSourceImageId");--> statement-breakpoint
CREATE INDEX "render_result_render_idx" ON "render_result" USING btree ("renderId");