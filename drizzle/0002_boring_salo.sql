CREATE TABLE `companies` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `email` varchar(320) NOT NULL,
  `phone` varchar(40),
  `logo` varchar(1000),
  `status` enum('active','suspended') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `companies_id` PRIMARY KEY(`id`),
  CONSTRAINT `companies_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `plans` (
  `id` varchar(36) NOT NULL,
  `name` varchar(80) NOT NULL,
  `price` decimal(12,2) NOT NULL,
  `billingInterval` enum('month','year') NOT NULL,
  `maxUsers` int,
  `maxProjects` int,
  `features` text NOT NULL,
  CONSTRAINT `plans_id` PRIMARY KEY(`id`),
  CONSTRAINT `plans_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
  `id` varchar(36) NOT NULL,
  `companyId` varchar(36) NOT NULL,
  `planId` varchar(36) NOT NULL,
  `status` enum('trialing','active','past_due','cancelled','expired') NOT NULL,
  `trialEndsAt` timestamp,
  `currentPeriodStart` timestamp NOT NULL,
  `currentPeriodEnd` timestamp NOT NULL,
  `provider` varchar(40),
  `providerSubscriptionId` varchar(255),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
  `id` varchar(36) NOT NULL,
  `companyId` varchar(36) NOT NULL,
  `userId` varchar(36),
  `action` varchar(120) NOT NULL,
  `resourceType` varchar(80) NOT NULL,
  `resourceId` varchar(36),
  `metadata` text,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `companyId` varchar(36);
--> statement-breakpoint
ALTER TABLE `projects` ADD `companyId` varchar(36);
--> statement-breakpoint
ALTER TABLE `project_assignments` ADD `companyId` varchar(36);
--> statement-breakpoint
ALTER TABLE `attendance` ADD `companyId` varchar(36);
--> statement-breakpoint
ALTER TABLE `materials` ADD `companyId` varchar(36);
--> statement-breakpoint
ALTER TABLE `material_transactions` ADD `companyId` varchar(36);
--> statement-breakpoint
ALTER TABLE `expenses` ADD `companyId` varchar(36);
--> statement-breakpoint
ALTER TABLE `issues` ADD `companyId` varchar(36);
--> statement-breakpoint
INSERT INTO `companies` (`id`, `name`, `email`, `phone`, `status`) VALUES ('00000000-0000-0000-0000-000000000001', 'Northline Legacy Workspace', 'demo@northline.local', '+20 100 000 0000', 'active') ON DUPLICATE KEY UPDATE `id`=`id`;
--> statement-breakpoint
UPDATE `users` SET `companyId`='00000000-0000-0000-0000-000000000001' WHERE `companyId` IS NULL;
--> statement-breakpoint
UPDATE `projects` SET `companyId`='00000000-0000-0000-0000-000000000001' WHERE `companyId` IS NULL;
--> statement-breakpoint
UPDATE `project_assignments` pa JOIN `projects` p ON p.`id`=pa.`projectId` SET pa.`companyId`=p.`companyId` WHERE pa.`companyId` IS NULL;
--> statement-breakpoint
UPDATE `attendance` a JOIN `projects` p ON p.`id`=a.`projectId` SET a.`companyId`=p.`companyId` WHERE a.`companyId` IS NULL;
--> statement-breakpoint
UPDATE `materials` m JOIN `projects` p ON p.`id`=m.`projectId` SET m.`companyId`=p.`companyId` WHERE m.`companyId` IS NULL;
--> statement-breakpoint
UPDATE `material_transactions` mt JOIN `materials` m ON m.`id`=mt.`materialId` SET mt.`companyId`=m.`companyId` WHERE mt.`companyId` IS NULL;
--> statement-breakpoint
UPDATE `expenses` e JOIN `projects` p ON p.`id`=e.`projectId` SET e.`companyId`=p.`companyId` WHERE e.`companyId` IS NULL;
--> statement-breakpoint
UPDATE `issues` i JOIN `projects` p ON p.`id`=i.`projectId` SET i.`companyId`=p.`companyId` WHERE i.`companyId` IS NULL;
--> statement-breakpoint
ALTER TABLE `users` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `projects` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `project_assignments` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `attendance` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `materials` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `material_transactions` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `expenses` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `issues` MODIFY `companyId` varchar(36) NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_assignments` ADD CONSTRAINT `project_assignments_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `materials` ADD CONSTRAINT `materials_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `material_transactions` ADD CONSTRAINT `material_transactions_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `issues` ADD CONSTRAINT `issues_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_planId_plans_id_fk` FOREIGN KEY (`planId`) REFERENCES `plans`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_userId_users_uuid_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`uuid`) ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `companies_email_idx` ON `companies` (`email`);
--> statement-breakpoint
CREATE INDEX `subscriptions_company_idx` ON `subscriptions` (`companyId`);
--> statement-breakpoint
CREATE INDEX `users_company_idx` ON `users` (`companyId`);
--> statement-breakpoint
CREATE INDEX `projects_company_idx` ON `projects` (`companyId`);
--> statement-breakpoint
CREATE INDEX `project_assignments_company_idx` ON `project_assignments` (`companyId`);
--> statement-breakpoint
CREATE INDEX `attendance_company_idx` ON `attendance` (`companyId`);
--> statement-breakpoint
CREATE INDEX `materials_company_idx` ON `materials` (`companyId`);
--> statement-breakpoint
CREATE INDEX `material_transactions_company_idx` ON `material_transactions` (`companyId`);
--> statement-breakpoint
CREATE INDEX `expenses_company_idx` ON `expenses` (`companyId`);
--> statement-breakpoint
CREATE INDEX `issues_company_idx` ON `issues` (`companyId`);
--> statement-breakpoint
CREATE INDEX `audit_logs_company_date_idx` ON `audit_logs` (`companyId`,`createdAt`);
--> statement-breakpoint
INSERT INTO `plans` (`id`, `name`, `price`, `billingInterval`, `maxUsers`, `maxProjects`, `features`) VALUES
('plan-free', 'Free', 0, 'month', 3, 1, '["dashboard"]'),
('plan-business', 'Business', 499, 'month', 20, 10, '["dashboard","expenses","materials","attendance","issues","reports"]'),
('plan-pro', 'Pro', 999, 'month', NULL, NULL, '["dashboard","expenses","materials","attendance","issues","reports","audit"]')
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`);
--> statement-breakpoint
INSERT INTO `subscriptions` (`id`, `companyId`, `planId`, `status`, `trialEndsAt`, `currentPeriodStart`, `currentPeriodEnd`) VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'plan-business', 'trialing', DATE_ADD(NOW(), INTERVAL 14 DAY), NOW(), DATE_ADD(NOW(), INTERVAL 14 DAY)) ON DUPLICATE KEY UPDATE `companyId`=`companyId`;
