ALTER TABLE `transactions` ADD `value_date` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `merchant_name` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `counterparty_name` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `category` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_source` text;--> statement-breakpoint
ALTER TABLE `receipts` ADD `image_hash` text;