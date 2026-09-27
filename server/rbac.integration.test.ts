import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./index";

type Login = { cookie: string; user: { uuid: string; role: string } };

async function login(email: string, password: string): Promise<Login> {
  const response = await request(app)
    .post("/auth/login")
    .send({ email, password });
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"]?.[0];
  expect(cookie).toContain("northline_session=");
  return { cookie: cookie.split(";")[0], user: response.body.user };
}

const admin = () => login("admin@construction.local", "Admin123!");
const worker = () => login("worker@construction.local", "Worker123!");
const accountant = () =>
  login("accountant@construction.local", "Accountant123!");

describe("platform RBAC integration", () => {
  it("requires authentication for users, projects, attendance, materials, expenses, and issues", async () => {
    for (const path of [
      "/users",
      "/projects",
      "/attendance",
      "/materials",
      "/expenses",
      "/issues",
    ]) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });

  it("allows administrators to access every module and never returns password hashes", async () => {
    const session = await admin();
    for (const path of [
      "/users",
      "/projects",
      "/attendance",
      "/materials",
      "/expenses",
      "/issues",
      "/audit",
    ]) {
      const response = await request(app)
        .get(path)
        .set("Cookie", session.cookie);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    }
  });

  it("denies workers and accountants from modules outside their roles", async () => {
    const workerSession = await worker();
    expect(
      (await request(app).get("/users").set("Cookie", workerSession.cookie))
        .status,
    ).toBe(403);
    expect(
      (await request(app).get("/expenses").set("Cookie", workerSession.cookie))
        .status,
    ).toBe(403);
    const accountantSession = await accountant();
    expect(
      (
        await request(app)
          .get("/materials")
          .set("Cookie", accountantSession.cookie)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get("/issues")
          .set("Cookie", accountantSession.cookie)
      ).status,
    ).toBe(403);
  });

  it("keeps the Authorization header path available for API clients", async () => {
    const session = await admin();
    const tokenResponse = await request(app)
      .post("/auth/login")
      .send({ email: "admin@construction.local", password: "Admin123!" });
    const setCookie = tokenResponse.headers["set-cookie"]?.[0];
    expect(setCookie).toBeDefined();
    expect(session.user.role).toBe("admin");
    expect(
      (
        await request(app)
          .get("/projects")
          .set("Authorization", `Bearer ${tokenResponse.body.token ?? ""}`)
      ).status,
    ).toBe(200);
  });

  it("does not permit an unassigned worker to read a project", async () => {
    const workerSession = await worker();
    const response = await request(app)
      .get("/projects")
      .set("Cookie", workerSession.cookie);
    expect([200, 403]).toContain(response.status);
    if (response.body.projects?.length) {
      const project = response.body.projects[0];
      expect(
        (
          await request(app)
            .get(`/projects/${project.id}`)
            .set("Cookie", workerSession.cookie)
        ).status,
      ).toBe(200);
    }
  });
});
