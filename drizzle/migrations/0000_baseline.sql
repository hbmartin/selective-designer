CREATE TYPE "public"."UserRole" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."AuthProvider" AS ENUM('better-auth', 'workos');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp (3),
	"refreshTokenExpiresAt" timestamp (3),
	"scope" text,
	"password" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"impersonatedBy" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean NOT NULL,
	"image" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"role" "UserRole" DEFAULT 'user' NOT NULL,
	"banned" boolean,
	"banReason" text,
	"banExpires" timestamp (3),
	"onboardedAt" timestamp (3)
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identity" (
	"provider" "AuthProvider" NOT NULL,
	"providerUserId" text NOT NULL,
	"userId" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identity_provider_provider_user_id_pk" PRIMARY KEY("provider","providerUserId")
);
--> statement-breakpoint
CREATE TABLE "email_status" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"externalId" text,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"idempotencyKey" text,
	"lastWebhookEventId" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identity" ADD CONSTRAINT "auth_identity_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_key" ON "account" USING btree ("providerId","accountId");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_key" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_key" ON "user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_identifier_value_key" ON "verification" USING btree ("identifier","value");--> statement-breakpoint
CREATE INDEX "auth_identity_user_id_idx" ON "auth_identity" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identity_provider_user_id_key" ON "auth_identity" USING btree ("provider","userId");--> statement-breakpoint
CREATE UNIQUE INDEX "email_status_provider_external_id_key" ON "email_status" USING btree ("provider","externalId") WHERE "email_status"."externalId" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_status_provider_idempotency_key" ON "email_status" USING btree ("provider","idempotencyKey") WHERE "email_status"."idempotencyKey" is not null;--> statement-breakpoint
CREATE INDEX "email_status_status_idx" ON "email_status" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_status_created_at_idx" ON "email_status" USING btree ("createdAt");