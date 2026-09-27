ALTER TABLE `subscriptions` ADD `trialStartsAt` timestamp;
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `providerPriceId` varchar(255);
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `cancelAtPeriodEnd` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `canceledAt` timestamp;
--> statement-breakpoint
ALTER TABLE `subscriptions` MODIFY COLUMN `status` enum('trialing','active','past_due','cancelled','expired','incomplete','unpaid','paused') NOT NULL;
