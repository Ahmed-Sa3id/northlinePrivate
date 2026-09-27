CREATE TABLE `rate_limit_buckets` (
	`key` varchar(512) NOT NULL,
	`attempts` text NOT NULL,
	`blockedUntil` bigint NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rate_limit_buckets_key` PRIMARY KEY(`key`)
);
