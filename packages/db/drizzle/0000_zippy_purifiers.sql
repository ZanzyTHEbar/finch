CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`aggregate_type` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`event_version` integer NOT NULL,
	`payload` text NOT NULL,
	`metadata` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`occurred_at` text NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "events_sequence_positive" CHECK("events"."sequence" > 0),
	CONSTRAINT "events_version_positive" CHECK("events"."event_version" > 0)
);
--> statement-breakpoint
CREATE INDEX `events_agg_seq_idx` ON `events` (`tenant_id`,`aggregate_type`,`aggregate_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `events_type_recorded_idx` ON `events` (`tenant_id`,`event_type`,`recorded_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_agg_seq_unique` ON `events` (`tenant_id`,`aggregate_type`,`aggregate_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_idempotency_unique` ON `events` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`external_ref` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`last_discovered_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "accounts_type_valid" CHECK("accounts"."type" IN ('checking', 'savings', 'credit', 'investment', 'other')),
	CONSTRAINT "accounts_status_valid" CHECK("accounts"."status" IN ('active', 'revoked', 'closed')),
	CONSTRAINT "accounts_currency_len" CHECK(length("accounts"."currency") = 3)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`account_id` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`posted_date` text,
	`observed_at` text NOT NULL,
	`description` text,
	`external_id` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_amount_nonzero" CHECK("transactions"."amount_minor" <> 0),
	CONSTRAINT "transactions_currency_len" CHECK(length("transactions"."currency") = 3),
	CONSTRAINT "transactions_status_valid" CHECK("transactions"."status" IN ('booked', 'pending', 'corrected', 'reversed', 'deleted')),
	CONSTRAINT "transactions_posted_date_iso" CHECK("transactions"."posted_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE INDEX `transactions_account_posted_idx` ON `transactions` (`tenant_id`,`account_id`,`posted_date`);--> statement-breakpoint
CREATE INDEX `transactions_status_idx` ON `transactions` (`tenant_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_external_unique` ON `transactions` (`tenant_id`,`account_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`transaction_id` text,
	`merchant` text,
	`total_minor` integer,
	`currency` text,
	`receipt_date` text,
	`image_ref` text,
	`status` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipts_total_nonnegative" CHECK("receipts"."total_minor" >= 0),
	CONSTRAINT "receipts_currency_len" CHECK("receipts"."currency" IS NULL OR length("receipts"."currency") = 3),
	CONSTRAINT "receipts_status_valid" CHECK("receipts"."status" IN ('captured', 'matched', 'unmatched', 'archived')),
	CONSTRAINT "receipts_date_iso" CHECK("receipts"."receipt_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_image_unique` ON `receipts` (`tenant_id`,`image_ref`);--> statement-breakpoint
CREATE TABLE `search_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`content` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "search_source_type_valid" CHECK("search_documents"."source_type" IN ('account', 'transaction', 'receipt', 'reconciliation', 'summary'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_documents_source_unique` ON `search_documents` (`tenant_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `embeddings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`document_id` text NOT NULL,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`vector` blob NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_id`) REFERENCES `search_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "embeddings_dims_positive" CHECK("embeddings"."dims" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_document_model_unique` ON `embeddings` (`tenant_id`,`document_id`,`model`);--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`transaction_id` text,
	`receipt_id` text,
	`status` text NOT NULL,
	`score` real NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reconciliations_status_valid" CHECK("reconciliations"."status" IN ('proposed', 'confirmed', 'rejected')),
	CONSTRAINT "reconciliations_score_range" CHECK("reconciliations"."score" >= 0 AND "reconciliations"."score" <= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliations_pair_unique` ON `reconciliations` (`tenant_id`,`transaction_id`,`receipt_id`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`period_type` text NOT NULL,
	`period` text NOT NULL,
	`content` text NOT NULL,
	`generated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "summaries_period_type_valid" CHECK("summaries"."period_type" IN ('day', 'week', 'month'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summaries_period_unique` ON `summaries` (`tenant_id`,`period_type`,`period`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "jobs_attempts_nonnegative" CHECK("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_status_valid" CHECK("jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE TABLE `projection_checkpoints` (
	`projection_name` text NOT NULL,
	`tenant_id` text NOT NULL,
	`last_rowid` integer DEFAULT 0 NOT NULL,
	`last_event_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`projection_name`, `tenant_id`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
