import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb, getUserByEmail } from "./db";
import { app } from "./index";
import { emailSends } from "./_core/metrics";
import { ensureSpaShell } from "./_test/spaShell";

const apiKey = "re_integration_test_key_9876543210";
const sender = "Northline <no-reply@sender.test>";

const saved = {
  RESEND_API_KEY: undefined as string | undefined,
  EMAIL_FROM: undefined as string | undefined,
};

let fetchMock: ReturnType<typeof vi.fn>;
let releaseShell: () => void = () => undefined;

beforeAll(() => {
  releaseShell = ensureSpaShell();
});

afterAll(() => {
  releaseShell();
});

beforeEach(() => {
  saved.RESEND_API_KEY = process.env.RESEND_API_KEY;
  saved.EMAIL_FROM = process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  fetchMock = vi.fn();
  emailSends.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.RESEND_API_KEY = saved.RESEND_API_KEY;
  process.env.EMAIL_FROM = saved.EMAIL_FROM;
});

/** Arms the provider stub and points the app at it for this test. */
function armProvider(respond: () => Promise<Response>) {
  process.env.RESEND_API_KEY = apiKey;
  process.env.EMAIL_FROM = sender;
  fetchMock.mockImplementation(respond);
  vi.stubGlobal("fetch", fetchMock);
}

function rejectProvider(status: number, body: unknown) {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

describe("email deep links", () => {
  it.each(["/verify-email", "/reset-password", "/accept-invitation"])(
    "serves the application shell for %s so the emailed link resolves",
    async (linkPath) => {
      const response = await request(app).get(`${linkPath}?token=abc123`);
      expect(response.status).toBe(200);
      expect(response.text).toContain('<div id="root">');
      expect(response.headers["content-type"]).toContain("text/html");
    },
  );

  it("keeps unknown paths on a 404 instead of handing them the shell", async () => {
    const response = await request(app).get("/definitely-not-a-route");
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('<div id="root">');
  });
});

describe("registration when the email provider rejects the sender", () => {
  it("still creates the account and reports the undelivered mail", async () => {
    armProvider(
      rejectProvider(403, {
        name: "validation_error",
        message: "The sender.test domain is not verified.",
      }),
    );
    const unique = randomUUID().slice(0, 8);
    const email = `undelivered-${unique}@example.test`;

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Undelivered Owner",
        email,
        password: "SecurePassword123!",
        companyName: `Undelivered ${unique}`,
        companyEmail: `undelivered-company-${unique}@example.test`,
      });

    // The account row and its token are already committed; a 500 here would
    // leave a user who cannot re-register and cannot resend.
    expect(response.status).toBe(201);
    expect(response.body.emailDelivered).toBe(false);
    expect(response.body.verificationRequired).toBe(true);
    expect(response.body.error).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(apiKey);

    const user = await getUserByEmail(email);
    expect(user).toBeTruthy();
    expect(user?.emailVerifiedAt).toBeNull();
    // Still blocked from signing in: the gate is the verified flag, not the
    // fact that mail went out.
    const login = await request(app)
      .post("/auth/login")
      .send({ email, password: "SecurePassword123!" });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("EMAIL_NOT_VERIFIED");

    expect(emailSends.get({ flow: "verification", result: "failed" })).toBe(1);
  });

  it("reports a delivered verification email when the provider accepts it", async () => {
    armProvider(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "email-id" }), { status: 200 }),
      ),
    );
    const unique = randomUUID().slice(0, 8);
    const email = `delivered-${unique}@example.test`;

    const response = await request(app)
      .post("/auth/register")
      .send({
        name: "Delivered Owner",
        email,
        password: "SecurePassword123!",
        companyName: `Delivered ${unique}`,
        companyEmail: `delivered-company-${unique}@example.test`,
      });

    expect(response.status).toBe(201);
    expect(response.body.emailDelivered).toBe(true);
    expect(emailSends.get({ flow: "verification", result: "delivered" })).toBe(
      1,
    );
  });
});

describe("invitation when the email provider is unreachable", () => {
  it("still creates the invitation the admin can resend later", async () => {
    const unique = randomUUID().slice(0, 8);
    const ownerEmail = `invite-owner-${unique}@example.test`;
    const registered = await request(app)
      .post("/auth/register")
      .send({
        name: "Invitation Owner",
        email: ownerEmail,
        password: "SecurePassword123!",
        companyName: `Invitation Company ${unique}`,
        companyEmail: `invite-company-${unique}@example.test`,
      });
    expect(registered.status).toBe(201);

    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.email, ownerEmail));
    const login = await request(app)
      .post("/auth/login")
      .send({ email: ownerEmail, password: "SecurePassword123!" });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"][0].split(";")[0];

    // The provider goes away between registration and the invitation.
    armProvider(() => Promise.reject(new Error("connect ETIMEDOUT")));
    emailSends.reset();

    const invited = `invited-${unique}@example.test`;
    const created = await request(app)
      .post("/invitations")
      .set("Cookie", cookie)
      .send({ email: invited, role: "worker" });

    expect(created.status).toBe(201);
    expect(created.body.invitation.email).toBe(invited);
    expect(created.body.emailDelivered).toBe(false);
    expect(JSON.stringify(created.body)).not.toContain(apiKey);

    // The invitation survives, so the admin's resend control remains usable.
    const listed = await request(app).get("/invitations").set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(
      listed.body.invitations.some(
        (item: { id: string }) => item.id === created.body.invitation.id,
      ),
    ).toBe(true);
    expect(emailSends.get({ flow: "invitation", result: "failed" })).toBe(1);
  });
});
