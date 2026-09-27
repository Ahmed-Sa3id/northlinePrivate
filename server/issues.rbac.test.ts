import { describe, expect, it } from "vitest";
import { app, request, session } from "./rbac.test-helpers";

describe("issues RBAC", () => {
  it("requires auth and allows supervisors", async () => {
    expect((await request(app).get("/issues")).status).toBe(401);
    const cookie = await session(
      "supervisor@construction.local",
      "Supervisor123!",
    );
    expect(
      (await request(app).get("/issues").set("Cookie", cookie)).status,
    ).toBe(200);
  });
  it("denies accountants", async () => {
    const cookie = await session(
      "accountant@construction.local",
      "Accountant123!",
    );
    expect(
      (await request(app).get("/issues").set("Cookie", cookie)).status,
    ).toBe(403);
  });
});
