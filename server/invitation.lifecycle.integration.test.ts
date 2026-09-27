import { describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { getDb, getUserByEmail } from "./db";
import { app } from "./index";

const ownerPassword = "SecurePassword123!";

async function registerOwner() {
  const email = `inv-owner-${Date.now()}@example.test`;
  const response = await request(app)
    .post("/auth/register")
    .send({
      name: "Invitation Owner",
      email,
      password: ownerPassword,
      companyName: `Invitation Company ${Date.now()}`,
      companyEmail: `company-${Date.now()}@example.test`,
      phone: "+20 100 000 0000",
    });
  expect(response.status).toBe(201);
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required");
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.email, email));
  const login = await request(app)
    .post("/auth/login")
    .send({ email, password: ownerPassword });
  expect(login.status).toBe(200);
  return login.headers["set-cookie"][0].split(";")[0];
}

describe("Part 4 invitation lifecycle", () => {
  it("sends, lists, resends, and revokes invitations within the admin tenant", async () => {
    const cookie = await registerOwner();
    const email = `invite-${Date.now()}@example.test`;
    const created = await request(app)
      .post("/invitations")
      .set("Cookie", cookie)
      .send({ email, role: "worker" });
    expect(created.status).toBe(201);
    expect(created.body.invitation.email).toBe(email);
    expect(created.body.token).toEqual(expect.any(String));

    const listed = await request(app).get("/invitations").set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(
      listed.body.invitations.some(
        (item: { id: string }) => item.id === created.body.invitation.id,
      ),
    ).toBe(true);

    const resent = await request(app)
      .post(`/invitations/${created.body.invitation.id}/resend`)
      .set("Cookie", cookie);
    expect(resent.status).toBe(200);
    expect(resent.body.resent).toBe(true);

    const revoked = await request(app)
      .delete(`/invitations/${created.body.invitation.id}`)
      .set("Cookie", cookie);
    expect(revoked.status).toBe(204);
    expect(
      (await request(app).get(`/invitations/${created.body.token}`)).status,
    ).toBe(410);
  });

  it("atomically accepts an invitation only once under concurrent replay", async () => {
    const cookie = await registerOwner();
    const created = await request(app)
      .post("/invitations")
      .set("Cookie", cookie)
      .send({ email: `accept-${Date.now()}@example.test`, role: "worker" });
    expect(created.status).toBe(201);
    const payload = {
      token: created.body.token,
      name: "Invited Worker",
      password: "InvitedSecurePassword123!",
    };
    const responses = await Promise.all([
      request(app).post("/invitations/accept").send(payload),
      request(app).post("/invitations/accept").send(payload),
    ]);
    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 410),
    ).toHaveLength(1);
    const accepted = await getUserByEmail(created.body.invitation.email);
    expect(accepted?.role).toBe("worker");
  });
});
