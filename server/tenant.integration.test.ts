import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { companies, projects, users } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { app } from "./index";

async function adminCookie() {
  const response = await request(app)
    .post("/auth/login")
    .send({ email: "admin@construction.local", password: "Admin123!" });
  expect(response.status).toBe(200);
  return response.headers["set-cookie"][0].split(";")[0];
}

describe("multi-tenant SaaS boundaries", () => {
  it("registers an unverified company owner without a protected session", async () => {
    const unique = randomUUID().slice(0, 8);
    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "New Owner",
        email: `owner-${unique}@example.test`,
        password: "SecurePassword123!",
        companyName: `New Company ${unique}`,
        companyEmail: `company-${unique}@example.test`,
        phone: "+20 100 123 4567",
      });
    expect(response.status).toBe(201);
    expect(response.body.onboarding).toBe(true);
    expect(response.body.user.role).toBe("admin");
    expect(response.body.user.companyId).toBeTruthy();
    expect(response.headers["set-cookie"]).toBeUndefined();

    const company = await request(app).get("/company");
    expect(company.status).toBe(401);
    const db = await getDb();
    if (!db) throw new Error("Database is required for tenant tests");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.email, `owner-${unique}@example.test`));
  });

  it("does not expose another company's project by list or direct ID", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database is required for tenant tests");
    const companyId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Isolated Company",
      email: `isolated-${companyId}@example.test`,
      phone: null,
      logo: null,
      status: "active",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Private Other-Tenant Project",
      location: "Alexandria",
      status: "active",
      budget: "1000.00",
    });

    const cookie = await adminCookie();
    const list = await request(app).get("/projects").set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(
      list.body.projects.some(
        (project: { id: string }) => project.id === projectId,
      ),
    ).toBe(false);

    const direct = await request(app)
      .get(`/projects/${projectId}`)
      .set("Cookie", cookie);
    expect(direct.status).toBe(403);
  });
});
