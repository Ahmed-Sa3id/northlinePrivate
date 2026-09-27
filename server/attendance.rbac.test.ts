import { describe, expect, it } from "vitest";
import { app, request, session } from "./rbac.test-helpers";

describe("attendance RBAC", () => {
  it("requires auth and allows worker access", async () => {
    expect((await request(app).get("/attendance")).status).toBe(401);
    const cookie = await session("worker@construction.local", "Worker123!");
    expect(
      (await request(app).get("/attendance").set("Cookie", cookie)).status,
    ).toBe(200);
  });
  it("denies accountant access", async () => {
    const cookie = await session(
      "accountant@construction.local",
      "Accountant123!",
    );
    expect(
      (await request(app).get("/attendance").set("Cookie", cookie)).status,
    ).toBe(403);
  });
});
