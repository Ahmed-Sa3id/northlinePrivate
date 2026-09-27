import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  emailVerificationTokens,
  passwordResetTokens,
  sessions,
  users,
} from "../drizzle/schema";
import { getDb, getUserByEmail } from "./db";
import { app } from "./index";

const password = "SecurePassword123!";
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

async function register(prefix: string) {
  const unique = randomUUID().slice(0, 8);
  const email = `${prefix.toLowerCase()}-${unique}@example.test`;
  const response = await request(app)
    .post("/auth/register")
    .send({
      name: `${prefix} Owner`,
      email,
      password,
      companyName: `${prefix} Company ${unique}`,
      companyEmail: `${prefix.toLowerCase()}-company-${unique}@example.test`,
      phone: "+20 100 000 0000",
    });
  expect(response.status).toBe(201);
  const user = await getUserByEmail(email);
  if (!user) throw new Error("registration user missing");
  return { email, user };
}

async function verifyUser(email: string) {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required");
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.email, email));
}

async function login(email: string) {
  const response = await request(app)
    .post("/auth/login")
    .send({ email, password });
  expect(response.status).toBe(200);
  return response;
}

describe("Part 2 authentication and account lifecycle", () => {
  it("requires verification before protected access and supports single-use verification", async () => {
    const account = await register("Verify");
    const blocked = await request(app).post("/auth/login").send({
      email: account.email,
      password,
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const token = `verification-${randomUUID()}-secure-token`;
    await db.insert(emailVerificationTokens).values({
      userUuid: account.user.uuid,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const verified = await request(app)
      .post("/auth/verify-email")
      .send({ token });
    expect(verified.status).toBe(200);
    expect(
      (await request(app).post("/auth/verify-email").send({ token })).status,
    ).toBe(400);
    expect((await login(account.email)).status).toBe(200);
  });

  it("resends verification generically and invalidates prior unconsumed tokens", async () => {
    const account = await register("Resend");
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const oldToken = `old-${randomUUID()}-verification-token`;
    await db.insert(emailVerificationTokens).values({
      userUuid: account.user.uuid,
      tokenHash: hashToken(oldToken),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await request(app)
      .post("/auth/resend-verification")
      .send({ email: account.email });
    expect(response.status).toBe(200);
    expect(response.body.message).toContain("If an unverified account exists");
    const old = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, hashToken(oldToken)));
    expect(old[0]?.usedAt).not.toBeNull();
  });

  it("revokes only the intended browser session and prevents reuse after logout", async () => {
    const account = await register("Session");
    await verifyUser(account.email);
    const first = await login(account.email);
    const second = await login(account.email);
    const firstCookie = first.headers["set-cookie"][0].split(";")[0];
    const secondCookie = second.headers["set-cookie"][0].split(";")[0];
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const cookieValue = (cookie: string) => cookie.split("=")[1];
    const sessionHash = (cookie: string) =>
      createHash("sha256").update(cookieValue(cookie)).digest("hex");
    const secondRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.tokenHash, sessionHash(secondCookie)))
      .limit(1);
    const sessionList = await request(app)
      .get("/auth/sessions")
      .set("Cookie", firstCookie);
    expect(sessionList.status).toBe(200);
    expect(sessionList.body.sessions.length).toBeGreaterThanOrEqual(2);
    const secondSession = sessionList.body.sessions.find(
      (session: { id: string }) => session.id === secondRows[0]?.id,
    );
    expect(secondSession).toBeDefined();
    expect(
      (
        await request(app)
          .delete(`/auth/sessions/${secondSession.id}`)
          .set("Cookie", firstCookie)
      ).status,
    ).toBe(204);
    expect(
      (await request(app).get("/auth/me").set("Cookie", secondCookie)).status,
    ).toBe(401);
    expect(
      (await request(app).post("/auth/logout").set("Cookie", firstCookie))
        .status,
    ).toBe(204);
    expect(
      (await request(app).get("/auth/me").set("Cookie", firstCookie)).status,
    ).toBe(401);
  });

  it("consumes a password-reset token atomically under concurrent replay", async () => {
    const account = await register("Reset");
    await verifyUser(account.email);
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const token = `reset-${randomUUID()}-secure-token`;
    await db.insert(passwordResetTokens).values({
      userUuid: account.user.uuid,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(app)
          .post("/auth/reset-password")
          .send({ token, password: "NewSecurePassword123!" }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 400),
    ).toHaveLength(1);
    const replay = await request(app)
      .post("/auth/reset-password")
      .send({ token, password: "AnotherSecurePassword123!" });
    expect(replay.status).toBe(400);
  });

  it("guides a fresh admin into setup, and nobody else", async () => {
    // Regression: `POST /auth/register` returned `onboarding: true`, but
    // neither `/auth/login` nor `/auth/me` ever carried the flag — so
    // `Root` always rendered the dashboard and `Onboarding.tsx` plus the
    // `/onboarding/project` route were unreachable dead code.
    const account = await register("Onboard");
    await verifyUser(account.email);

    const first = await login(account.email);
    expect(first.body.onboarding).toBe(true);
    const cookie = first.headers["set-cookie"][0].split(";")[0];

    // `/auth/me` has to agree with sign-in, or a refresh halfway through the
    // wizard would silently drop the owner on an empty dashboard.
    const me = await request(app).get("/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.onboarding).toBe(true);

    // An invited worker must never be routed to a wizard whose second step is
    // `requireRole(["admin"])` and would answer 403. `POST /users` marks the
    // account verified, so they can sign in straight away.
    const workerEmail = `onboard-worker-${randomUUID().slice(0, 8)}@example.test`;
    const invited = await request(app)
      .post("/users")
      .set("Cookie", cookie)
      .send({
        name: "Site Worker",
        email: workerEmail,
        password,
        role: "worker",
      });
    expect(invited.status).toBe(201);
    expect((await login(workerEmail)).body.onboarding).toBe(false);

    // Creating the first project is what completes setup.
    const created = await request(app)
      .post("/onboarding/project")
      .set("Cookie", cookie)
      .send({
        name: "First build",
        location: "Site A",
        budget: 250000,
        status: "planned",
      });
    expect(created.status).toBe(201);
    expect((await login(account.email)).body.onboarding).toBe(false);
    const after = await request(app).get("/auth/me").set("Cookie", cookie);
    expect(after.body.onboarding).toBe(false);
  });

  it("keeps password-change behavior explicit: current session remains, other sessions revoke", async () => {
    const account = await register("Change");
    await verifyUser(account.email);
    const current = await login(account.email);
    const other = await login(account.email);
    const currentCookie = current.headers["set-cookie"][0].split(";")[0];
    const otherCookie = other.headers["set-cookie"][0].split(";")[0];
    const changed = await request(app)
      .post("/auth/change-password")
      .set("Cookie", currentCookie)
      .send({
        currentPassword: password,
        newPassword: "ChangedSecurePassword123!",
      });
    expect(changed.status).toBe(200);
    expect(
      (await request(app).get("/auth/me").set("Cookie", currentCookie)).status,
    ).toBe(200);
    expect(
      (await request(app).get("/auth/me").set("Cookie", otherCookie)).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/auth/login")
          .send({ email: account.email, password })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/auth/login")
          .send({ email: account.email, password: "ChangedSecurePassword123!" })
      ).status,
    ).toBe(200);
  });
});
