import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { count } from "drizzle-orm";
import { eq } from "drizzle-orm";
import {
  companies,
  projects,
  rateLimitBuckets,
  users,
} from "../drizzle/schema";
import { getDb } from "./db";
import { app } from "./index";

async function register(prefix: string) {
  const unique = randomUUID().slice(0, 8);
  const response = await request(app)
    .post("/auth/register")
    .send({
      name: `${prefix} Owner`,
      email: `${prefix.toLowerCase()}-${unique}@example.test`,
      password: "SecurePassword123!",
      companyName: `${prefix} Company ${unique}`,
      companyEmail: `${prefix.toLowerCase()}-company-${unique}@example.test`,
      phone: "+20 100 000 0000",
    });
  expect(response.status).toBe(201);
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required");
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.email, `${prefix.toLowerCase()}-${unique}@example.test`));
  const login = await request(app)
    .post("/auth/login")
    .send({
      email: `${prefix.toLowerCase()}-${unique}@example.test`,
      password: "SecurePassword123!",
    });
  expect(login.status).toBe(200);
  return {
    companyId: response.body.user.companyId as string,
    cookie: login.headers["set-cookie"][0].split(";")[0],
  };
}

describe("database concurrency guarantees", () => {
  it("serializes concurrent login rate-limit decisions", async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    await db.delete(rateLimitBuckets);
    const email = `rate-${randomUUID()}@example.test`;
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app)
          .post("/auth/login")
          .send({ email, password: "WrongPassword123!" }),
      ),
    );
    const limited = responses.filter((response) => response.status === 429);
    expect(limited.length).toBeGreaterThanOrEqual(10);
    const buckets = await db.select().from(rateLimitBuckets);
    const matching = buckets.find((bucket) => bucket.key.endsWith(`:${email}`));
    expect(matching).toBeDefined();
    expect(JSON.parse(matching!.attempts)).toHaveLength(10);
  });

  it("never exceeds a concurrent project plan limit", async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const company = await register("ProjectRace");
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        request(app)
          .post("/projects")
          .set("Cookie", company.cookie)
          .send({
            name: `Concurrent project ${index}`,
            location: "Alexandria",
            status: "planned",
            budget: 1000,
          }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    const [{ value }] = await db
      .select({ value: count() })
      .from(projects)
      .where(eq(projects.companyId, company.companyId));
    expect(Number(value)).toBe(1);
  });

  it("never exceeds a concurrent user plan limit", async () => {
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const company = await register("UserRace");
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        request(app)
          .post("/users")
          .set("Cookie", company.cookie)
          .send({
            name: `Concurrent user ${index}`,
            email: `concurrent-${randomUUID()}@example.test`,
            password: "SecurePassword123!",
            role: "worker",
          }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(2);
    const [{ value }] = await db
      .select({ value: count() })
      .from(users)
      .where(eq(users.companyId, company.companyId));
    expect(Number(value)).toBe(3);
  });
});
