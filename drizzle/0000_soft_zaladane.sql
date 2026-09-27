CREATE TABLE `attendance` (
	`id` varchar(36) NOT NULL,
	`userId` varchar(36) NOT NULL,
	`projectId` varchar(36) NOT NULL,
	`workDate` timestamp NOT NULL,
	`checkIn` timestamp,
	`checkOut` timestamp,
	CONSTRAINT `attendance_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` varchar(36) NOT NULL,
	`projectId` varchar(36) NOT NULL,
	`category` varchar(120) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`expDate` timestamp NOT NULL,
	`recordedBy` varchar(36) NOT NULL,
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` varchar(36) NOT NULL,
	`projectId` varchar(36) NOT NULL,
	`reportedBy` varchar(36) NOT NULL,
	`description` text NOT NULL,
	`imageUrl` varchar(1000),
	`severity` enum('low','medium','high') NOT NULL DEFAULT 'low',
	`status` enum('open','in_progress','resolved') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `issues_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `material_transactions` (
	`id` varchar(36) NOT NULL,
	`materialId` varchar(36) NOT NULL,
	`type` enum('in','out') NOT NULL,
	`quantity` decimal(14,3) NOT NULL,
	`txDate` timestamp NOT NULL DEFAULT (now()),
	`recordedBy` varchar(36) NOT NULL,
	CONSTRAINT `material_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `materials` (
	`id` varchar(36) NOT NULL,
	`projectId` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`quantity` decimal(14,3) NOT NULL,
	`unit` varchar(40) NOT NULL,
	CONSTRAINT `materials_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `project_assignments` (
	`id` varchar(36) NOT NULL,
	`userId` varchar(36) NOT NULL,
	`projectId` varchar(36) NOT NULL,
	`roleInProject` varchar(120) NOT NULL,
	CONSTRAINT `project_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `project_assignments_user_project_unique` UNIQUE(`userId`,`projectId`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`location` varchar(255) NOT NULL,
	`status` enum('planned','active','paused','completed') NOT NULL DEFAULT 'planned',
	`budget` decimal(14,2) NOT NULL,
	`startDate` timestamp,
	`endDate` timestamp,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`uuid` varchar(36) NOT NULL,
	`openId` varchar(128) NOT NULL,
	`name` text,
	`email` varchar(320),
	`passwordHash` text,
	`loginMethod` varchar(64),
	`role` enum('user','admin','supervisor','worker','accountant') NOT NULL DEFAULT 'worker',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_uuid_unique` UNIQUE(`uuid`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `attendance_user_date_idx` ON `attendance` (`userId`,`workDate`);--> statement-breakpoint
CREATE INDEX `attendance_project_date_idx` ON `attendance` (`projectId`,`workDate`);--> statement-breakpoint
CREATE INDEX `expenses_project_date_idx` ON `expenses` (`projectId`,`expDate`);--> statement-breakpoint
CREATE INDEX `issues_project_status_idx` ON `issues` (`projectId`,`status`);--> statement-breakpoint
CREATE INDEX `material_transactions_material_idx` ON `material_transactions` (`materialId`);--> statement-breakpoint
CREATE INDEX `material_transactions_recorded_by_idx` ON `material_transactions` (`recordedBy`);--> statement-breakpoint
CREATE INDEX `materials_project_idx` ON `materials` (`projectId`);--> statement-breakpoint
CREATE INDEX `project_assignments_project_idx` ON `project_assignments` (`projectId`);--> statement-breakpoint
CREATE INDEX `projects_status_idx` ON `projects` (`status`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);