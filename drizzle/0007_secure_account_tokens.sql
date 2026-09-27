ALTER TABLE `users` ADD `emailVerifiedAt` timestamp;
--> statement-breakpoint
CREATE TABLE `email_verification_tokens` (
  `id` varchar(36) NOT NULL,
  `userUuid` varchar(36) NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `usedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `email_verification_tokens_id` PRIMARY KEY(`id`),
  CONSTRAINT `email_verification_tokens_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `email_verification_tokens` ADD CONSTRAINT `email_verification_tokens_userUuid_users_uuid_fk` FOREIGN KEY (`userUuid`) REFERENCES `users`(`uuid`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `email_verification_user_idx` ON `email_verification_tokens` (`userUuid`);
--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
  `id` varchar(36) NOT NULL,
  `userUuid` varchar(36) NOT NULL,
  `tokenHash` varchar(64) NOT NULL,
  `expiresAt` timestamp NOT NULL,
  `usedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`),
  CONSTRAINT `password_reset_tokens_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_userUuid_users_uuid_fk` FOREIGN KEY (`userUuid`) REFERENCES `users`(`uuid`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `password_reset_user_idx` ON `password_reset_tokens` (`userUuid`);
