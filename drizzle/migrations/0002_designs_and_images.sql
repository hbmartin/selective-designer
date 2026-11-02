CREATE TABLE "design" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"ownerId" text NOT NULL,
	"name" text NOT NULL,
	"baseImageId" text NOT NULL,
	"copiedFromDesignId" text,
	"archivedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "image" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"designId" text NOT NULL,
	"kind" text NOT NULL,
	"originalKey" text NOT NULL,
	"originalContentType" text NOT NULL,
	"originalWidth" integer NOT NULL,
	"originalHeight" integer NOT NULL,
	"workingKey" text NOT NULL,
	"workingWidth" integer NOT NULL,
	"workingHeight" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "design" ADD CONSTRAINT "design_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image" ADD CONSTRAINT "image_designId_design_id_fk" FOREIGN KEY ("designId") REFERENCES "public"."design"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_owner_updated_idx" ON "design" USING btree ("ownerId","archivedAt","updatedAt");--> statement-breakpoint
CREATE INDEX "image_design_idx" ON "image" USING btree ("designId");