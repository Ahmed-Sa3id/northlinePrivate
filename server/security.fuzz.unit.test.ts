import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./index";

const hostileValues = [
  { email: "x".repeat(10_000), password: "x" },
  { email: null, password: [] },
  { email: ["admin@example.test"], password: { value: "x" } },
  { email: "admin@example.test", password: "" },
  { email: "admin@example.test", password: "NaN" },
  { email: "' OR 1=1 --", password: "<script>alert(1)</script>" },
  {
    email: "admin@example.test",
    password: "x",
    role: "admin",
    companyId: "other",
  },
];

describe("malicious input validation", () => {
  it("rejects hostile login values without 5xx responses or implementation leaks", async () => {
    for (const payload of hostileValues) {
      const response = await request(app).post("/auth/login").send(payload);
      expect([400, 401, 429]).toContain(response.status);
      expect(response.status).not.toBeGreaterThanOrEqual(500);
      const body = JSON.stringify(response.body);
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain("DATABASE_URL");
      expect(body).not.toContain("node_modules");
    }
  });

  it("rejects hostile invitation tokens safely", async () => {
    for (const token of [
      "",
      "../etc/passwd",
      "x".repeat(10_000),
      "<script>alert(1)</script>",
      "not-a-token",
    ]) {
      const response = await request(app)
        .post("/invitations/accept")
        .send({ token, name: "Test User", password: "SecurePassword123!" });
      expect([400, 404, 410, 429]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    }
  });

  it("does not expose protected files through traversal-like URLs", async () => {
    for (const path of [
      "/files/../../etc/passwd",
      "/files/%2e%2e/%2e%2e/etc/passwd",
      "/files/%00",
    ]) {
      const response = await request(app).get(path);
      expect([401, 400, 404]).toContain(response.status);
    }
  });
});
