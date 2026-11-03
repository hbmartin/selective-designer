CREATE TABLE "region" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"designId" text NOT NULL,
	"imageId" text NOT NULL,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"maskKey" text NOT NULL,
	"box" jsonb NOT NULL,
	"score" real,
	"isSuggestion" boolean DEFAULT false NOT NULL,
	"carriedFromRegionId" text
);
--> statement-breakpoint
ALTER TABLE "region" ADD CONSTRAINT "region_designId_design_id_fk" FOREIGN KEY ("designId") REFERENCES "public"."design"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "region" ADD CONSTRAINT "region_imageId_image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."image"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "region_image_idx" ON "region" USING btree ("imageId","source");