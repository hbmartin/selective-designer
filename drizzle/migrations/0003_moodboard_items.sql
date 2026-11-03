CREATE TABLE "item" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"designId" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"vendor" text,
	"productUrl" text,
	"currentVersionId" text NOT NULL,
	"removedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "item_version" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"itemId" text NOT NULL,
	"number" integer NOT NULL,
	"photoKey" text NOT NULL,
	"photoContentType" text NOT NULL,
	"photoWidth" integer NOT NULL,
	"photoHeight" integer NOT NULL,
	"cutoutKey" text,
	"maskKey" text,
	"cutoutStatus" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_designId_design_id_fk" FOREIGN KEY ("designId") REFERENCES "public"."design"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_version" ADD CONSTRAINT "item_version_itemId_item_id_fk" FOREIGN KEY ("itemId") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_design_idx" ON "item" USING btree ("designId","removedAt");--> statement-breakpoint
CREATE INDEX "item_version_item_idx" ON "item_version" USING btree ("itemId");