CREATE TABLE "active_detection" (
	"imageId" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "active_detection" ADD CONSTRAINT "active_detection_imageId_image_id_fk" FOREIGN KEY ("imageId") REFERENCES "public"."image"("id") ON DELETE cascade ON UPDATE no action;