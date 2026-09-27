import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb } from "./db";
import { app } from "./index";

type Session = {
  cookie: string;
  user: { uuid: string; companyId: string; role: string };
};

async function registerCompany(prefix: string): Promise<Session> {
  const unique = randomUUID().slice(0, 8);
  const response = await request(app)
    .post("/auth/register")
    .send({
      name: `${prefix} Admin`,
      email: `${prefix.toLowerCase()}-${unique}@example.test`,
      password: "SecurePassword123!",
      companyName: `${prefix} Company ${unique}`,
      companyEmail: `${prefix.toLowerCase()}-company-${unique}@example.test`,
      phone: "+20 100 000 0000",
    });
  expect(response.status).toBe(201);
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required");
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.email, `${prefix.toLowerCase()}-${unique}@example.test`));
  const login = await request(app)
    .post("/auth/login")
    .send({
      email: `${prefix.toLowerCase()}-${unique}@example.test`,
      password: "SecurePassword123!",
    });
  expect(login.status).toBe(200);
  return {
    cookie: login.headers["set-cookie"][0].split(";")[0],
    user: login.body.user,
  };
}

async function createProject(session: Session, name: string) {
  const response = await request(app)
    .post("/projects")
    .set("Cookie", session.cookie)
    .send({
      name,
      location: "Alexandria",
      status: "active",
      budget: 1000,
      companyId: "attacker-controlled-company-id",
    });
  expect(response.status).toBe(201);
  return response.body.project;
}

async function createWorker(session: Session) {
  const response = await request(app)
    .post("/users")
    .set("Cookie", session.cookie)
    .send({
      name: "Employee",
      email: `employee-${randomUUID()}@example.test`,
      password: "SecurePassword123!",
      role: "worker",
      companyId: "other-company",
      verified: true,
    });
  expect(response.status).toBe(201);
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required");
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.email, response.body.user.email));
  const login = await request(app)
    .post("/auth/login")
    .send({ email: response.body.user.email, password: "SecurePassword123!" });
  expect(login.status).toBe(200);
  return {
    cookie: login.headers["set-cookie"][0].split(";")[0],
    user: login.body.user,
  } as Session;
}

describe("two-company tenant isolation matrix", () => {
  it("blocks symmetric cross-company reads, updates, deletes, and relationship injection", async () => {
    const companyA = await registerCompany("MatrixA");
    const companyB = await registerCompany("MatrixB");
    const employeeA = await createWorker(companyA);
    const employeeB = await createWorker(companyB);
    const projectA = await createProject(companyA, "Private A");
    const projectB = await createProject(companyB, "Private B");

    for (const [attacker, victim, victimProject, victimEmployee] of [
      [companyA, companyB, projectB, employeeB],
      [companyB, companyA, projectA, employeeA],
    ] as const) {
      for (const path of [
        `/projects/${victimProject.id}`,
        `/attendance?projectId=${victimProject.id}`,
        `/materials?projectId=${victimProject.id}`,
        `/expenses?projectId=${victimProject.id}`,
        `/issues?projectId=${victimProject.id}`,
      ]) {
        const response = await request(app)
          .get(path)
          .set("Cookie", attacker.cookie);
        if (path.includes("?") && response.status === 200) {
          const collection = Object.values(response.body).find(
            Array.isArray,
          ) as Array<{ projectId?: string; id?: string }> | undefined;
          expect(
            collection?.some(
              (item) =>
                item.projectId === victimProject.id ||
                item.id === victimProject.id,
            ),
            path,
          ).not.toBe(true);
        } else {
          expect([403, 404], path).toContain(response.status);
        }
      }
      const filteredProjects = await request(app)
        .get(`/projects?projectId=${victimProject.id}`)
        .set("Cookie", attacker.cookie);
      expect(filteredProjects.status).toBe(200);
      expect(
        filteredProjects.body.projects.some(
          (project: { id: string }) => project.id === victimProject.id,
        ),
      ).toBe(false);

      expect([403, 404], "cross-company project update").toContain(
        (
          await request(app)
            .patch(`/projects/${victimProject.id}`)
            .set("Cookie", attacker.cookie)
            .send({ name: "stolen" })
        ).status,
      );
      expect([403, 404], "cross-company project delete").toContain(
        (
          await request(app)
            .delete(`/projects/${victimProject.id}`)
            .set("Cookie", attacker.cookie)
        ).status,
      );

      expect(
        (
          await request(app)
            .post("/project-assignments")
            .set("Cookie", attacker.cookie)
            .send({
              userId: victimEmployee.user.uuid,
              projectId: victimProject.id,
              roleInProject: "injected",
            })
        ).status,
      ).toBe(404);
      expect([403, 404], "cross-company attendance").toContain(
        (
          await request(app)
            .post("/attendance/check-in")
            .set("Cookie", attacker.cookie)
            .send({
              userId: victimEmployee.user.uuid,
              projectId: victimProject.id,
              workDate: new Date().toISOString(),
            })
        ).status,
      );
      expect([403, 404], "cross-company issue").toContain(
        (
          await request(app)
            .post("/issues")
            .set("Cookie", attacker.cookie)
            .field("projectId", victimProject.id)
            .field("description", "cross-company issue")
        ).status,
      );
      expect(
        (
          await request(app).get("/audit").set("Cookie", attacker.cookie)
        ).body.audit?.every(
          (entry: { companyId: string }) =>
            entry.companyId === attacker.user.companyId,
        ),
      ).not.toBe(false);
    }
  });

  it("ignores companyId and privileged fields supplied by clients", async () => {
    const company = await registerCompany("MassAssignment");
    const project = await createProject(company, "Owned project");
    expect(project.companyId).toBe(company.user.companyId);
    expect(project).not.toHaveProperty("role");
    expect(project).not.toHaveProperty("verified");
  });
});
