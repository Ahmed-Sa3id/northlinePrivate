ALTER TABLE `billing_events` ADD `processingAt` timestamp;
--> statement-breakpoint
ALTER TABLE `billing_events` ADD `failedAt` timestamp;
--> statement-breakpoint
ALTER TABLE `billing_events` ADD `lastError` text;
--> statement-breakpoint
ALTER TABLE `plans` ADD `isAvailable` int NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE `plans` SET `isAvailable` = 0 WHERE `id` = 'plan-pro';
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `providerCheckoutSessionId` varchar(255);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `providerCheckoutCreatedAt` timestamp;
