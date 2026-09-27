import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../_core/logger";
import {
  attendance,
  companies,
  expenses,
  invitations,
  issues,
  materialTransactions,
  materials,
  platformRoles,
  projectAssignments,
  projects,
  plans,
  subscriptions,
  sessions,
  emailVerificationTokens,
  passwordResetTokens,
  billingEvents,
  type PlatformRole,
  type User,
  users,
} from "../../drizzle/schema";
import {
  authenticateCredentialRequest,
  AUTH_COOKIE,
  hashPassword,
  issueCredentialToken,
  issueBrowserSession,
  revokeBrowserSession,
  revokeAllBrowserSessions,
  listBrowserSessions,
  getBrowserSessionToken,
  isAcceptablePassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "../auth";
import {
  createCredentialUser,
  getDb,
  getCompanyById,
  getUserByEmail,
  listUsers,
  publicUser,
} from "../db";
import { storagePut, storageRead } from "../storage";
import { readTenantAudit, writeAudit } from "../audit";
import {
  clearRateLimitFor,
  loginRateLimit,
  registrationRateLimit,
} from "../rateLimit";
import {
  deliverTransactionalEmail,
  publicAppUrl,
  renderActionEmail,
} from "../email";
import {
  billingConfigured,
  createBillingPortalSession,
  createCheckoutSession,
  classifyCheckout,
  getBillingPriceId,
  parseSignedWebhook,
  mapStripeStatus,
  safeBillingError,
} from "../billing";
import {
  assertFeature,
  assertUserLimit,
  createProjectWithinPlanLimit,
  createUserWithinPlanLimit,
  limitError,
} from "../subscription";
import { withAdvisoryLock } from "../lock";

const idSchema = z.string().uuid("A valid UUID is required");
const emailSchema = z
  .string()
  .trim()
  .email("A valid email is required")
  .transform((value) => value.toLowerCase());
const dateSchema = z.coerce.date();
const moneySchema = z.coerce
  .number()
  .finite()
  .nonnegative()
  .transform((value) => value.toFixed(2));
const positiveMoneySchema = z.coerce
  .number()
  .finite()
  .positive()
  .transform((value) => value.toFixed(2));
const quantitySchema = z.coerce
  .number()
  .finite()
  .nonnegative()
  .transform((value) => value.toFixed(3));
const positiveQuantitySchema = z.coerce
  .number()
  .finite()
  .positive()
  .transform((value) => value.toFixed(3));

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required").max(PASSWORD_MAX_LENGTH),
});

const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  )
  .max(PASSWORD_MAX_LENGTH)
  .refine(isAcceptablePassword, "Password must not be mostly whitespace");

const tokenSchema = z.object({ token: z.string().min(32).max(256) });
const passwordResetSchema = tokenSchema.extend({
  password: passwordSchema,
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

const registrationSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: emailSchema,
  password: passwordSchema,
  companyName: z.string().trim().min(2).max(255),
  companyEmail: emailSchema,
  phone: z.string().trim().min(5).max(40).optional(),
});

const invitationSchema = z.object({
  email: emailSchema,
  role: z.enum(platformRoles),
  projectId: idSchema.optional(),
});

const invitationAcceptSchema = z.object({
  token: z.string().min(32).max(256),
  name: z.string().trim().min(2).max(160),
  password: passwordSchema,
});

function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const createUserSchema = loginSchema.extend({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(160),
  role: z.enum(platformRoles),
});

const projectCreateSchema = z.object({
  name: z.string().trim().min(2).max(255),
  location: z.string().trim().min(2).max(255),
  status: z
    .enum(["planned", "active", "paused", "completed"])
    .default("planned"),
  budget: moneySchema,
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});

const projectUpdateSchema = projectCreateSchema.partial();
const assignmentSchema = z.object({
  userId: idSchema,
  projectId: idSchema,
  roleInProject: z.string().trim().min(2).max(120),
});
const assignmentUpdateSchema = assignmentSchema
  .omit({ userId: true, projectId: true })
  .partial();
const attendanceSchema = z.object({
  userId: idSchema.optional(),
  projectId: idSchema,
  workDate: dateSchema,
  checkIn: dateSchema.optional(),
  checkOut: dateSchema.optional(),
});
const materialSchema = z.object({
  projectId: idSchema,
  name: z.string().trim().min(1).max(255),
  quantity: quantitySchema,
  minimumStock: quantitySchema.default("0.000"),
  unit: z.string().trim().min(1).max(40),
});
const materialUpdateSchema = materialSchema.omit({ projectId: true }).partial();
const transactionSchema = z.object({
  type: z.enum(["in", "out"]),
  quantity: positiveQuantitySchema,
  txDate: dateSchema.optional(),
});
const expenseSchema = z.object({
  projectId: idSchema,
  category: z.string().trim().min(1).max(120),
  amount: positiveMoneySchema,
  expDate: dateSchema,
});
const expenseUpdateSchema = expenseSchema.omit({ projectId: true }).partial();
const issueSchema = z.object({
  projectId: idSchema,
  description: z.string().trim().min(5).max(10000),
  severity: z.enum(["low", "medium", "high", "critical"]).default("low"),
  status: z.enum(["open", "in_progress", "resolved"]).default("open"),
});
const issueUpdateSchema = issueSchema.omit({ projectId: true }).partial();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, file.mimetype.startsWith("image/"));
  },
});

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

type AuthenticatedRequest = Request & { platformUser?: User };

function asyncHandler(
  handler: (req: AuthenticatedRequest, res: Response) => Promise<unknown>,
): Handler {
  return (req, res, next) => {
    Promise.resolve(handler(req as AuthenticatedRequest, res)).catch(next);
  };
}

function validationError(res: Response, error: z.ZodError) {
  return res.status(400).json({
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      fields: error.flatten().fieldErrors,
    },
  });
}

function notFound(res: Response, entity: string) {
  return res.status(404).json({
    error: { code: "NOT_FOUND", message: `${entity} was not found` },
  });
}

export function hasRole(
  user: { role: string } | null,
  allowedRoles: PlatformRole[],
) {
  return Boolean(user && allowedRoles.includes(user.role as PlatformRole));
}
export function canCreateAttendanceFor(
  user: Pick<User, "role" | "uuid">,
  targetUserId: string,
) {
  return user.role !== "worker" || targetUserId === user.uuid;
}

function isConstructionRole(user: User) {
  return user.role !== "user";
}

async function authenticateAnyRequest(req: Request) {
  const credentialUser = await authenticateCredentialRequest(req);
  if (credentialUser) return credentialUser;
  return null;
}

function requireRole(allowedRoles: PlatformRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    void (async () => {
      const user = await authenticateAnyRequest(req);
      if (!user)
        return res.status(401).json({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
          },
        });
      if (!hasRole(user, allowedRoles))
        return res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission for this action",
          },
        });
      if (!user.emailVerifiedAt)
        return res.status(403).json({
          error: {
            code: "EMAIL_NOT_VERIFIED",
            message: "Email verification is required",
          },
        });
      const company = await getCompanyById(user.companyId);
      if (!company || company.status !== "active")
        return res.status(403).json({
          error: {
            code: "COMPANY_SUSPENDED",
            message: "Company access is not active",
          },
        });
      (req as AuthenticatedRequest).platformUser = user;
      res.locals.user = user;
      return next();
    })().catch(next);
  };
}

function currentUser(req: AuthenticatedRequest) {
  return req.platformUser as User;
}

async function assignedProjectIds(user: User) {
  const db = await getDb();
  if (!db) return [] as string[];
  const rows = await db
    .select({ projectId: projectAssignments.projectId })
    .from(projectAssignments)
    .where(
      and(
        eq(projectAssignments.userId, user.uuid),
        eq(projectAssignments.companyId, user.companyId),
      ),
    );
  return rows.map((row) => row.projectId);
}

async function canAccessProject(
  user: User,
  projectId: string,
  allowAccountant = false,
) {
  const db = await getDb();
  if (!db) return false;
  const ownedProject = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.companyId, user.companyId)),
    )
    .limit(1);
  if (!ownedProject.length) return false;
  if (user.role === "admin") return true;
  if (allowAccountant && user.role === "accountant") return true;
  if (!isConstructionRole(user)) return false;
  return (await assignedProjectIds(user)).includes(projectId);
}

async function projectExists(projectId: string, companyId: string) {
  const db = await getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  return rows.length > 0;
}

function parseParamId(req: Request, res: Response) {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) {
    validationError(res, parsed.error);
    return null;
  }
  return parsed.data;
}
function parseOptionalQueryId(req: Request, res: Response, name: string) {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !idSchema.safeParse(value).success) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: `${name} must be a UUID` },
    });
    return null;
  }
  return value;
}

function appUrl(pathname: string) {
  const base = process.env.APP_URL;
  if (!base) throw new Error("APP_URL is required for billing links");
  return new URL(pathname, base).toString();
}

type StripeBillingObject = Record<string, unknown>;

function stringField(object: StripeBillingObject, key: string) {
  return typeof object[key] === "string" ? String(object[key]) : undefined;
}

function numberField(object: StripeBillingObject, key: string) {
  return typeof object[key] === "number" ? Number(object[key]) : undefined;
}

function metadataField(object: StripeBillingObject, key: string) {
  const metadata = object.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function subscriptionPriceId(object: StripeBillingObject) {
  const items = object.items;
  if (!items || typeof items !== "object") return undefined;
  const data = (items as { data?: unknown }).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object")
    return undefined;
  const price = (data[0] as { price?: unknown }).price;
  if (!price || typeof price !== "object") return undefined;
  return stringField(price as StripeBillingObject, "id");
}

function planIdForStripeObject(object: StripeBillingObject) {
  const metadataPlanId = metadataField(object, "planId");
  if (metadataPlanId === "plan-free" || metadataPlanId === "plan-business")
    return metadataPlanId;
  const priceId = subscriptionPriceId(object);
  if (!priceId) return undefined;
  for (const planId of ["plan-free", "plan-business"] as const) {
    try {
      if (getBillingPriceId(planId) === priceId) return planId;
    } catch {
      // Missing environment mappings cannot safely select a plan.
    }
  }
  return undefined;
}

function stripeDate(object: StripeBillingObject, key: string) {
  const value = numberField(object, key);
  return value ? new Date(value * 1000) : undefined;
}

function isDuplicateProviderEvent(error: unknown) {
  const values = [
    error,
    error && typeof error === "object"
      ? (error as { cause?: unknown }).cause
      : undefined,
  ];
  return values.some((value) => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (
      record.code === "ER_DUP_ENTRY" ||
      String(record.message ?? "").includes(
        "billing_events_provider_event_unique",
      ) ||
      String(record.sqlMessage ?? "").includes(
        "billing_events_provider_event_unique",
      )
    );
  });
}

async function findMaterial(materialId: string, companyId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(materials)
    .where(
      and(eq(materials.id, materialId), eq(materials.companyId, companyId)),
    )
    .limit(1);
  return rows[0];
}

async function findIssue(issueId: string, companyId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);
  return rows[0];
}

export function registerPlatformRoutes(app: Express) {
  app.use((req, res, next) => {
    res.on("finish", () => {
      if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return;
      const user = res.locals.user as User | undefined;
      void writeAudit({
        companyId: user?.companyId ?? null,
        actorId: user?.uuid ?? null,
        actorRole: user?.role ?? null,
        action: `${req.method} ${req.path}`,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        at: new Date().toISOString(),
      }).catch((error) =>
        logger.error("failed to write audit entry", { err: error }),
      );
    });
    next();
  });

  app.post(
    "/auth/register",
    registrationRateLimit,
    asyncHandler(async (req, res) => {
      const parsed = registrationSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      if (await getUserByEmail(parsed.data.email))
        return res.status(409).json({
          error: {
            code: "EMAIL_ALREADY_EXISTS",
            message: "An account with this email already exists",
          },
        });
      const companyId = randomUUID();
      const now = new Date();
      const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      await db.transaction(async (tx) => {
        await tx.insert(companies).values({
          id: companyId,
          name: parsed.data.companyName,
          email: parsed.data.companyEmail,
          phone: parsed.data.phone ?? null,
          status: "active",
        });
        await tx.insert(users).values({
          uuid: randomUUID(),
          companyId,
          openId: `credentials:${parsed.data.email}`,
          name: parsed.data.name,
          email: parsed.data.email,
          passwordHash: await hashPassword(parsed.data.password),
          loginMethod: "credentials",
          role: "admin",
        });
        await tx.insert(subscriptions).values({
          id: randomUUID(),
          companyId,
          planId: "plan-free",
          status: "trialing",
          trialEndsAt: trialEnd,
          currentPeriodStart: now,
          currentPeriodEnd: trialEnd,
        });
      });
      const user = await getUserByEmail(parsed.data.email);
      if (!user) throw new Error("Registered user could not be loaded");
      const verificationToken = randomBytes(32).toString("base64url");
      await db.insert(emailVerificationTokens).values({
        userUuid: user.uuid,
        tokenHash: hashInviteToken(verificationToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const verifyUrl = `${publicAppUrl()}/verify-email?token=${encodeURIComponent(verificationToken)}`;
      const email = renderActionEmail({
        title: "Verify your Northline email",
        intro: "Confirm your email address to secure your Northline workspace.",
        actionUrl: verifyUrl,
        actionLabel: "Verify email",
      });
      const delivery = await deliverTransactionalEmail(
        {
          to: user.email ?? parsed.data.email,
          subject: "Verify your Northline email",
          ...email,
        },
        "verification",
      );
      return res.status(201).json({
        user: publicUser(user),
        onboarding: true,
        verificationRequired: true,
        // Surfacing this matters: without a verified sending domain the
        // account exists but no link ever arrives, and the client can say so
        // instead of leaving the user waiting for mail that was rejected.
        emailDelivered: delivery.delivered,
      });
    }),
  );

  /**
   * Whether this session should open on the setup wizard rather than the
   * dashboard.
   *
   * Only someone who can actually finish it qualifies: an admin whose workspace
   * has no projects yet. An invited worker must never see it — step 2 posts to
   * `/onboarding/project`, which is `requireRole(["admin"])` and would 403 —
   * and a returning owner with work in the workspace has nothing to set up.
   *
   * This was dead code before: `POST /auth/register` returned `onboarding: true`
   * but sign-in never returned the flag, `Root` therefore always rendered the
   * dashboard, and `Onboarding.tsx` plus the `/onboarding/project` route were
   * unreachable. Returning it from both `/auth/login` and `/auth/me` puts a
   * fresh owner into the wizard and lets a mid-wizard refresh resume instead of
   * dropping them on an empty overview.
   */
  async function needsOnboarding(user: User): Promise<boolean> {
    if (user.role !== "admin") return false;
    const db = await getDb();
    if (!db) return false;
    const existing = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.companyId, user.companyId))
      .limit(1);
    return existing.length === 0;
  }

  app.post(
    "/auth/login",
    loginRateLimit,
    asyncHandler(async (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = await getUserByEmail(parsed.data.email);
      if (
        !user?.passwordHash ||
        !(await verifyPassword(parsed.data.password, user.passwordHash))
      ) {
        return res.status(401).json({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid email or password",
          },
        });
      }
      // The limiter consumed an attempt before this handler ran. Hand it
      // back: otherwise the 10th correct sign-in inside the window locks a
      // legitimate user out for `LOGIN_RATE_BLOCK_MS` while a wrong-password
      // attacker who stops at nine keeps their allowance untouched.
      await clearRateLimitFor(req);
      if (!user.emailVerifiedAt)
        return res.status(403).json({
          error: {
            code: "EMAIL_NOT_VERIFIED",
            message: "Verify your email before signing in",
          },
        });
      const token = await issueBrowserSession(user);
      const bearerToken = await issueCredentialToken(user);
      res.cookie(AUTH_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000,
        path: "/",
      });
      return res.json({
        token: bearerToken,
        user: publicUser(user),
        onboarding: await needsOnboarding(user),
      });
    }),
  );

  app.get(
    "/auth/me",
    asyncHandler(async (req, res) => {
      const user = await authenticateCredentialRequest(req);
      if (!user)
        return res.status(401).json({
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        });
      return res.json({
        user: publicUser(user),
        onboarding: await needsOnboarding(user),
      });
    }),
  );
  app.post(
    "/auth/verify-email",
    loginRateLimit,
    asyncHandler(async (req, res) => {
      const parsed = tokenSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const tokenHash = hashInviteToken(parsed.data.token);
      const verifiedUserUuid = await db.transaction(async (tx) => {
        const updated = await tx
          .update(emailVerificationTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(emailVerificationTokens.tokenHash, tokenHash),
              isNull(emailVerificationTokens.usedAt),
              gt(emailVerificationTokens.expiresAt, new Date()),
            ),
          );
        if (!updated[0].affectedRows) return null;
        const rows = await tx
          .select({ userUuid: emailVerificationTokens.userUuid })
          .from(emailVerificationTokens)
          .where(eq(emailVerificationTokens.tokenHash, tokenHash))
          .limit(1);
        const userUuid = rows[0]?.userUuid;
        if (!userUuid) return null;
        await tx
          .update(users)
          .set({ emailVerifiedAt: new Date() })
          .where(eq(users.uuid, userUuid));
        return userUuid;
      });
      if (!verifiedUserUuid)
        return res.status(400).json({
          error: {
            code: "INVALID_TOKEN",
            message: "This verification link is invalid or expired",
          },
        });
      return res.json({ verified: true });
    }),
  );
  app.post(
    "/auth/forgot-password",
    loginRateLimit,
    asyncHandler(async (req, res) => {
      const parsed = z.object({ email: emailSchema }).safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = await getUserByEmail(parsed.data.email);
      if (user) {
        const db = await getDb();
        if (db) {
          const token = randomBytes(32).toString("base64url");
          await db.insert(passwordResetTokens).values({
            userUuid: user.uuid,
            tokenHash: hashInviteToken(token),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          });
          const email = renderActionEmail({
            title: "Reset your Northline password",
            intro: "We received a request to reset your password.",
            actionUrl: `${publicAppUrl()}/reset-password?token=${encodeURIComponent(token)}`,
            actionLabel: "Reset password",
          });
          await deliverTransactionalEmail(
            {
              to: user.email ?? parsed.data.email,
              subject: "Reset your Northline password",
              ...email,
            },
            "password-reset",
          );
        }
      }
      return res.json({
        message:
          "If an account exists for that address, recovery instructions have been sent.",
      });
    }),
  );
  app.post(
    "/auth/resend-verification",
    loginRateLimit,
    asyncHandler(async (req, res) => {
      const parsed = z.object({ email: emailSchema }).safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = await getUserByEmail(parsed.data.email);
      if (user && !user.emailVerifiedAt) {
        const db = await getDb();
        if (db) {
          const token = randomBytes(32).toString("base64url");
          await db.transaction(async (tx) => {
            await tx
              .update(emailVerificationTokens)
              .set({ usedAt: new Date() })
              .where(
                and(
                  eq(emailVerificationTokens.userUuid, user.uuid),
                  isNull(emailVerificationTokens.usedAt),
                ),
              );
            await tx.insert(emailVerificationTokens).values({
              userUuid: user.uuid,
              tokenHash: hashInviteToken(token),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
          });
          const email = renderActionEmail({
            title: "Verify your Northline email",
            intro:
              "Confirm your email address to secure your Northline workspace.",
            actionUrl: `${publicAppUrl()}/verify-email?token=${encodeURIComponent(token)}`,
            actionLabel: "Verify email",
          });
          // Deliberately no `emailDelivered` in this response: it is phrased
          // as "if an account exists", and a delivery flag would differ
          // between known and unknown addresses, turning the endpoint into
          // an account-enumeration oracle.
          await deliverTransactionalEmail(
            {
              to: user.email ?? parsed.data.email,
              subject: "Verify your Northline email",
              ...email,
            },
            "verification",
          );
        }
      }
      return res.json({
        message:
          "If an unverified account exists for that address, verification instructions have been sent.",
      });
    }),
  );
  app.post(
    "/auth/reset-password",
    loginRateLimit,
    asyncHandler(async (req, res) => {
      const parsed = passwordResetSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const tokenHash = hashInviteToken(parsed.data.token);
      const resetUserUuid = await db.transaction(async (tx) => {
        const updated = await tx
          .update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(passwordResetTokens.tokenHash, tokenHash),
              isNull(passwordResetTokens.usedAt),
              gt(passwordResetTokens.expiresAt, new Date()),
            ),
          );
        if (!updated[0].affectedRows) return null;
        const rows = await tx
          .select({ userUuid: passwordResetTokens.userUuid })
          .from(passwordResetTokens)
          .where(eq(passwordResetTokens.tokenHash, tokenHash))
          .limit(1);
        const userUuid = rows[0]?.userUuid;
        if (!userUuid) return null;
        await tx
          .update(users)
          .set({
            passwordHash: await hashPassword(parsed.data.password),
            loginMethod: "credentials",
          })
          .where(eq(users.uuid, userUuid));
        return userUuid;
      });
      if (!resetUserUuid)
        return res.status(400).json({
          error: {
            code: "INVALID_TOKEN",
            message: "This reset link is invalid or expired",
          },
        });
      await revokeAllBrowserSessions(resetUserUuid);
      return res.json({ reset: true });
    }),
  );
  app.post(
    "/auth/change-password",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      const parsed = passwordChangeSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = currentUser(req);
      if (
        !user.passwordHash ||
        !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))
      )
        return res.status(400).json({
          error: {
            code: "INVALID_PASSWORD",
            message: "Current password is incorrect",
          },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(parsed.data.newPassword) })
        .where(eq(users.uuid, user.uuid));
      await revokeAllBrowserSessions(user.uuid, getBrowserSessionToken(req));
      return res.json({ changed: true });
    }),
  );
  app.get(
    "/files/*",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      const key = String((req.params as Record<string, string>)["0"] ?? "");
      if (!key || key.includes(".."))
        return res.status(400).json({
          error: { code: "INVALID_FILE", message: "Invalid file key" },
        });
      try {
        const user = currentUser(req);
        const db = await getDb();
        if (!db)
          return res.status(503).json({
            error: {
              code: "DATABASE_UNAVAILABLE",
              message: "Database is unavailable",
            },
          });
        const fileUrl = `/files/${encodeURIComponent(decodeURIComponent(key))}`;
        const matches = await db
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, user.companyId),
              eq(issues.imageUrl, fileUrl),
            ),
          )
          .limit(1);
        if (
          !matches[0] ||
          !(await canAccessProject(user, matches[0].projectId, true))
        )
          return notFound(res, "File");
        const data = await storageRead(decodeURIComponent(key));
        const contentType = data
          .subarray(0, 8)
          .toString("hex")
          .startsWith("89504e47")
          ? "image/png"
          : data.subarray(0, 3).toString("hex") === "ffd8ff"
            ? "image/jpeg"
            : "application/octet-stream";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.send(data);
      } catch {
        return notFound(res, "File");
      }
    }),
  );

  app.get(
    "/company",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      const company = await getCompanyById(currentUser(req).companyId);
      if (!company) return notFound(res, "Company");
      return res.json({ company });
    }),
  );

  app.get(
    "/subscription",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const rows = await db
        .select({ subscription: subscriptions, plan: plans })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.companyId, currentUser(req).companyId))
        .limit(1);
      if (!rows.length) return notFound(res, "Subscription");
      const { subscription, plan } = rows[0];
      return res.json({
        subscription: {
          id: subscription.id,
          planId: subscription.planId,
          status: subscription.status,
          trialStartsAt: subscription.trialStartsAt,
          trialEndsAt: subscription.trialEndsAt,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
          canceledAt: subscription.canceledAt,
        },
        plan,
      });
    }),
  );
  app.post(
    "/billing/checkout",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      if (!billingConfigured())
        return res.status(503).json({
          error: {
            code: "BILLING_NOT_CONFIGURED",
            message: "Payment provider is not configured",
          },
        });
      const parsed = z
        .object({ planId: z.enum(["plan-free", "plan-business"]) })
        .safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const actor = currentUser(req);
      const company = await getCompanyById(actor.companyId);
      if (!company) return notFound(res, "Company");
      const rows = await db
        .select({ subscription: subscriptions, plan: plans })
        .from(subscriptions)
        .innerJoin(plans, eq(subscriptions.planId, plans.id))
        .where(eq(subscriptions.companyId, actor.companyId))
        .limit(1);
      if (!rows[0]) return notFound(res, "Subscription");
      const checkoutReservation = await withAdvisoryLock(
        `northline-billing-checkout:${actor.companyId}`,
        async (tx) => {
          const current = await tx
            .select({ subscription: subscriptions })
            .from(subscriptions)
            .where(eq(subscriptions.companyId, actor.companyId))
            .limit(1);
          const subscription = current[0]?.subscription;
          if (!subscription) return { kind: "missing" as const };
          const disposition = classifyCheckout({
            providerSubscriptionId: subscription.providerSubscriptionId,
            status: subscription.status,
            cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
            providerCheckoutCreatedAt: subscription.providerCheckoutCreatedAt,
          });
          if (disposition === "existing")
            return {
              kind: "existing" as const,
              customerId: subscription.providerCustomerId,
            };
          if (disposition === "in_progress")
            return { kind: "in_progress" as const };
          await tx
            .update(subscriptions)
            .set({ provider: "stripe", providerCheckoutCreatedAt: new Date() })
            .where(eq(subscriptions.id, subscription.id));
          return {
            kind: "reserved" as const,
            customerId: subscription.providerCustomerId,
          };
        },
      );
      if (checkoutReservation.kind === "missing")
        return notFound(res, "Subscription");
      if (checkoutReservation.kind === "in_progress")
        return res.status(409).json({
          error: {
            code: "CHECKOUT_IN_PROGRESS",
            message: "A billing checkout is already being created",
          },
        });
      if (checkoutReservation.kind === "existing") {
        if (!checkoutReservation.customerId)
          return res.status(409).json({
            error: {
              code: "BILLING_CUSTOMER_MISSING",
              message:
                "Manage the existing subscription from the billing portal",
            },
          });
        try {
          const portal = await createBillingPortalSession(
            checkoutReservation.customerId,
            appUrl("/billing"),
          );
          return res.json({
            portalUrl: portal.url,
            managedExistingSubscription: true,
          });
        } catch (error) {
          return res.status(503).json({
            error: {
              code: "BILLING_UNAVAILABLE",
              message: safeBillingError(error),
            },
          });
        }
      }
      try {
        getBillingPriceId(parsed.data.planId);
        const result = await createCheckoutSession({
          companyId: company.id,
          companyName: company.name,
          companyEmail: company.email,
          customerId: checkoutReservation.customerId,
          planId: parsed.data.planId,
          successUrl: appUrl("/billing/success"),
          cancelUrl: appUrl("/billing/cancel"),
        });
        await db
          .update(subscriptions)
          .set({
            provider: "stripe",
            providerCustomerId: result.customerId,
            providerCheckoutSessionId: result.session.id,
          })
          .where(eq(subscriptions.companyId, actor.companyId));
        await writeAudit({
          companyId: actor.companyId,
          actorId: actor.uuid,
          actorRole: actor.role,
          action: "billing.checkout_initiated",
          method: req.method,
          path: req.path,
          status: 200,
          at: new Date().toISOString(),
        });
        return res.json({ checkoutUrl: result.session.url });
      } catch (error) {
        await db
          .update(subscriptions)
          .set({ providerCheckoutCreatedAt: null })
          .where(eq(subscriptions.companyId, actor.companyId));
        return res.status(503).json({
          error: {
            code: "BILLING_UNAVAILABLE",
            message: safeBillingError(error),
          },
        });
      }
    }),
  );
  app.post(
    "/billing/portal",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      if (!billingConfigured())
        return res.status(503).json({
          error: {
            code: "BILLING_NOT_CONFIGURED",
            message: "Payment provider is not configured",
          },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const actor = currentUser(req);
      const rows = await db
        .select({ customerId: subscriptions.providerCustomerId })
        .from(subscriptions)
        .where(eq(subscriptions.companyId, actor.companyId))
        .limit(1);
      if (!rows[0]?.customerId)
        return res.status(409).json({
          error: {
            code: "BILLING_CUSTOMER_MISSING",
            message: "Complete checkout before opening the billing portal",
          },
        });
      try {
        const portal = await createBillingPortalSession(
          rows[0].customerId,
          appUrl("/billing"),
        );
        await writeAudit({
          companyId: actor.companyId,
          actorId: actor.uuid,
          actorRole: actor.role,
          action: "billing.portal_opened",
          method: req.method,
          path: req.path,
          status: 200,
          at: new Date().toISOString(),
        });
        return res.json({ portalUrl: portal.url });
      } catch (error) {
        return res.status(503).json({
          error: {
            code: "BILLING_UNAVAILABLE",
            message: safeBillingError(error),
          },
        });
      }
    }),
  );
  app.post(
    "/billing/webhook",
    asyncHandler(async (req, res) => {
      let event;
      try {
        event = parseSignedWebhook(
          Buffer.isBuffer(req.body)
            ? req.body
            : Buffer.from(JSON.stringify(req.body)),
          req.header("stripe-signature"),
        );
      } catch {
        return res.status(400).json({
          error: {
            code: "INVALID_WEBHOOK",
            message: "Webhook signature verification failed",
          },
        });
      }
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      try {
        await db.insert(billingEvents).values({
          provider: "stripe",
          providerEventId: event.id,
          eventType: event.type,
          payload: JSON.stringify(event),
          processingAt: new Date(),
        });
      } catch (error) {
        if (isDuplicateProviderEvent(error)) {
          const claimed = await db
            .update(billingEvents)
            .set({
              processingAt: new Date(),
              failedAt: null,
              lastError: null,
            })
            .where(
              and(
                eq(billingEvents.provider, "stripe"),
                eq(billingEvents.providerEventId, event.id),
                isNull(billingEvents.processedAt),
                // Parentheses are mandatory: inside `and()` this fragment is
                // inlined verbatim, and without them `AND` binds tighter than
                // `OR`, so the predicate degrades to "this event" OR "any row
                // whose processingAt is stale". That made the claim UPDATE
                // rewrite unrelated (already-processed) events and made
                // duplicate detection pass only inside a ~5 minute window
                // after the previous run.
                sql`(processingAt IS NULL OR processingAt < DATE_SUB(NOW(), INTERVAL 5 MINUTE))`,
              ),
            );
          if (Number(claimed[0]?.affectedRows ?? 0) === 0) {
            const existing = await db
              .select({ processedAt: billingEvents.processedAt })
              .from(billingEvents)
              .where(
                and(
                  eq(billingEvents.provider, "stripe"),
                  eq(billingEvents.providerEventId, event.id),
                ),
              )
              .limit(1);
            if (existing[0]?.processedAt)
              return res.json({ received: true, duplicate: true });
            return res.status(409).json({
              error: {
                code: "WEBHOOK_PROCESSING",
                message: "Webhook is already being processed",
              },
            });
          }
        } else throw error;
      }
      try {
        const object = event.data.object as unknown as StripeBillingObject;
        const customerId = stringField(object, "customer");
        const companyId =
          metadataField(object, "companyId") ??
          (event.type === "checkout.session.completed"
            ? metadataField(object, "companyId")
            : undefined);
        const subscriptionId =
          stringField(object, "subscription") ?? stringField(object, "id");
        const subscriptionEvents = [
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
        ];
        const invoiceEvents = ["invoice.paid", "invoice.payment_failed"];
        const shouldSync =
          event.type === "checkout.session.completed" ||
          subscriptionEvents.includes(event.type) ||
          invoiceEvents.includes(event.type);
        if (shouldSync) {
          const subscriptionRef =
            subscriptionId ?? stringField(object, "subscription");
          const owned = customerId
            ? await db
                .select({
                  id: subscriptions.id,
                  companyId: subscriptions.companyId,
                  providerSubscriptionId: subscriptions.providerSubscriptionId,
                  providerCustomerId: subscriptions.providerCustomerId,
                })
                .from(subscriptions)
                .where(eq(subscriptions.providerCustomerId, customerId))
                .limit(1)
            : [];
          const local = owned[0];
          const ownershipConflict =
            !local ||
            (companyId && local.companyId !== companyId) ||
            (subscriptionRef &&
              local.providerSubscriptionId &&
              local.providerSubscriptionId !== subscriptionRef);
          if (shouldSync && ownershipConflict) {
            await db
              .update(billingEvents)
              .set({
                processingAt: null,
                processedAt: new Date(),
                lastError:
                  "Stripe ownership relationship could not be verified",
              })
              .where(
                and(
                  eq(billingEvents.provider, "stripe"),
                  eq(billingEvents.providerEventId, event.id),
                ),
              );
            return res.json({ received: true, ignored: true });
          }
          const resolvedCompanyId = local?.companyId;
          if (
            local &&
            (subscriptionEvents.includes(event.type) ||
              invoiceEvents.includes(event.type))
          ) {
            const status =
              event.type === "invoice.payment_failed"
                ? "past_due"
                : event.type === "invoice.paid"
                  ? "active"
                  : mapStripeStatus(stringField(object, "status") ?? "expired");
            const planId = planIdForStripeObject(object);
            const nextValues: Record<string, unknown> = {
              status,
              provider: "stripe",
              providerCustomerId: customerId ?? undefined,
              providerSubscriptionId: subscriptionEvents.includes(event.type)
                ? stringField(object, "id")
                : subscriptionRef,
              providerPriceId: subscriptionPriceId(object),
              cancelAtPeriodEnd: Boolean(object.cancel_at_period_end) ? 1 : 0,
              canceledAt: stripeDate(object, "canceled_at") ?? null,
              trialStartsAt: stripeDate(object, "trial_start"),
              trialEndsAt: stripeDate(object, "trial_end"),
              currentPeriodStart: stripeDate(object, "current_period_start"),
              currentPeriodEnd: stripeDate(object, "current_period_end"),
            };
            if (planId) nextValues.planId = planId;
            await db
              .update(subscriptions)
              .set(nextValues)
              .where(eq(subscriptions.id, local.id));
          } else if (
            event.type === "checkout.session.completed" &&
            resolvedCompanyId
          ) {
            await db
              .update(subscriptions)
              .set({
                provider: "stripe",
                providerCustomerId: customerId ?? null,
                providerSubscriptionId: subscriptionRef ?? null,
                providerCheckoutSessionId: stringField(object, "id") ?? null,
                providerCheckoutCreatedAt: null,
              })
              .where(eq(subscriptions.companyId, resolvedCompanyId));
          }
          if (resolvedCompanyId) {
            logger.info("billing webhook synchronized", {
              eventId: event.id,
              eventType: event.type,
              companyId: resolvedCompanyId,
              customerId,
              subscriptionId: subscriptionRef,
            });
          }
          await db
            .update(billingEvents)
            .set({
              companyId: resolvedCompanyId ?? null,
              processedAt: new Date(),
            })
            .where(
              and(
                eq(billingEvents.provider, "stripe"),
                eq(billingEvents.providerEventId, event.id),
              ),
            );
        }
      } catch (error) {
        await db
          .update(billingEvents)
          .set({
            processingAt: null,
            failedAt: new Date(),
            lastError: error instanceof Error ? error.message : String(error),
          })
          .where(
            and(
              eq(billingEvents.provider, "stripe"),
              eq(billingEvents.providerEventId, event.id),
            ),
          );
        logger.error("billing webhook processing failed", {
          eventId: event.id,
          eventType: event.type,
          err: error,
        });
        return res.status(500).json({
          error: {
            code: "WEBHOOK_PROCESSING_FAILED",
            message: "Webhook processing failed",
          },
        });
      }
      return res.json({ received: true });
    }),
  );

  app.post(
    "/onboarding/project",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const parsed = projectCreateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const project = {
        id: randomUUID(),
        companyId: currentUser(req).companyId,
        ...parsed.data,
      };
      const result = await createProjectWithinPlanLimit(
        currentUser(req).companyId,
        project,
      );
      if (!result.allowed)
        return res.status(402).json(
          limitError({
            allowed: false,
            code: result.code,
            message: "The current plan project limit has been reached",
          }),
        );
      return res.status(201).json({ project });
    }),
  );

  app.post("/auth/logout", async (req, res) => {
    const sessionToken = getBrowserSessionToken(req);
    if (sessionToken) await revokeBrowserSession(sessionToken);
    res.clearCookie(AUTH_COOKIE, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    });
    return res.status(204).send();
  });
  app.get(
    "/auth/sessions",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      return res.json({
        sessions: await listBrowserSessions(currentUser(req).uuid),
      });
    }),
  );
  app.delete(
    "/auth/sessions/:id",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      const db = await getDb();
      const sessionId = idSchema.safeParse(req.params.id);
      if (!sessionId.success) return validationError(res, sessionId.error);
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const result = await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sessions.id, sessionId.data),
            eq(sessions.userUuid, currentUser(req).uuid),
            isNull(sessions.revokedAt),
          ),
        );
      if (!result[0].affectedRows) return notFound(res, "Session");
      return res.status(204).send();
    }),
  );
  app.post(
    "/auth/logout-all",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      await revokeAllBrowserSessions(currentUser(req).uuid);
      res.clearCookie(AUTH_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
      return res.status(204).send();
    }),
  );

  app.post(
    "/users",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const parsed = createUserSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      try {
        const actor = currentUser(req);
        const userValues = {
          companyId: actor.companyId,
          uuid: randomUUID(),
          openId: `credentials:${parsed.data.email}`,
          name: parsed.data.name,
          email: parsed.data.email,
          passwordHash: await hashPassword(parsed.data.password),
          loginMethod: "credentials",
          role: parsed.data.role,
          emailVerifiedAt: new Date(),
        } as const;
        const result = await createUserWithinPlanLimit(
          actor.companyId,
          userValues,
        );
        if (!result.allowed)
          return res.status(402).json(
            limitError({
              allowed: false,
              code: result.code,
              message: "The current plan user limit has been reached",
            }),
          );
        const user = await getUserByEmail(parsed.data.email);
        if (!user) throw new Error("User was created but could not be loaded");
        return res.status(201).json({ user: publicUser(user) });
      } catch (error) {
        const message = String(error);
        if (
          message.includes("Duplicate entry") ||
          message.includes("ER_DUP_ENTRY")
        ) {
          return res.status(409).json({
            error: {
              code: "EMAIL_ALREADY_EXISTS",
              message: "A user with this email already exists",
            },
          });
        }
        logger.error("failed to create user", { err: error });
        return res.status(500).json({
          error: { code: "INTERNAL_ERROR", message: "Unable to create user" },
        });
      }
    }),
  );

  app.post(
    "/invitations",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const parsed = invitationSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const actor = currentUser(req);
      const userLimit = limitError(await assertUserLimit(actor.companyId));
      if (userLimit) return res.status(402).json(userLimit);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      if (
        parsed.data.projectId &&
        !(await projectExists(parsed.data.projectId, actor.companyId))
      )
        return notFound(res, "Project");
      const existing = await db
        .select({ uuid: users.uuid })
        .from(users)
        .where(
          and(
            eq(users.companyId, actor.companyId),
            eq(users.email, parsed.data.email),
          ),
        )
        .limit(1);
      if (existing.length)
        return res.status(409).json({
          error: {
            code: "EMAIL_ALREADY_EXISTS",
            message: "A user with this email already exists",
          },
        });
      const rawToken = randomBytes(32).toString("base64url");
      const invitation = {
        id: randomUUID(),
        companyId: actor.companyId,
        invitedBy: actor.uuid,
        email: parsed.data.email,
        role: parsed.data.role,
        projectId: parsed.data.projectId ?? null,
        tokenHash: hashInviteToken(rawToken),
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      };
      await db.insert(invitations).values(invitation);
      const invitationEmail = renderActionEmail({
        title: "You have been invited to Northline",
        intro: `${actor.name ?? "A Northline administrator"} invited you to join their construction workspace as a ${invitation.role}.`,
        actionUrl: `${publicAppUrl()}/accept-invitation?token=${encodeURIComponent(rawToken)}`,
        actionLabel: "Accept invitation",
      });
      const delivery = await deliverTransactionalEmail(
        {
          to: invitation.email,
          subject: "Your Northline workspace invitation",
          ...invitationEmail,
        },
        "invitation",
      );
      return res.status(201).json({
        invitation: {
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          projectId: invitation.projectId,
          expiresAt: invitation.expiresAt,
        },
        // The admin keeps the invitation either way and can resend it, but
        // they need to know the mail was rejected rather than assume the
        // invitee is sitting on it.
        emailDelivered: delivery.delivered,
        ...(process.env.NODE_ENV === "production" ? {} : { token: rawToken }),
      });
    }),
  );

  app.delete(
    "/invitations/:id",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const id = parseParamId(req, res);
      if (!id) return;
      const actor = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const result = await db
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(invitations.id, id),
            eq(invitations.companyId, actor.companyId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        );
      if (!result[0].affectedRows) return notFound(res, "Invitation");
      return res.status(204).send();
    }),
  );

  app.get(
    "/invitations",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const rows = await db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          projectId: invitations.projectId,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(eq(invitations.companyId, currentUser(req).companyId))
        .orderBy(desc(invitations.createdAt))
        .limit(100);
      return res.json({ invitations: rows });
    }),
  );

  app.post(
    "/invitations/:id/resend",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const id = parseParamId(req, res);
      if (!id) return;
      const actor = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const rows = await db
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.id, id),
            eq(invitations.companyId, actor.companyId),
          ),
        )
        .limit(1);
      const invitation = rows[0];
      if (!invitation || invitation.acceptedAt || invitation.revokedAt)
        return notFound(res, "Invitation");
      const rawToken = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
      await db
        .update(invitations)
        .set({ tokenHash: hashInviteToken(rawToken), expiresAt })
        .where(
          and(
            eq(invitations.id, invitation.id),
            eq(invitations.companyId, actor.companyId),
          ),
        );
      const email = renderActionEmail({
        title: "Your Northline invitation was renewed",
        intro: "Your Northline workspace invitation is ready to accept.",
        actionUrl: `${publicAppUrl()}/accept-invitation?token=${encodeURIComponent(rawToken)}`,
        actionLabel: "Accept invitation",
      });
      const delivery = await deliverTransactionalEmail(
        {
          to: invitation.email,
          subject: "Your Northline invitation",
          ...email,
        },
        "invitation",
      );
      return res.json({
        resent: true,
        expiresAt,
        emailDelivered: delivery.delivered,
      });
    }),
  );

  app.get(
    "/invitations/:token",
    asyncHandler(async (req, res) => {
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const rows = await db
        .select({
          email: invitations.email,
          role: invitations.role,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          revokedAt: invitations.revokedAt,
        })
        .from(invitations)
        .where(
          eq(invitations.tokenHash, hashInviteToken(String(req.params.token))),
        )
        .limit(1);
      const invitation = rows[0];
      if (
        !invitation ||
        invitation.acceptedAt ||
        invitation.revokedAt ||
        invitation.expiresAt.getTime() <= Date.now()
      )
        return res.status(410).json({
          error: {
            code: "INVITATION_INVALID",
            message: "This invitation is invalid or expired",
          },
        });
      return res.json({
        invitation: {
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        },
      });
    }),
  );

  app.post(
    "/invitations/accept",
    loginRateLimit,
    asyncHandler(async (req, res) => {
      const parsed = invitationAcceptSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const tokenHash = hashInviteToken(parsed.data.token);
      const rows = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .limit(1);
      const invitation = rows[0];
      if (
        !invitation ||
        invitation.acceptedAt ||
        invitation.revokedAt ||
        invitation.expiresAt.getTime() <= Date.now()
      )
        return res.status(410).json({
          error: {
            code: "INVITATION_INVALID",
            message: "This invitation is invalid or expired",
          },
        });
      if (await getUserByEmail(invitation.email))
        return res.status(409).json({
          error: {
            code: "EMAIL_ALREADY_EXISTS",
            message: "An account with this email already exists",
          },
        });
      const uuid = randomUUID();
      try {
        await db.transaction(async (tx) => {
          const claim = await tx
            .update(invitations)
            .set({ acceptedAt: new Date() })
            .where(
              and(
                eq(invitations.id, invitation.id),
                eq(invitations.tokenHash, tokenHash),
                isNull(invitations.acceptedAt),
                isNull(invitations.revokedAt),
                gt(invitations.expiresAt, new Date()),
              ),
            );
          if (!claim[0].affectedRows)
            throw new Error("INVITATION_ALREADY_CLAIMED");
          await tx.insert(users).values({
            uuid,
            companyId: invitation.companyId,
            openId: `credentials:${invitation.email}`,
            name: parsed.data.name,
            email: invitation.email,
            passwordHash: await hashPassword(parsed.data.password),
            loginMethod: "credentials",
            role: invitation.role,
            emailVerifiedAt: new Date(),
          });
          if (invitation.projectId)
            await tx.insert(projectAssignments).values({
              id: randomUUID(),
              companyId: invitation.companyId,
              userId: uuid,
              projectId: invitation.projectId,
              roleInProject: invitation.role,
            });
        });
      } catch (error) {
        if (String(error).includes("INVITATION_ALREADY_CLAIMED"))
          return res.status(410).json({
            error: {
              code: "INVITATION_INVALID",
              message: "This invitation is invalid or expired",
            },
          });
        throw error;
      }
      const user = await getUserByEmail(invitation.email);
      if (!user)
        throw new Error("Accepted invitation user could not be loaded");
      const sessionToken = await issueBrowserSession(user);
      const bearerToken = await issueCredentialToken(user);
      res.cookie(AUTH_COOKIE, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000,
        path: "/",
      });
      return res.status(201).json({
        token: bearerToken,
        user: publicUser(user),
        // Same flag as sign-in: every place that hands out a session agrees
        // on whether the wizard is the right first screen.
        onboarding: await needsOnboarding(user),
      });
    }),
  );

  app.get(
    "/users",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const users = await listUsers(currentUser(req).companyId);
      return res.json({ users: users.map(publicUser) });
    }),
  );

  app.get(
    "/audit",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const auditFeature = limitError(
        await assertFeature(currentUser(req).companyId, "audit"),
      );
      if (auditFeature) return res.status(402).json(auditFeature);
      const limit = Number(req.query.limit ?? 100);
      return res.json({
        entries: await readTenantAudit(
          currentUser(req).companyId,
          Number.isFinite(limit) ? limit : 100,
        ),
      });
    }),
  );

  app.get(
    "/projects",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      if (user.role === "admin" || user.role === "accountant") {
        return res.json({
          projects: await db
            .select()
            .from(projects)
            .where(eq(projects.companyId, user.companyId)),
        });
      }
      const ids = await assignedProjectIds(user);
      return res.json({
        projects: ids.length
          ? await db
              .select()
              .from(projects)
              .where(
                and(
                  inArray(projects.id, ids),
                  eq(projects.companyId, user.companyId),
                ),
              )
          : [],
      });
    }),
  );

  app.get(
    "/projects/:id",
    requireRole(["admin", "supervisor", "worker", "accountant"]),
    asyncHandler(async (req, res) => {
      const projectId = parseParamId(req, res);
      if (!projectId) return;
      const user = currentUser(req);
      if (!(await canAccessProject(user, projectId, true)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const rows = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      if (!rows.length) return notFound(res, "Project");
      return res.json({ project: rows[0] });
    }),
  );

  app.post(
    "/projects",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const parsed = projectCreateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const project = {
        id: randomUUID(),
        companyId: currentUser(req).companyId,
        ...parsed.data,
      };
      const result = await createProjectWithinPlanLimit(
        currentUser(req).companyId,
        project,
      );
      if (!result.allowed)
        return res.status(402).json(
          limitError({
            allowed: false,
            code: result.code,
            message: "The current plan project limit has been reached",
          }),
        );
      return res.status(201).json({ project });
    }),
  );

  app.patch(
    "/projects/:id",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const projectId = parseParamId(req, res);
      if (!projectId) return;
      const parsed = projectUpdateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const existing = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      if (!existing.length) return notFound(res, "Project");
      await db
        .update(projects)
        .set(parsed.data)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, currentUser(req).companyId),
          ),
        );
      const updated = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      return res.json({ project: updated[0] });
    }),
  );

  app.delete(
    "/projects/:id",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const projectId = parseParamId(req, res);
      if (!projectId) return;
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const existing = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      if (!existing.length) return notFound(res, "Project");
      await db
        .delete(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, currentUser(req).companyId),
          ),
        );
      return res.status(204).send();
    }),
  );

  app.get(
    "/project-assignments",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const projectId = parseOptionalQueryId(req, res, "projectId");
      if (projectId === null) return;
      const filters = [eq(projectAssignments.companyId, user.companyId)];
      if (projectId) filters.push(eq(projectAssignments.projectId, projectId));
      if (user.role !== "admin")
        filters.push(eq(projectAssignments.userId, user.uuid));
      const rows = await db
        .select()
        .from(projectAssignments)
        .where(filters.length ? and(...filters) : undefined);
      return res.json({ assignments: rows });
    }),
  );

  app.post(
    "/project-assignments",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const parsed = assignmentSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      if (
        !(await projectExists(
          parsed.data.projectId,
          currentUser(req).companyId,
        ))
      )
        return notFound(res, "Project");
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const targetUser = await db
        .select({ uuid: users.uuid })
        .from(users)
        .where(
          and(
            eq(users.uuid, parsed.data.userId),
            eq(users.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      if (!targetUser.length) return notFound(res, "User");
      const assignment = {
        id: randomUUID(),
        companyId: currentUser(req).companyId,
        ...parsed.data,
      };
      await db.insert(projectAssignments).values(assignment);
      return res.status(201).json({ assignment });
    }),
  );

  app.patch(
    "/project-assignments/:id",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const assignmentId = parseParamId(req, res);
      if (!assignmentId) return;
      const parsed = assignmentUpdateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const existing = await db
        .select()
        .from(projectAssignments)
        .where(
          and(
            eq(projectAssignments.id, assignmentId),
            eq(projectAssignments.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      if (!existing.length) return notFound(res, "Assignment");
      await db
        .update(projectAssignments)
        .set(parsed.data)
        .where(
          and(
            eq(projectAssignments.id, assignmentId),
            eq(projectAssignments.companyId, currentUser(req).companyId),
          ),
        );
      const updated = await db
        .select()
        .from(projectAssignments)
        .where(
          and(
            eq(projectAssignments.id, assignmentId),
            eq(projectAssignments.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      return res.json({ assignment: updated[0] });
    }),
  );

  app.delete(
    "/project-assignments/:id",
    requireRole(["admin"]),
    asyncHandler(async (req, res) => {
      const assignmentId = parseParamId(req, res);
      if (!assignmentId) return;
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      await db
        .delete(projectAssignments)
        .where(
          and(
            eq(projectAssignments.id, assignmentId),
            eq(projectAssignments.companyId, currentUser(req).companyId),
          ),
        );
      return res.status(204).send();
    }),
  );

  app.get(
    "/attendance",
    requireRole(["admin", "supervisor", "worker"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const filters = [eq(attendance.companyId, user.companyId)];
      const projectId = parseOptionalQueryId(req, res, "projectId");
      if (projectId === null) return;
      if (projectId) {
        if (!(await canAccessProject(user, projectId)))
          return res.status(403).json({
            error: { code: "FORBIDDEN", message: "Project access denied" },
          });
        filters.push(eq(attendance.projectId, projectId));
      } else if (user.role !== "admin") {
        const ids = await assignedProjectIds(user);
        if (!ids.length) return res.json({ attendance: [] });
        filters.push(inArray(attendance.projectId, ids));
      }
      if (user.role === "worker")
        filters.push(eq(attendance.userId, user.uuid));
      const rows = await db
        .select({
          id: attendance.id,
          userId: attendance.userId,
          projectId: attendance.projectId,
          workDate: attendance.workDate,
          checkIn: attendance.checkIn,
          checkOut: attendance.checkOut,
          userName: users.name,
          userEmail: users.email,
          projectName: projects.name,
        })
        .from(attendance)
        .innerJoin(users, eq(attendance.userId, users.uuid))
        .innerJoin(projects, eq(attendance.projectId, projects.id))
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(attendance.workDate));
      return res.json({ attendance: rows });
    }),
  );

  app.post(
    "/attendance/check-in",
    requireRole(["admin", "supervisor", "worker"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const parsed = attendanceSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const targetUserId = parsed.data.userId ?? user.uuid;
      if (!canCreateAttendanceFor(user, targetUserId))
        return res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "Workers may only create their own attendance",
          },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const targetUser = await db
        .select({ uuid: users.uuid })
        .from(users)
        .where(
          and(
            eq(users.uuid, targetUserId),
            eq(users.companyId, user.companyId),
          ),
        )
        .limit(1);
      if (!targetUser.length) return notFound(res, "User");
      if (!(await canAccessProject(user, parsed.data.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const row = {
        id: randomUUID(),
        companyId: user.companyId,
        userId: targetUserId,
        projectId: parsed.data.projectId,
        workDate: parsed.data.workDate,
        checkIn: parsed.data.checkIn ?? new Date(),
      };
      await db.insert(attendance).values(row);
      return res.status(201).json({ attendance: row });
    }),
  );

  app.post(
    "/attendance/:id/check-out",
    requireRole(["admin", "supervisor", "worker"]),
    asyncHandler(async (req, res) => {
      const attendanceId = parseParamId(req, res);
      if (!attendanceId) return;
      const user = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const rows = await db
        .select()
        .from(attendance)
        .where(
          and(
            eq(attendance.id, attendanceId),
            eq(attendance.companyId, user.companyId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return notFound(res, "Attendance record");
      if (user.role === "worker" && row.userId !== user.uuid)
        return res.status(403).json({
          error: {
            code: "FORBIDDEN",
            message: "Workers may only check out their own attendance",
          },
        });
      if (!(await canAccessProject(user, row.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      await db
        .update(attendance)
        .set({ checkOut: new Date() })
        .where(
          and(
            eq(attendance.id, attendanceId),
            eq(attendance.companyId, user.companyId),
          ),
        );
      const updated = await db
        .select()
        .from(attendance)
        .where(
          and(
            eq(attendance.id, attendanceId),
            eq(attendance.companyId, user.companyId),
          ),
        )
        .limit(1);
      return res.json({ attendance: updated[0] });
    }),
  );

  app.get(
    "/materials",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const projectId = parseOptionalQueryId(req, res, "projectId");
      if (projectId === null) return;
      if (projectId && !(await canAccessProject(user, projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      if (projectId)
        return res.json({
          materials: await db
            .select()
            .from(materials)
            .where(
              and(
                eq(materials.projectId, projectId),
                eq(materials.companyId, user.companyId),
              ),
            ),
        });
      if (user.role === "admin")
        return res.json({
          materials: await db
            .select()
            .from(materials)
            .where(eq(materials.companyId, user.companyId)),
        });
      const ids = await assignedProjectIds(user);
      return res.json({
        materials: ids.length
          ? await db
              .select()
              .from(materials)
              .where(
                and(
                  inArray(materials.projectId, ids),
                  eq(materials.companyId, user.companyId),
                ),
              )
          : [],
      });
    }),
  );

  app.post(
    "/materials",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const parsed = materialSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      if (!(await canAccessProject(user, parsed.data.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const material = {
        id: randomUUID(),
        companyId: user.companyId,
        ...parsed.data,
      };
      await db.insert(materials).values(material);
      return res.status(201).json({ material });
    }),
  );

  app.get(
    "/materials/low-stock",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const feature = limitError(
        await assertFeature(user.companyId, "materials"),
      );
      if (feature) return res.status(402).json(feature);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const rows = await db
        .select()
        .from(materials)
        .where(
          and(
            eq(materials.companyId, user.companyId),
            sql`${materials.quantity} <= ${materials.minimumStock}`,
          ),
        );
      return res.json({ materials: rows });
    }),
  );

  app.patch(
    "/materials/:id",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const materialId = parseParamId(req, res);
      if (!materialId) return;
      const parsed = materialUpdateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = currentUser(req);
      const existing = await findMaterial(materialId, user.companyId);
      if (!existing) return notFound(res, "Material");
      if (!(await canAccessProject(user, existing.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      await db
        .update(materials)
        .set(parsed.data)
        .where(eq(materials.id, materialId));
      const updated = await findMaterial(materialId, user.companyId);
      return res.json({ material: updated });
    }),
  );

  app.delete(
    "/materials/:id",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const materialId = parseParamId(req, res);
      if (!materialId) return;
      const user = currentUser(req);
      const existing = await findMaterial(materialId, user.companyId);
      if (!existing) return notFound(res, "Material");
      if (!(await canAccessProject(user, existing.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      await db.delete(materials).where(eq(materials.id, materialId));
      return res.status(204).send();
    }),
  );

  app.get(
    "/materials/:id/transactions",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const materialId = parseParamId(req, res);
      if (!materialId) return;
      const user = currentUser(req);
      const material = await findMaterial(materialId, user.companyId);
      if (!material) return notFound(res, "Material");
      if (!(await canAccessProject(user, material.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      return res.json({
        transactions: await db
          .select()
          .from(materialTransactions)
          .where(
            and(
              eq(materialTransactions.materialId, materialId),
              eq(materialTransactions.companyId, user.companyId),
            ),
          )
          .orderBy(desc(materialTransactions.txDate)),
      });
    }),
  );

  app.post(
    "/materials/:id/transactions",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const materialId = parseParamId(req, res);
      if (!materialId) return;
      const parsed = transactionSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = currentUser(req);
      const material = await findMaterial(materialId, user.companyId);
      if (!material) return notFound(res, "Material");
      if (!(await canAccessProject(user, material.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const transaction = {
        id: randomUUID(),
        companyId: user.companyId,
        materialId,
        type: parsed.data.type,
        quantity: parsed.data.quantity,
        txDate: parsed.data.txDate ?? new Date(),
        recordedBy: user.uuid,
      };
      await db.insert(materialTransactions).values(transaction);
      return res.status(201).json({ transaction });
    }),
  );

  app.get(
    "/expenses",
    requireRole(["admin", "accountant"]),
    asyncHandler(async (req, res) => {
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const projectId = parseOptionalQueryId(req, res, "projectId");
      if (projectId === null) return;
      const rows = projectId
        ? await db
            .select()
            .from(expenses)
            .where(
              and(
                eq(expenses.projectId, projectId),
                eq(expenses.companyId, currentUser(req).companyId),
              ),
            )
            .orderBy(desc(expenses.expDate))
        : await db
            .select()
            .from(expenses)
            .where(eq(expenses.companyId, currentUser(req).companyId))
            .orderBy(desc(expenses.expDate));
      return res.json({ expenses: rows });
    }),
  );

  app.post(
    "/expenses",
    requireRole(["admin", "accountant"]),
    asyncHandler(async (req, res) => {
      const parsed = expenseSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      if (
        !(await projectExists(
          parsed.data.projectId,
          currentUser(req).companyId,
        ))
      )
        return notFound(res, "Project");
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const expense = {
        id: randomUUID(),
        companyId: currentUser(req).companyId,
        ...parsed.data,
        recordedBy: currentUser(req).uuid,
      };
      await db.insert(expenses).values(expense);
      return res.status(201).json({ expense });
    }),
  );

  app.patch(
    "/expenses/:id",
    requireRole(["admin", "accountant"]),
    asyncHandler(async (req, res) => {
      const expenseId = parseParamId(req, res);
      if (!expenseId) return;
      const parsed = expenseUpdateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const existing = await db
        .select()
        .from(expenses)
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      if (!existing.length) return notFound(res, "Expense");
      await db
        .update(expenses)
        .set(parsed.data)
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.companyId, currentUser(req).companyId),
          ),
        );
      const updated = await db
        .select()
        .from(expenses)
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.companyId, currentUser(req).companyId),
          ),
        )
        .limit(1);
      return res.json({ expense: updated[0] });
    }),
  );

  app.delete(
    "/expenses/:id",
    requireRole(["admin", "accountant"]),
    asyncHandler(async (req, res) => {
      const expenseId = parseParamId(req, res);
      if (!expenseId) return;
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      await db
        .delete(expenses)
        .where(
          and(
            eq(expenses.id, expenseId),
            eq(expenses.companyId, currentUser(req).companyId),
          ),
        );
      return res.status(204).send();
    }),
  );

  app.get(
    "/issues",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const projectId = parseOptionalQueryId(req, res, "projectId");
      if (projectId === null) return;
      if (projectId && !(await canAccessProject(user, projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      if (projectId)
        return res.json({
          issues: await db
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.projectId, projectId),
                eq(issues.companyId, user.companyId),
              ),
            )
            .orderBy(desc(issues.createdAt)),
        });
      if (user.role === "admin")
        return res.json({
          issues: await db
            .select()
            .from(issues)
            .where(eq(issues.companyId, user.companyId))
            .orderBy(desc(issues.createdAt)),
        });
      const ids = await assignedProjectIds(user);
      return res.json({
        issues: ids.length
          ? await db
              .select()
              .from(issues)
              .where(
                and(
                  inArray(issues.projectId, ids),
                  eq(issues.companyId, user.companyId),
                ),
              )
              .orderBy(desc(issues.createdAt))
          : [],
      });
    }),
  );

  app.post(
    "/issues",
    requireRole(["admin", "supervisor"]),
    upload.single("image"),
    asyncHandler(async (req, res) => {
      const parsed = issueSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = currentUser(req);
      if (!(await canAccessProject(user, parsed.data.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      const file = (req as Request & { file?: Express.Multer.File }).file;
      let imageUrl: string | null = null;
      if (file) {
        const stored = await storagePut(
          `${user.uuid}/issues/${randomUUID()}-${file.originalname}`,
          file.buffer,
          file.mimetype,
        );
        imageUrl = stored.url;
      }
      const issue = {
        id: randomUUID(),
        companyId: user.companyId,
        ...parsed.data,
        reportedBy: user.uuid,
        imageUrl,
      };
      await db.insert(issues).values(issue);
      return res.status(201).json({ issue });
    }),
  );

  app.patch(
    "/issues/:id",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const issueId = parseParamId(req, res);
      if (!issueId) return;
      const parsed = issueUpdateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const user = currentUser(req);
      const existing = await findIssue(issueId, user.companyId);
      if (!existing) return notFound(res, "Issue");
      if (!(await canAccessProject(user, existing.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      await db
        .update(issues)
        .set(parsed.data)
        .where(
          and(eq(issues.id, issueId), eq(issues.companyId, user.companyId)),
        );
      const updated = await findIssue(issueId, user.companyId);
      return res.json({ issue: updated });
    }),
  );

  app.delete(
    "/issues/:id",
    requireRole(["admin", "supervisor"]),
    asyncHandler(async (req, res) => {
      const issueId = parseParamId(req, res);
      if (!issueId) return;
      const user = currentUser(req);
      const existing = await findIssue(issueId, user.companyId);
      if (!existing) return notFound(res, "Issue");
      if (!(await canAccessProject(user, existing.projectId)))
        return res.status(403).json({
          error: { code: "FORBIDDEN", message: "Project access denied" },
        });
      const db = await getDb();
      if (!db)
        return res.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Database is unavailable",
          },
        });
      await db
        .delete(issues)
        .where(
          and(eq(issues.id, issueId), eq(issues.companyId, user.companyId)),
        );
      return res.status(204).send();
    }),
  );
}
