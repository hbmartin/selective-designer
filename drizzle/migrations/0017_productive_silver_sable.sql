CREATE TABLE "render_output_cleanup_blocked" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"resultId" text,
	"attempt" integer,
	"reasonCode" text NOT NULL,
	"createdAt" timestamp (3) NOT NULL
);
