CREATE TABLE `bank_sessions` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_tenant_external_ref` ON `accounts` (`tenant_id`,`external_ref`) WHERE "accounts"."external_ref" IS NOT NULL;