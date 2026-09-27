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
 * `createCheckoutSession()` sets `success_url` / `cancel_url` to these, so
 * Stripe navigates the browser to them *after the payment has succeeded*.
 * They were missing from `SPA_LINK_PATHS`, and the server has no catch-all
 * by design, so the redirect answered `Cannot GET /billing/success` — a
 * customer paid and landed on a 404.
 *
 * Both the shell and the panel are needed: `SPA_LINK_PATHS` answers the
 * request, and `sectionForPath()` in `web/main.tsx` opens Billing from the
 * pathname, so a refreshed or provider-supplied URL does not silently fall
 * back to the overview.
 */
const BILLING_RETURN_PATHS = ["/billing/success", "/billing/cancel"];

describe("Stripe checkout return routes", () => {
  it("keeps the checkout return paths in the server allowlist", () => {
    // Asserted against the exported list rather than a copy of it, so
    // removing a path fails here instead of as a 404 in the browser after a
    // real payment.
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
    // The allowlist admits exactly the two paths Stripe navigates to.
    // Broadening it to "anything under /billing" — or to a catch-all — would
    // hand the HTML shell to unlisted paths and turn a JSON 404 into a 200
    // that reads as success to a client.
    //
    // Bare `/billing` is deliberately NOT allowlisted: it is not part of the
    // Stripe redirect, nothing links to it as a URL (the nav sets the section
    // in-page), and adding it is a separate decision from fixing the redirect.
    for (const path of [
      "/billing",
      "/billing/nope",
      "/billing/success/extra",
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
