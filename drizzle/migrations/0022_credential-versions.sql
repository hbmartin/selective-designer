ALTER TABLE "session" ADD COLUMN "credentialVersion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "credentialVersion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_credential_version_nonnegative" CHECK ("session"."credentialVersion" >= 0);--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_credential_version_nonnegative" CHECK ("user"."credentialVersion" >= 0);