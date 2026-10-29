CREATE TABLE "api_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"allowed_transports" text[] NOT NULL,
	"allowed_from_domains" text[],
	"rate_limit_per_minute" integer,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"client_id" text NOT NULL,
	"key_id" text NOT NULL,
	"hash" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	CONSTRAINT "api_keys_client_id_key_id_pk" PRIMARY KEY("client_id","key_id")
);
--> statement-breakpoint
CREATE TABLE "email_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"transport" text NOT NULL,
	"provider" text,
	"outcome" text NOT NULL,
	"code" text,
	"message" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email_id" uuid,
	"recipient" text,
	"provider" text NOT NULL,
	"type" text NOT NULL,
	"raw" jsonb NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"received_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_recipients" (
	"email_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"position" smallint NOT NULL,
	"status" text NOT NULL,
	"status_rank" smallint NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "email_recipients_email_id_email_pk" PRIMARY KEY("email_id","email")
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"idempotency_key" text,
	"request_hash" text NOT NULL,
	"request_id" text NOT NULL,
	"payload" jsonb,
	"transport" text NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_config_encrypted" text,
	"status" text NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"sent_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_attempts" ADD CONSTRAINT "email_attempts_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_recipients" ADD CONSTRAINT "email_recipients_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_client_id_api_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."api_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_attempts_email_id_idx" ON "email_attempts" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "email_events_received_at_idx" ON "email_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "email_events_email_id_idx" ON "email_events" USING btree ("email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_client_idempotency_key_uq" ON "emails" USING btree ("client_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_provider_message_id_uq" ON "emails" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "emails_status_updated_at_idx" ON "emails" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "emails_status_created_at_idx" ON "emails" USING btree ("status","created_at");