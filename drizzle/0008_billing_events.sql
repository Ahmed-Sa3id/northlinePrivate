ALTER TABLE `subscriptions` ADD `providerCustomerId` varchar(255);
--> statement-breakpoint
CREATE TABLE `billing_events` (
  `id` varchar(36) NOT NULL,
  `provider` varchar(40) NOT NULL,
  `providerEventId` varchar(255) NOT NULL,
  `eventType` varchar(120) NOT NULL,
  `companyId` varchar(36),
  `payload` text NOT NULL,
  `processedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `billing_events_id` PRIMARY KEY(`id`),
  CONSTRAINT `billing_events_provider_event_unique` UNIQUE(`provider`,`providerEventId`)
);
--> statement-breakpoint
ALTER TABLE `billing_events` ADD CONSTRAINT `billing_events_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `billing_events_company_idx` ON `billing_events` (`companyId`);
