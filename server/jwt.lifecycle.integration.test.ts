import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb } from "./db";
import { app } from "./index";

describe("JWT bearer lifecycle", () => {
  it("keeps bearer behavior explicit: short-lived, HS256-only, and independent from browser logout", async () => {
    const unique = randomUUID().slice(0, 8);
    const password = "SecurePassword123!";
    const email = `jwt-${unique}@example.test`;
    const registration = await request(app)
      .post("/auth/register")
      .send({
        name: "JWT Test User",
        email,
        password,
        companyName: `JWT Company ${unique}`,
        companyEmail: `jwt-company-${unique}@example.test`,
        phone: "+20 100 000 0000",
      });
    expect(registration.status).toBe(201);
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.email, email));
    const login = await request(app)
      .post("/auth/login")
      .send({ email, password });
    expect(login.status).toBe(200);
    const bearer = login.body.token as string;
    const cookie = login.headers["set-cookie"][0].split(";")[0];

    expect(
      (
        await request(app)
          .get("/auth/me")
          .set("Authorization", `Bearer ${bearer}`)
      ).status,
    ).toBe(200);

    const malformed = await request(app)
      .get("/auth/me")
      .set("Authorization", "Bearer not.a.jwt");
    expect(malformed.status).toBe(401);

    const wrongAlgorithm = await new SignJWT({
      authType: "construction-credentials",
      userUuid: registration.body.user.uuid,
    })
      .setProtectedHeader({ alg: "HS384", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    expect(
      (
        await request(app)
          .get("/auth/me")
          .set("Authorization", `Bearer ${wrongAlgorithm}`)
      ).status,
    ).toBe(401);

    const expired = await new SignJWT({
      authType: "construction-credentials",
      userUuid: registration.body.user.uuid,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    expect(
      (
        await request(app)
          .get("/auth/me")
          .set("Authorization", `Bearer ${expired}`)
      ).status,
    ).toBe(401);

    const logout = await request(app)
      .post("/auth/logout")
      .set("Cookie", cookie);
    expect(logout.status).toBe(204);
    expect(
      (
        await request(app)
          .get("/auth/me")
          .set("Authorization", `Bearer ${bearer}`)
      ).status,
    ).toBe(200);
  });
});
