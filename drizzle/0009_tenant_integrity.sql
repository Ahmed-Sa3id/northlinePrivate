ALTER TABLE `projects` ADD CONSTRAINT `projects_id_company_unique` UNIQUE(`id`,`companyId`);
--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_uuid_company_unique` UNIQUE(`uuid`,`companyId`);
--> statement-breakpoint
ALTER TABLE `materials` ADD CONSTRAINT `materials_id_company_unique` UNIQUE(`id`,`companyId`);
--> statement-breakpoint
ALTER TABLE `project_assignments` ADD CONSTRAINT `project_assignments_project_company_fk` FOREIGN KEY (`projectId`,`companyId`) REFERENCES `projects`(`id`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `project_assignments` ADD CONSTRAINT `project_assignments_user_company_fk` FOREIGN KEY (`userId`,`companyId`) REFERENCES `users`(`uuid`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_project_company_fk` FOREIGN KEY (`projectId`,`companyId`) REFERENCES `projects`(`id`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `attendance` ADD CONSTRAINT `attendance_user_company_fk` FOREIGN KEY (`userId`,`companyId`) REFERENCES `users`(`uuid`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `materials` ADD CONSTRAINT `materials_project_company_fk` FOREIGN KEY (`projectId`,`companyId`) REFERENCES `projects`(`id`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `material_transactions` ADD CONSTRAINT `material_transactions_material_company_fk` FOREIGN KEY (`materialId`,`companyId`) REFERENCES `materials`(`id`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `material_transactions` ADD CONSTRAINT `material_transactions_user_company_fk` FOREIGN KEY (`recordedBy`,`companyId`) REFERENCES `users`(`uuid`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_project_company_fk` FOREIGN KEY (`projectId`,`companyId`) REFERENCES `projects`(`id`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_user_company_fk` FOREIGN KEY (`recordedBy`,`companyId`) REFERENCES `users`(`uuid`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `issues` ADD CONSTRAINT `issues_project_company_fk` FOREIGN KEY (`projectId`,`companyId`) REFERENCES `projects`(`id`,`companyId`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE `issues` ADD CONSTRAINT `issues_user_company_fk` FOREIGN KEY (`reportedBy`,`companyId`) REFERENCES `users`(`uuid`,`companyId`) ON DELETE no action ON UPDATE no action;
