import { randomUUID } from "node:crypto";
import {
  bigint,
  decimal,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  foreignKey,
} from "drizzle-orm/mysql-core";

export const platformRoles = [
  "admin",
  "supervisor",
  "worker",
  "accountant",
] as const;
export type PlatformRole = (typeof platformRoles)[number];

/**
 * Northline-operator authority, held across every tenant.
 *
 * Deliberately a separate enum from `platformRoles` above: despite that name,
 * those are the roles a user holds *inside their own company*, so a company's
 * `admin` is not and must never become a platform admin. Nothing derives this
 * from `role` — it is granted per user and checked server-side.
 */
export const platformAdminRoles = ["none", "admin"] as const;
export type PlatformAdminRole = (typeof platformAdminRoles)[number];

export const companies = mysqlTable(
  "companies",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    phone: varchar("phone", { length: 40 }),
    logo: varchar("logo", { length: 1000 }),
    status: mysqlEnum("status", ["active", "suspended"])
      .default("active")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({ emailIdx: index("companies_email_idx").on(table.email) }),
);

export const plans = mysqlTable("plans", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 80 }).notNull().unique(),
  price: decimal("price", { precision: 12, scale: 2 }).notNull(),
  billingInterval: mysqlEnum("billingInterval", ["month", "year"]).notNull(),
  isAvailable: int("isAvailable").default(1).notNull(),
  maxUsers: int("maxUsers"),
  maxProjects: int("maxProjects"),
  features: text("features").notNull(),
});

export const subscriptions = mysqlTable(
  "subscriptions",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    planId: varchar("planId", { length: 36 })
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: mysqlEnum("status", [
      "trialing",
      "active",
      "past_due",
      "cancelled",
      "expired",
      "incomplete",
      "unpaid",
      "paused",
    ]).notNull(),
    trialStartsAt: timestamp("trialStartsAt"),
    trialEndsAt: timestamp("trialEndsAt"),
    currentPeriodStart: timestamp("currentPeriodStart").notNull(),
    currentPeriodEnd: timestamp("currentPeriodEnd").notNull(),
    provider: varchar("provider", { length: 40 }),
    providerCustomerId: varchar("providerCustomerId", { length: 255 }),
    providerSubscriptionId: varchar("providerSubscriptionId", { length: 255 }),
    providerCheckoutSessionId: varchar("providerCheckoutSessionId", {
      length: 255,
    }),
    providerCheckoutCreatedAt: timestamp("providerCheckoutCreatedAt"),
    providerPriceId: varchar("providerPriceId", { length: 255 }),
    cancelAtPeriodEnd: int("cancelAtPeriodEnd").default(0).notNull(),
    canceledAt: timestamp("canceledAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => ({
    companyIdx: index("subscriptions_company_idx").on(table.companyId),
  }),
);

/**
 * Shared identity table. The Manus OAuth fields remain available for the
 * platform session, while passwordHash supports the graduation-project
 * credential flow. Password hashes are never returned from API procedures.
 */
export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    uuid: varchar("uuid", { length: 36 })
      .$defaultFn(() => randomUUID())
      .notNull()
      .unique(),
    openId: varchar("openId", { length: 128 }).notNull().unique(),
    name: text("name"),
    email: varchar("email", { length: 320 }).unique(),
    passwordHash: text("passwordHash"),
    loginMethod: varchar("loginMethod", { length: 64 }),
    role: mysqlEnum("role", ["user", ...platformRoles])
      .default("worker")
      .notNull(),
    /**
     * Platform-wide authority (`platformAdminRoles`), independent of `role`.
     * Defaults to `none`, so granting a company `admin` never implies
     * platform-level access.
     */
    platformRole: mysqlEnum("platformRole", platformAdminRoles)
      .default("none")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
    emailVerifiedAt: timestamp("emailVerifiedAt"),
  },
  (table) => ({
    emailIdx: index("users_email_idx").on(table.email),
    companyIdx: index("users_company_idx").on(table.companyId),
    tenantIdentityUnique: uniqueIndex("users_uuid_company_unique").on(
      table.uuid,
      table.companyId,
    ),
  }),
);

export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    userUuid: varchar("userUuid", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    revokedAt: timestamp("revokedAt"),
    lastUsedAt: timestamp("lastUsedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("sessions_user_idx").on(table.userUuid),
    expiryIdx: index("sessions_expiry_idx").on(table.expiresAt),
  }),
);

export const emailVerificationTokens = mysqlTable(
  "email_verification_tokens",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    userUuid: varchar("userUuid", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    usedAt: timestamp("usedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index("email_verification_user_idx").on(table.userUuid),
  }),
);

export const passwordResetTokens = mysqlTable(
  "password_reset_tokens",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    userUuid: varchar("userUuid", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    usedAt: timestamp("usedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({ userIdx: index("password_reset_user_idx").on(table.userUuid) }),
);

export const projects = mysqlTable(
  "projects",
  {
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    location: varchar("location", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["planned", "active", "paused", "completed"])
      .default("planned")
      .notNull(),
    budget: decimal("budget", { precision: 14, scale: 2 }).notNull(),
    startDate: timestamp("startDate"),
    endDate: timestamp("endDate"),
  },
  (table) => ({
    statusIdx: index("projects_status_idx").on(table.status),
    companyIdx: index("projects_company_idx").on(table.companyId),
    tenantIdentityUnique: uniqueIndex("projects_id_company_unique").on(
      table.id,
      table.companyId,
    ),
  }),
);

export const projectAssignments = mysqlTable(
  "project_assignments",
  {
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    userId: varchar("userId", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "cascade" }),
    projectId: varchar("projectId", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    roleInProject: varchar("roleInProject", { length: 120 }).notNull(),
  },
  (table) => ({
    userProjectUnique: uniqueIndex(
      "project_assignments_user_project_unique",
    ).on(table.userId, table.projectId),
    projectIdx: index("project_assignments_project_idx").on(table.projectId),
    companyIdx: index("project_assignments_company_idx").on(table.companyId),
    projectTenantFk: foreignKey({
      columns: [table.projectId, table.companyId],
      foreignColumns: [projects.id, projects.companyId],
      name: "project_assignments_project_company_fk",
    }),
    userTenantFk: foreignKey({
      columns: [table.userId, table.companyId],
      foreignColumns: [users.uuid, users.companyId],
      name: "project_assignments_user_company_fk",
    }),
  }),
);

export const attendance = mysqlTable(
  "attendance",
  {
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    userId: varchar("userId", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "cascade" }),
    projectId: varchar("projectId", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workDate: timestamp("workDate").notNull(),
    checkIn: timestamp("checkIn"),
    checkOut: timestamp("checkOut"),
  },
  (table) => ({
    attendanceUserDateIdx: index("attendance_user_date_idx").on(
      table.userId,
      table.workDate,
    ),
    attendanceProjectDateIdx: index("attendance_project_date_idx").on(
      table.projectId,
      table.workDate,
    ),
    companyIdx: index("attendance_company_idx").on(table.companyId),
    projectTenantFk: foreignKey({
      columns: [table.projectId, table.companyId],
      foreignColumns: [projects.id, projects.companyId],
      name: "attendance_project_company_fk",
    }),
    userTenantFk: foreignKey({
      columns: [table.userId, table.companyId],
      foreignColumns: [users.uuid, users.companyId],
      name: "attendance_user_company_fk",
    }),
  }),
);

export const materials = mysqlTable(
  "materials",
  {
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    projectId: varchar("projectId", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 255 }).notNull(),
    quantity: decimal("quantity", { precision: 14, scale: 3 }).notNull(),
    minimumStock: decimal("minimumStock", { precision: 14, scale: 3 })
      .default("0.000")
      .notNull(),
    unit: varchar("unit", { length: 40 }).notNull(),
  },
  (table) => ({
    projectIdx: index("materials_project_idx").on(table.projectId),
    companyIdx: index("materials_company_idx").on(table.companyId),
    projectTenantFk: foreignKey({
      columns: [table.projectId, table.companyId],
      foreignColumns: [projects.id, projects.companyId],
      name: "materials_project_company_fk",
    }),
    tenantIdentityUnique: uniqueIndex("materials_id_company_unique").on(
      table.id,
      table.companyId,
    ),
  }),
);

export const materialTransactions = mysqlTable(
  "material_transactions",
  {
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    materialId: varchar("materialId", { length: 36 })
      .notNull()
      .references(() => materials.id, { onDelete: "cascade" }),
    type: mysqlEnum("type", ["in", "out"]).notNull(),
    quantity: decimal("quantity", { precision: 14, scale: 3 }).notNull(),
    txDate: timestamp("txDate").defaultNow().notNull(),
    recordedBy: varchar("recordedBy", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "restrict" }),
  },
  (table) => ({
    materialIdx: index("material_transactions_material_idx").on(
      table.materialId,
    ),
    recordedByIdx: index("material_transactions_recorded_by_idx").on(
      table.recordedBy,
    ),
    companyIdx: index("material_transactions_company_idx").on(table.companyId),
    materialTenantFk: foreignKey({
      columns: [table.materialId, table.companyId],
      foreignColumns: [materials.id, materials.companyId],
      name: "material_transactions_material_company_fk",
    }),
    userTenantFk: foreignKey({
      columns: [table.recordedBy, table.companyId],
      foreignColumns: [users.uuid, users.companyId],
      name: "material_transactions_user_company_fk",
    }),
  }),
);

export const expenses = mysqlTable(
  "expenses",
  {
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    projectId: varchar("projectId", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    category: varchar("category", { length: 120 }).notNull(),
    amount: decimal("amount", { precision: 14, scale: 2 }).notNull(),
    expDate: timestamp("expDate").notNull(),
    recordedBy: varchar("recordedBy", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "restrict" }),
  },
  (table) => ({
    projectDateIdx: index("expenses_project_date_idx").on(
      table.projectId,
      table.expDate,
    ),
    companyIdx: index("expenses_company_idx").on(table.companyId),
    projectTenantFk: foreignKey({
      columns: [table.projectId, table.companyId],
      foreignColumns: [projects.id, projects.companyId],
      name: "expenses_project_company_fk",
    }),
    userTenantFk: foreignKey({
      columns: [table.recordedBy, table.companyId],
      foreignColumns: [users.uuid, users.companyId],
      name: "expenses_user_company_fk",
    }),
  }),
);

export const issues = mysqlTable(
  "issues",
  {
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    projectId: varchar("projectId", { length: 36 })
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    reportedBy: varchar("reportedBy", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "restrict" }),
    description: text("description").notNull(),
    imageUrl: varchar("imageUrl", { length: 1000 }),
    severity: mysqlEnum("severity", ["low", "medium", "high", "critical"])
      .default("low")
      .notNull(),
    status: mysqlEnum("status", ["open", "in_progress", "resolved"])
      .default("open")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    projectStatusIdx: index("issues_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    companyIdx: index("issues_company_idx").on(table.companyId),
    projectTenantFk: foreignKey({
      columns: [table.projectId, table.companyId],
      foreignColumns: [projects.id, projects.companyId],
      name: "issues_project_company_fk",
    }),
    userTenantFk: foreignKey({
      columns: [table.reportedBy, table.companyId],
      foreignColumns: [users.uuid, users.companyId],
      name: "issues_user_company_fk",
    }),
  }),
);

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    userId: varchar("userId", { length: 36 }).references(() => users.uuid, {
      onDelete: "set null",
    }),
    action: varchar("action", { length: 120 }).notNull(),
    resourceType: varchar("resourceType", { length: 80 }).notNull(),
    resourceId: varchar("resourceId", { length: 36 }),
    metadata: text("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    companyDateIdx: index("audit_logs_company_date_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);

export const invitations = mysqlTable(
  "invitations",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    companyId: varchar("companyId", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    invitedBy: varchar("invitedBy", { length: 36 })
      .notNull()
      .references(() => users.uuid, { onDelete: "restrict" }),
    email: varchar("email", { length: 320 }).notNull(),
    role: mysqlEnum("role", platformRoles).notNull(),
    projectId: varchar("projectId", { length: 36 }).references(
      () => projects.id,
      { onDelete: "set null" },
    ),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    acceptedAt: timestamp("acceptedAt"),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    companyIdx: index("invitations_company_idx").on(table.companyId),
    emailIdx: index("invitations_email_idx").on(table.email),
    expiryIdx: index("invitations_expiry_idx").on(table.expiresAt),
  }),
);

export const rateLimitBuckets = mysqlTable("rate_limit_buckets", {
  key: varchar("key", { length: 512 }).primaryKey(),
  attempts: text("attempts").notNull(),
  blockedUntil: bigint("blockedUntil", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const billingEvents = mysqlTable(
  "billing_events",
  {
    id: varchar("id", { length: 36 })
      .$defaultFn(() => randomUUID())
      .primaryKey(),
    provider: varchar("provider", { length: 40 }).notNull(),
    providerEventId: varchar("providerEventId", { length: 255 }).notNull(),
    eventType: varchar("eventType", { length: 120 }).notNull(),
    companyId: varchar("companyId", { length: 36 }).references(
      () => companies.id,
      { onDelete: "set null" },
    ),
    payload: text("payload").notNull(),
    processingAt: timestamp("processingAt"),
    processedAt: timestamp("processedAt"),
    failedAt: timestamp("failedAt"),
    lastError: text("lastError"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    providerEventUnique: uniqueIndex("billing_events_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
    companyIdx: index("billing_events_company_idx").on(table.companyId),
  }),
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;
export type ProjectAssignment = typeof projectAssignments.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type Material = typeof materials.$inferSelect;
export type MaterialTransaction = typeof materialTransactions.$inferSelect;
export type Expense = typeof expenses.$inferSelect;
export type Issue = typeof issues.$inferSelect;

// Kept as a named export for schema readers and future FK migrations.
export const utcNowMs = () => Date.now();
export const timestampType = bigint("timestampType", { mode: "number" });
