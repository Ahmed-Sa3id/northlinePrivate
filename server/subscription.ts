import { and, count, eq } from "drizzle-orm";
import {
  plans,
  projectAssignments,
  projects,
  subscriptions,
  users,
} from "../drizzle/schema";
import type { User } from "../drizzle/schema";
import { getDb } from "./db";
import { withAdvisoryLock } from "./lock";

export type Feature =
  | "dashboard"
  | "expenses"
  | "materials"
  | "attendance"
  | "issues"
  | "reports"
  | "audit";

export async function getCompanyPlan(companyId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({ plan: plans, subscription: subscriptions })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.companyId, companyId))
    .limit(1);
  return rows[0];
}

export async function assertFeature(companyId: string, feature: Feature) {
  const current = await getCompanyPlan(companyId);
  if (!current) return { allowed: true as const };
  let features: string[] = [];
  try {
    features = JSON.parse(current.plan.features) as string[];
  } catch {
    features = [];
  }
  if (features.includes(feature)) return { allowed: true as const };
  return {
    allowed: false as const,
    code: "FEATURE_NOT_AVAILABLE",
    message: `${feature} is not included in the current plan`,
  };
}

export async function assertProjectLimit(companyId: string) {
  const current = await getCompanyPlan(companyId);
  if (!current?.plan.maxProjects) return { allowed: true as const };
  const db = await getDb();
  if (!db) return { allowed: true as const };
  const [{ value }] = await db
    .select({ value: count() })
    .from(projects)
    .where(eq(projects.companyId, companyId));
  if (Number(value) < current.plan.maxProjects)
    return { allowed: true as const };
  return {
    allowed: false as const,
    code: "PROJECT_LIMIT_REACHED",
    message: `The ${current.plan.name} plan allows ${current.plan.maxProjects} project(s)`,
  };
}

export async function assertUserLimit(companyId: string) {
  const current = await getCompanyPlan(companyId);
  if (!current?.plan.maxUsers) return { allowed: true as const };
  const db = await getDb();
  if (!db) return { allowed: true as const };
  const [{ value }] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.companyId, companyId));
  if (Number(value) < current.plan.maxUsers) return { allowed: true as const };
  return {
    allowed: false as const,
    code: "USER_LIMIT_REACHED",
    message: `The ${current.plan.name} plan allows ${current.plan.maxUsers} user(s)`,
  };
}

export function limitError(result: {
  allowed: boolean;
  code?: string;
  message?: string;
}) {
  return result.allowed
    ? null
    : {
        error: {
          code: result.code ?? "LIMIT_REACHED",
          message: result.message ?? "Plan limit reached",
        },
      };
}

async function withCompanyLimitLock<T>(
  companyId: string,
  resource: "projects" | "users",
  operation: (tx: any) => Promise<T>,
) {
  // The lock must outlive COMMIT; see withAdvisoryLock for why.
  return withAdvisoryLock(
    `northline-limit:${resource}:${companyId}`,
    operation,
  );
}

export async function createProjectWithinPlanLimit(
  companyId: string,
  project: typeof projects.$inferInsert,
) {
  return withCompanyLimitLock(companyId, "projects", async (tx) => {
    const current = await tx
      .select({ plan: plans })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(eq(subscriptions.companyId, companyId))
      .limit(1);
    const limit = current[0]?.plan.maxProjects;
    if (limit) {
      const [{ value }] = await tx
        .select({ value: count() })
        .from(projects)
        .where(eq(projects.companyId, companyId));
      if (Number(value) >= limit)
        return { allowed: false as const, code: "PROJECT_LIMIT_REACHED" };
    }
    await tx.insert(projects).values(project);
    return { allowed: true as const, project };
  });
}

export async function createUserWithinPlanLimit(
  companyId: string,
  user: typeof users.$inferInsert,
) {
  return withCompanyLimitLock(companyId, "users", async (tx) => {
    const current = await tx
      .select({ plan: plans })
      .from(subscriptions)
      .innerJoin(plans, eq(subscriptions.planId, plans.id))
      .where(eq(subscriptions.companyId, companyId))
      .limit(1);
    const limit = current[0]?.plan.maxUsers;
    if (limit) {
      const [{ value }] = await tx
        .select({ value: count() })
        .from(users)
        .where(eq(users.companyId, companyId));
      if (Number(value) >= limit)
        return { allowed: false as const, code: "USER_LIMIT_REACHED" };
    }
    await tx.insert(users).values(user);
    return { allowed: true as const, user };
  });
}

export function canManageCompany(user: User) {
  return user.role === "admin";
}

export const subscriptionTables = {
  plans,
  subscriptions,
  projects,
  projectAssignments,
  users,
};
