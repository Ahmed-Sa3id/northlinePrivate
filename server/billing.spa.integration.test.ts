import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, SPA_LINK_PATHS } from "./index";
import { ensureSpaShell } from "./_test/spaShell";

let releaseShell: () => void = () => undefined;

beforeAll(() => {
  releaseShell = ensureSpaShell();
});

afterAll(() => {
  releaseShell();
});

/**
 * Stripe navigates the browser to these itself once a billing flow ends, and
 * the server deliberately has no catch-all, so an unlisted one answers
 * `Cannot GET` at exactly the moment the customer most needs confirmation:
 *
 *   /billing/success, /billing/cancel — `createCheckoutSession()`'s
 *     `success_url` / `cancel_url`, i.e. *after the payment succeeded*.
 *   /billing — the Customer Portal's `return_url`, set at both call sites in
 *     `platform.ts`, i.e. after a card update or a cancellation.
 *
 * Both halves are needed: `SPA_LINK_PATHS` answers the request, and
 * `sectionForPath()` in `web/main.tsx` opens Billing from the pathname, so a
 * refreshed or provider-supplied URL does not silently fall back to the
 * overview.
 */
const BILLING_RETURN_PATHS = [
  "/billing",
  "/billing/success",
  "/billing/cancel",
];

describe("Stripe billing return routes", () => {
  it("keeps the billing return paths in the server allowlist", () => {
    // Asserted against the exported list rather than a copy of it, so
    // removing a path fails here instead of as a 404 in the browser after a
    // real payment or a portal visit.
    expect([...SPA_LINK_PATHS]).toEqual(
      expect.arrayContaining(BILLING_RETURN_PATHS),
    );
  });

  it.each(BILLING_RETURN_PATHS)(
    "serves the application shell for %s so a direct refresh works",
    async (path) => {
      const response = await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.text).toContain('<div id="root">');
    },
  );

  it("keeps neighbouring paths on a 404 instead of handing them the shell", async () => {
    // The allowlist admits exactly the three paths Stripe navigates to — no
    // more. Broadening it to "anything under /billing", or to a catch-all,
    // would hand the HTML shell to unlisted paths and turn a JSON 404 into a
    // 200 that reads as success to a client.
    for (const path of [
      "/billing/nope",
      "/billing/success/extra",
      "/billingsettings",
    ]) {
      const response = await request(app).get(path);
      expect(response.status, `${path} must stay 404`).toBe(404);
      expect(response.text).not.toContain('<div id="root">');
    }
  });

  it("keeps unrelated unknown paths on a 404", async () => {
    const response = await request(app).get("/checkout/confirmed");
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('<div id="root">');
  });
});
