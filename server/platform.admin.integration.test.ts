import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
// Must precede `./auth`: `server/index.ts` runs `import "dotenv/config"` as its
// first statement, while `server/_core/env.ts` snapshots `JWT_SECRET` at module
// evaluation time. Importing `./auth` first leaves `ENV.cookieSecret` empty for
// the whole worker and every login fails with "JWT_SECRET must be at least 32
// characters".
import { app } from "./index";
import { auditLogs, companies, users } from "../drizzle/schema";
import { hashPassword } from "./auth";
import { createCredentialUser, getDb } from "./db";

/**
 * Wave 4 / #12 — platform administration has to be provably separate from a
 * company's own `admin` role.
 *
 * The fixture tenant is created and removed here so the shared demo tenant is
 * never suspended while other suites run in parallel against the same
 * database, and so a rerun after a failure starts from a known state.
 */
const COMPANY_EMAIL = "platform-admin-fixture@northline.test";
const OWNER_EMAIL = "platform-admin-owner@northline.test";
const PASSWORD = "PlatformAdmin123!";
const SEEDED_ADMIN_EMAIL = "admin@construction.local";
const SEEDED_ADMIN_PASSWORD = "Admin123!";

let companyId = "";
let ownerCookie = "";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for this test");
  return db;
}

async function login(email: string, password: string) {
  const response = await request(app)
    .post("/auth/login")
    .send({ email, password });
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"]?.[0];
  expect(cookie).toContain("northline_session=");
  return cookie.split(";")[0];
}

async function setPlatformRole(email: string, role: "none" | "admin") {
  const db = await requireDb();
  await db
    .update(users)
    .set({ platformRole: role })
    .where(eq(users.email, email));
}

async function dropFixture() {
  const db = await requireDb();
  // `audit_logs.companyId` is ON DELETE RESTRICT, and the request-level audit
  // hook writes asynchronously on response finish — wait for it to settle
  // before removing the tenant it points at.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await db.delete(auditLogs).where(eq(auditLogs.companyId, companyId));
  await db.delete(users).where(eq(users.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
}

beforeAll(async () => {
  const db = await requireDb();

  // Clear leftovers from an interrupted previous run.
  const stale = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.email, COMPANY_EMAIL))
    .limit(1);
  if (stale.length) {
    companyId = stale[0].id;
    await dropFixture();
  }

  await db.insert(companies).values({
    name: "Platform Admin Fixture",
    email: COMPANY_EMAIL,
    status: "active",
  });
  const created = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.email, COMPANY_EMAIL))
    .limit(1);
  companyId = created[0].id;

  await createCredentialUser({
    companyId,
    name: "Fixture Owner",
    email: OWNER_EMAIL,
    passwordHash: await hashPassword(PASSWORD),
    role: "admin",
    emailVerifiedAt: new Date(),
  });
  ownerCookie = await login(OWNER_EMAIL, PASSWORD);
});

afterAll(async () => {
  await dropFixture();
});

describe("platform administration", () => {
  it("requires authentication for both the list and the status change", async () => {
    const list = await request(app).get("/platform/companies");
    expect(list.status).toBe(401);
    expect(list.body.error.code).toBe("UNAUTHORIZED");

    const patch = await request(app)
      .patch(`/platform/companies/${companyId}/status`)
      .send({ status: "suspended" });
    expect(patch.status).toBe(401);
    expect(patch.body.error.code).toBe("UNAUTHORIZED");
  });

  it("does not treat a company admin as a platform admin", async () => {
    const list = await request(app)
      .get("/platform/companies")
      .set("Cookie", ownerCookie);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe("FORBIDDEN");

    const patch = await request(app)
      .patch(`/platform/companies/${companyId}/status`)
      .set("Cookie", ownerCookie)
      .send({ status: "suspended" });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe("FORBIDDEN");

    // The tenant's real seeded admin is refused too: the gate is the
    // `platformRole` column, never the company `admin` role.
    const seededAdmin = await login(SEEDED_ADMIN_EMAIL, SEEDED_ADMIN_PASSWORD);
    const asSeededAdmin = await request(app)
      .get("/platform/companies")
      .set("Cookie", seededAdmin);
    expect(asSeededAdmin.status).toBe(403);
    expect(asSeededAdmin.body.error.code).toBe("FORBIDDEN");

    // Nothing above may have moved the tenant: the fixture is still active.
    const untouched = await request(app)
      .get("/company")
      .set("Cookie", ownerCookie);
    expect(untouched.status).toBe(200);
    expect(untouched.body.company.status).toBe("active");
  });

  it("grants access only through platformRole, and never leaks credentials", async () => {
    await setPlatformRole(OWNER_EMAIL, "admin");

    const response = await request(app)
      .get("/platform/companies")
      .set("Cookie", ownerCookie);
    expect(response.status).toBe(200);

    const list = response.body.companies;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((entry: { id: string }) => entry.id === companyId)).toBe(
      true,
    );
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual([
        "createdAt",
        "email",
        "id",
        "name",
        "status",
        "updatedAt",
      ]);
    }
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    expect(JSON.stringify(response.body)).not.toContain("platformRole");
  });

  it("suspends a tenant, locks its members out, and still lets the operator work", async () => {
    const patch = await request(app)
      .patch(`/platform/companies/${companyId}/status`)
      .set("Cookie", ownerCookie)
      .send({ status: "suspended" });
    expect(patch.status).toBe(200);
    expect(patch.body.company.id).toBe(companyId);
    expect(patch.body.company.status).toBe("suspended");

    // The tenant's own admin is locked out of the product...
    const tenantRoute = await request(app)
      .get("/company")
      .set("Cookie", ownerCookie);
    expect(tenantRoute.status).toBe(403);
    expect(tenantRoute.body.error.code).toBe("COMPANY_SUSPENDED");

    // ...yet the platform surface deliberately ignores the caller's own
    // company status, so an operator can always reverse a suspension.
    const stillAdministrator = await request(app)
      .get("/platform/companies")
      .set("Cookie", ownerCookie);
    expect(stillAdministrator.status).toBe(200);
  });

  it("reactivates the tenant", async () => {
    const patch = await request(app)
      .patch(`/platform/companies/${companyId}/status`)
      .set("Cookie", ownerCookie)
      .send({ status: "active" });
    expect(patch.status).toBe(200);
    expect(patch.body.company.status).toBe("active");

    const tenantRoute = await request(app)
      .get("/company")
      .set("Cookie", ownerCookie);
    expect(tenantRoute.status).toBe(200);
    expect(tenantRoute.body.company.status).toBe("active");
  });

  it("validates the payload, the id and the target tenant", async () => {
    for (const body of [{ status: "paused" }, {}]) {
      const response = await request(app)
        .patch(`/platform/companies/${companyId}/status`)
        .set("Cookie", ownerCookie)
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }

    // No body at all: `req.body` may be undefined, never assumed to be an object.
    const noBody = await request(app)
      .patch(`/platform/companies/${companyId}/status`)
      .set("Cookie", ownerCookie);
    expect(noBody.status).toBe(400);
    expect(noBody.body.error.code).toBe("VALIDATION_ERROR");

    const malformed = await request(app)
      .patch("/platform/companies/not-a-uuid/status")
      .set("Cookie", ownerCookie)
      .send({ status: "active" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("VALIDATION_ERROR");

    const unknown = await request(app)
      .patch(`/platform/companies/${randomUUID()}/status`)
      .set("Cookie", ownerCookie)
      .send({ status: "active" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses a platform admin whose email is no longer verified", async () => {
    // Same operator, still holding platformRole: "admin" — only the
    // verification timestamp is withdrawn, mirroring `requireRole`.
    const db = await requireDb();
    await db
      .update(users)
      .set({ emailVerifiedAt: null })
      .where(eq(users.email, OWNER_EMAIL));

    const response = await request(app)
      .get("/platform/companies")
      .set("Cookie", ownerCookie);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });
});
