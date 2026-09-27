CREATE TABLE `invitations` (
	`id` varchar(36) NOT NULL,
	`companyId` varchar(36) NOT NULL,
	`invitedBy` varchar(36) NOT NULL,
	`email` varchar(320) NOT NULL,
	`role` enum('admin','supervisor','worker','accountant') NOT NULL,
	`projectId` varchar(36),
	`tokenHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `invitations_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_companyId_companies_id_fk` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_invitedBy_users_uuid_fk` FOREIGN KEY (`invitedBy`) REFERENCES `users`(`uuid`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `invitations_company_idx` ON `invitations` (`companyId`);--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);