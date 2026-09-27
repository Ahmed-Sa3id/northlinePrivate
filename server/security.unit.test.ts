import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb } from "./db";
import { app } from "./index";
import { canCreateAttendanceFor } from "./routes/platform";

describe("security regressions", () => {
  it("rejects malformed login payloads without leaking implementation details", async () => {
    const response = await request(app)
      .post("/auth/login")
      .send({ email: "not-an-email", password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    expect(JSON.stringify(response.body)).not.toContain("DATABASE_URL");
  });

  it("rate limits repeated login attempts", async () => {
    const email = `security-${randomUUID()}@example.test`;
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await request(app)
        .post("/auth/login")
        .send({ email, password: "short" });
      last = response.status;
    }
    expect(last).toBe(429);
  });

  it("never spends the lockout allowance on successful logins", async () => {
    // Regression: the limiter consumed an attempt before the handler ran and
    // nothing ever handed it back, so the 10th *correct* sign-in inside
    // LOGIN_RATE_WINDOW_MS locked a legitimate user out for
    // LOGIN_RATE_BLOCK_MS — while an attacker who stopped after nine wrong
    // passwords was never blocked at all. Success must reset the bucket.
    const unique = randomUUID().slice(0, 8);
    const email = `repeat-signin-${unique}@example.test`;
    const password = "SecurePassword123!";
    const registered = await request(app)
      .post("/auth/register")
      .send({
        name: "Repeat Sign-In",
        email,
        password,
        companyName: `Repeat Company ${unique}`,
        companyEmail: `repeat-company-${unique}@example.test`,
      });
    expect(registered.status).toBe(201);

    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.email, email));

    // LOGIN_RATE_MAX_ATTEMPTS defaults to 10, so the 11th request is where a
    // counting-only limiter would answer 429.
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await request(app)
        .post("/auth/login")
        .send({ email, password });
      expect(response.status).toBe(200);
    }

    // The reset empties the bucket rather than disabling the control, and it
    // does not leave the client wedged in a blocked state.
    const afterSuccess = await request(app)
      .post("/auth/login")
      .send({ email, password: "WrongPassword123!" });
    expect(afterSuccess.status).toBe(401);
  });

  it("rejects malformed invitation acceptance payloads", async () => {
    const response = await request(app)
      .post("/invitations/accept")
      .send({ token: "too-short", name: "A", password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects requests from unknown origins", async () => {
    const response = await request(app)
      .post("/auth/logout")
      .set("Cookie", "northline_session=opaque-session")
      .set("Origin", "https://attacker.example");
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ORIGIN_REJECTED");
  });

  it("sets browser security headers on API responses", async () => {
    const response = await request(app).get("/livez");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("does not allow workers to create another user's attendance", () => {
    expect(
      canCreateAttendanceFor({ role: "worker", uuid: "worker-a" }, "worker-b"),
    ).toBe(false);
    expect(
      canCreateAttendanceFor({ role: "worker", uuid: "worker-a" }, "worker-a"),
    ).toBe(true);
    expect(
      canCreateAttendanceFor(
        { role: "supervisor", uuid: "supervisor-a" },
        "worker-b",
      ),
    ).toBe(true);
  });
});
