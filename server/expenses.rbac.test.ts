import { describe, expect, it } from "vitest";
import { app, request, session } from "./rbac.test-helpers";

describe("expenses RBAC", () => {
  it("requires auth and allows accountants", async () => {
    expect((await request(app).get("/expenses")).status).toBe(401);
    const cookie = await session(
      "accountant@construction.local",
      "Accountant123!",
    );
    expect(
      (await request(app).get("/expenses").set("Cookie", cookie)).status,
    ).toBe(200);
  });
  it("denies workers", async () => {
    const cookie = await session("worker@construction.local", "Worker123!");
    expect(
      (await request(app).get("/expenses").set("Cookie", cookie)).status,
    ).toBe(403);
  });
});
