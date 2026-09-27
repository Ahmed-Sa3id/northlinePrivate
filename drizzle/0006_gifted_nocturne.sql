CREATE TABLE `sessions` (
	`id` varchar(36) NOT NULL,
	`userUuid` varchar(36) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`lastUsedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userUuid_users_uuid_fk` FOREIGN KEY (`userUuid`) REFERENCES `users`(`uuid`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`userUuid`);--> statement-breakpoint
CREATE INDEX `sessions_expiry_idx` ON `sessions` (`expiresAt`);