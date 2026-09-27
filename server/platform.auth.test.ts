import { describe, expect, it } from "vitest";
import type { User } from "../drizzle/schema";
import { hashPassword, verifyPassword } from "./auth";
import { publicUser } from "./db";
import { hasRole } from "./routes/platform";

const sampleUser: User = {
  id: 1,
  companyId: "00000000-0000-0000-0000-000000000001",
  uuid: "sample-user-uuid",
  openId: "credentials:sample@example.com",
  name: "Sample User",
  email: "sample@example.com",
  passwordHash: "stored-hash",
  loginMethod: "credentials",
  role: "worker",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
  emailVerifiedAt: null,
};

describe("platform authentication", () => {
  it("hashes and verifies passwords with bcrypt", async () => {
    const passwordHash = await hashPassword("CorrectHorseBatteryStaple!");

    await expect(
      verifyPassword("CorrectHorseBatteryStaple!", passwordHash),
    ).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", passwordHash)).resolves.toBe(
      false,
    );
  });

  it("allows only explicitly listed construction roles", () => {
    expect(hasRole({ role: "admin" }, ["admin"])).toBe(true);
    expect(hasRole({ role: "worker" }, ["admin"])).toBe(false);
    expect(hasRole({ role: "user" }, ["admin"])).toBe(false);
    expect(hasRole(null, ["admin"])).toBe(false);
  });

  it("removes password hashes from public user records", () => {
    const safeUser = publicUser(sampleUser);

    expect(safeUser).not.toHaveProperty("passwordHash");
    expect(safeUser).toMatchObject({
      uuid: "sample-user-uuid",
      email: "sample@example.com",
      role: "worker",
    });
  });
});
