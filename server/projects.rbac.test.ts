import { describe, expect, it } from "vitest";
import { app, request, session } from "./rbac.test-helpers";

describe("projects and users RBAC", () => {
  it("requires auth and allows admin access", async () => {
    expect((await request(app).get("/projects")).status).toBe(401);
    const cookie = await session("admin@construction.local", "Admin123!");
    expect(
      (await request(app).get("/projects").set("Cookie", cookie)).status,
    ).toBe(200);
    expect(
      (await request(app).get("/users").set("Cookie", cookie)).status,
    ).toBe(200);
  });
  it("denies worker user administration", async () => {
    const cookie = await session("worker@construction.local", "Worker123!");
    expect(
      (await request(app).get("/users").set("Cookie", cookie)).status,
    ).toBe(403);
  });
});
