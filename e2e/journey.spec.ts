import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { emailVerificationTokens, invitations, users } from "../drizzle/schema";
import { getDb } from "../server/db";

/**
 * The primary journey from PRODUCTION_PLAN #9:
 *
 *   register -> verify email -> login -> onboarding -> first project
 *   -> invite teammate -> accept invite -> attendance/expense/issue
 *   -> billing panel
 *
 * The one thing a browser test cannot do on its own is receive email: the
 * tokens are stored as `sha256(plaintext)` and cannot be recovered, and the
 * transport is deliberately suppressed in this harness (see
 * `playwright.config.ts`). So the spec *substitutes the delivery step only* —
 * it writes a token it knows and then drives the real link. Everything the
 * user's click would trigger afterwards is the production path: the real
 * deep route, the real API, the real single-use check, the real session.
 *
 * Delivery itself is covered by `server/email.flows.integration.test.ts` and
 * was proven against the live provider during #4.
 */

const UNIQUE = randomUUID().slice(0, 8);
const OWNER_EMAIL = `journey-owner-${UNIQUE}@example.test`;
// Two different people, deliberately. Onboarding step 3 *creates* a user
// outright through `POST /users`, whereas the admin panel's invitation
// creates a pending invite for an address that must not already be taken —
// `POST /invitations` answers 409 `EMAIL_ALREADY_EXISTS` if it is. Reusing
// one address made the invitation step fail against a rule that was working
// correctly.
const ONBOARD_EMAIL = `journey-onboard-${UNIQUE}@example.test`;
const TEAMMATE_EMAIL = `journey-teammate-${UNIQUE}@example.test`;
const OWNER_PASSWORD = "JourneyPassword2026!";
const TEAMMATE_PASSWORD = "TeammatePassword2026!";
const PROJECT_NAME = `Harbour Road ${UNIQUE}`;

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

async function connection() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for the E2E journey");
  return db;
}

async function uuidOf(email: string): Promise<string> {
  const db = await connection();
  const rows = await db
    .select({ uuid: users.uuid })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!rows[0]) throw new Error(`No user row for ${email}`);
  return rows[0].uuid;
}

/** A verification link whose plaintext this test knows, accepted as-is. */
async function verificationLink(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const db = await connection();
  await db.insert(emailVerificationTokens).values({
    userUuid: await uuidOf(OWNER_EMAIL),
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return `/verify-email?token=${encodeURIComponent(token)}`;
}

/**
 * Points the invitation row the admin just created at a token this test
 * knows. Updated in place rather than inserted so there stays exactly one
 * invitation per address, which is what the admin panel then lists.
 */
async function invitationLink(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const db = await connection();
  const existing = await db
    .select({ id: invitations.id, acceptedAt: invitations.acceptedAt })
    .from(invitations)
    .where(eq(invitations.email, TEAMMATE_EMAIL))
    .limit(1);
  if (!existing[0]) throw new Error("No invitation row was created");
  expect(existing[0].acceptedAt).toBeNull();
  await db
    .update(invitations)
    .set({ tokenHash: hash(token) })
    .where(
      and(
        eq(invitations.email, TEAMMATE_EMAIL),
        isNull(invitations.acceptedAt),
      ),
    );
  return `/accept-invitation?token=${encodeURIComponent(token)}`;
}

test.describe("primary journey", () => {
  test("register, verify, onboard, invite, accept and record site data", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await test.step("sign up for a workspace", async () => {
      await page.goto("/");
      await page
        .getByRole("button", { name: "Start free", exact: true })
        .click();
      await page.getByLabel("Your name").fill("Journey Owner");
      await page.getByLabel("Company name").fill(`Harbour Build ${UNIQUE}`);
      await page
        .getByLabel("Company email")
        .fill(`build-${UNIQUE}@example.test`);
      await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
      await page.getByLabel("Password").fill(OWNER_PASSWORD);
      await page.getByRole("button", { name: "Create workspace" }).click();

      // Sending is switched off in this harness, so this is the non-fatal
      // branch: the account exists and the UI says so rather than throwing.
      await expect(
        page.getByRole("heading", { name: "Verify your email address." }),
      ).toBeVisible();
      await expect(
        page.getByText("Your account was created", { exact: false }),
      ).toBeVisible();
    });

    await test.step("verify the emailed link", async () => {
      await page.goto(await verificationLink());
      await page.getByRole("button", { name: "Verify email" }).click();
      await expect(
        page.getByText("Email verified. You can now sign in.", {
          exact: false,
        }),
      ).toBeVisible();

      await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
      await page.getByLabel("Password").fill(OWNER_PASSWORD);
      await page.getByRole("button", { name: "Enter workspace" }).click();
    });

    await test.step("run the setup wizard to a first project", async () => {
      await expect(
        page.getByRole("heading", { name: "Your company is ready." }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Create first project" }).click();
      await page.getByLabel("Project name").fill(PROJECT_NAME);
      await page.getByLabel("Location").fill("Docklands, berth 4");
      await page.getByLabel("Budget").fill("250000");
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByRole("heading", { name: "Invite your first teammate." }),
      ).toBeVisible();
      await page.getByLabel("Name").fill("Site Teammate");
      await page.getByLabel("Email", { exact: true }).fill(ONBOARD_EMAIL);
      await page.getByLabel("Temporary password").fill(TEAMMATE_PASSWORD);
      await page
        .getByRole("button", { name: "Add teammate and open dashboard" })
        .click();

      await expect(page.locator(".app-shell")).toBeVisible();
    });

    await test.step("invite a teammate by email and accept it", async () => {
      await page.getByRole("button", { name: "Admin & audit" }).click();

      // Regression guard for the empty-workspace bug: these panels used to be
      // awaited through one `Promise.all`, so the free plan's 402 from
      // `/audit` and `/materials` rejected the batch and threw away every
      // other result — no project to invite against, no users, nothing. The
      // gate has to surface as information instead of blanking the app.
      await expect(
        page.getByText("audit is not included in the current plan"),
      ).toBeVisible();
      const inviteProject = page
        .locator("select")
        .filter({ hasText: "No project yet" });
      await expect(inviteProject).toContainText(PROJECT_NAME);

      // Inviting *to* the project is what writes a project assignment when
      // the invitee accepts. Without it a worker fails `canAccessProject`
      // and cannot record attendance at all.
      await inviteProject.selectOption({ label: PROJECT_NAME });
      await page.getByPlaceholder("teammate@company.com").fill(TEAMMATE_EMAIL);
      await page.getByRole("button", { name: "Send invitation" }).click();
      await expect(
        page.getByText("Invitation sent.", { exact: false }),
      ).toBeVisible();

      await page.goto(await invitationLink());
      await page.getByLabel("Your name").fill("Site Teammate");
      await page.getByLabel("Password").fill(TEAMMATE_PASSWORD);
      await page.getByRole("button", { name: "Join workspace" }).click();

      // The invitee lands in the same workspace, on the worker's view of it.
      await expect(page.locator(".app-shell")).toBeVisible();
      await expect(
        page.locator(".nav", { hasText: "Attendance" }),
      ).toBeVisible();
    });

    await test.step("the teammate records attendance", async () => {
      await page.getByRole("button", { name: "Attendance" }).click();
      const panel = page.locator("section.panel", {
        has: page.getByRole("heading", { name: "Log attendance" }),
      });
      await panel
        .locator('select[name="projectId"]')
        .selectOption({ index: 1 });
      await panel.getByRole("button", { name: "Save record" }).click();

      // Scope the assertion to the log itself. The project name also lives in
      // the form's `<select>`, and an `<option>` is never visible, so an
      // unscoped `getByText(...).first()` resolved to a hidden option and
      // failed even once the record was there. Matching the row's `<small>`
      // inside the log panel proves the save actually landed — a rejected
      // save leaves the log empty.
      const log = page.locator("section.panel", {
        has: page.getByRole("heading", { name: "Attendance log" }),
      });
      await expect(log).toBeVisible();
      await expect(log.getByText(PROJECT_NAME)).toBeVisible();
    });

    await test.step("the owner records an expense and a safety issue", async () => {
      // Expenses and issues are admin/supervisor/accountant only, so the
      // owner has to sign back in — the worker view cannot reach them.
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
      await page.getByLabel("Password").fill(OWNER_PASSWORD);
      await page.getByRole("button", { name: "Enter workspace" }).click();
      await expect(page.locator(".app-shell")).toBeVisible();

      await page.getByRole("button", { name: "Finance" }).click();
      const expense = page.locator("section.panel", {
        has: page.getByRole("heading", { name: "Record expense" }),
      });
      await expense
        .locator('select[name="projectId"]')
        .selectOption({ index: 1 });
      await expense.getByPlaceholder("Category").fill("Structural steel");
      await expense.getByPlaceholder("Amount").fill("18400.5");
      await expense.getByRole("button", { name: "Save record" }).click();
      // The saved row lands in the list panel, not the form panel — assert
      // against that, or the form's own `Category` text is what you find.
      const expenseLog = page.locator("section.panel", {
        has: page.getByRole("heading", { name: "Expenses" }),
      });
      await expect(expenseLog.getByText("Structural steel")).toBeVisible();

      await page.getByRole("button", { name: "Safety issues" }).click();
      const issue = page.locator("section.panel", {
        has: page.getByRole("heading", { name: "Report safety issue" }),
      });
      await issue
        .locator('select[name="projectId"]')
        .selectOption({ index: 1 });
      await issue
        .getByPlaceholder("Describe the issue")
        .fill("Unguarded edge at level 3 slab opening");
      await issue.getByRole("button", { name: "Save record" }).click();
      await expect(
        page.getByText("Unguarded edge at level 3 slab opening"),
      ).toBeVisible();
    });

    await test.step("opens the billing panel", async () => {
      await page.getByRole("button", { name: "Billing" }).click();
      await expect(page.locator(".billing-panel")).toBeVisible();
      // The refund policy is reachable from billing, not just from the app
      // footer — this is the "in-app path" requirement of #10.
      await expect(
        page.getByRole("link", { name: "Refund & cancellation policy" }),
      ).toBeVisible();
    });

    await test.step("the Stripe return URL survives a direct navigation", async () => {
      // Stripe's redirect is a fresh document load, not an in-app state
      // change: it arrives as `page.goto()` would, with no session-side
      // navigation to lean on. Both halves have to hold or the customer who
      // has *just paid* lands somewhere wrong — the server must serve the
      // shell (these used to 404) and the workspace must open Billing from
      // the pathname rather than the default overview.
      const success = await page.goto("/billing/success");
      expect(success?.status()).toBe(200);
      await expect(page.locator(".billing-panel")).toBeVisible();

      const cancelled = await page.goto("/billing/cancel");
      expect(cancelled?.status()).toBe(200);
      await expect(page.locator(".billing-panel")).toBeVisible();

      // The Customer Portal's `return_url`, at both call sites in
      // `platform.ts`. This is the leg that survived checkout's fix and still
      // 404ed, because it was never part of the checkout redirect.
      const portal = await page.goto("/billing");
      expect(portal?.status()).toBe(200);
      await expect(page.locator(".billing-panel")).toBeVisible();
    });
  });
});
