import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { LEGAL_PATHS } from "../web/Legal";
import { app } from "./index";
import { ensureSpaShell } from "./_test/spaShell";

let releaseShell: () => void = () => undefined;

beforeAll(() => {
  releaseShell = ensureSpaShell();
});

afterAll(() => {
  releaseShell();
});

describe("legal and support pages", () => {
  it("publishes every document the plan requires", () => {
    // PRODUCTION_PLAN #10: terms, privacy, support, refund/cancellation.
    // Asserted against the frontend's own list rather than a copy of it, so
    // deleting a document fails here instead of quietly unlinking it.
    expect([...LEGAL_PATHS]).toEqual(
      expect.arrayContaining(["/terms", "/privacy", "/support", "/refunds"]),
    );
  });

  // The list is imported from `web/Legal.tsx` and walked against the running
  // server, which is what keeps it in step with `SPA_LINK_PATHS` in
  // `server/index.ts`. A path added on one side only fails here rather than
  // as a 404 in the browser.
  it.each([...LEGAL_PATHS])(
    "serves the application shell for %s",
    async (path) => {
      const response = await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.text).toContain('<div id="root">');
    },
  );

  it("keeps unknown paths on a 404 instead of handing them the shell", async () => {
    // The allowlist is deliberately narrow. If it broadened to "anything that
    // looks like a page", a typo would return 200 with the SPA inside and the
    // real routing bug would surface as a blank screen instead.
    const response = await request(app).get("/terms-and-conditions-draft");
    expect(response.status).toBe(404);
    expect(response.text).not.toContain('<div id="root">');
  });
});
