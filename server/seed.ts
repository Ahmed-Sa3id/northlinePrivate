import "dotenv/config";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { companies, projects } from "../drizzle/schema";
import { closeDb, createCredentialUser, getDb, getUserByEmail } from "./db";
import { hashPassword } from "./auth";
import { demoFixturesAllowed } from "./_core/seed-guard";

const seedUsers = [
  {
    name: "Ahmed Said",
    email: "admin@construction.local",
    password: "Admin123!",
    role: "admin" as const,
  },
  {
    name: "Mona Hassan",
    email: "supervisor@construction.local",
    password: "Supervisor123!",
    role: "supervisor" as const,
  },
  {
    name: "Omar Ali",
    email: "worker@construction.local",
    password: "Worker123!",
    role: "worker" as const,
  },
  {
    name: "Salma Nabil",
    email: "accountant@construction.local",
    password: "Accountant123!",
    role: "accountant" as const,
  },
];

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required to seed the application");

  if (!demoFixturesAllowed) {
    console.log(
      "[seed] NODE_ENV=production and SEED_DEMO_USERS is not set: skipping the demo " +
        "company, sample project and the four fixture accounts whose passwords are " +
        "published in README.md.",
    );
    console.log(
      "[seed] Production tenants are created by registration, not by this seed. " +
        "Set SEED_DEMO_USERS=1 only for a non-production demonstration environment.",
    );
    console.log("Seed complete (demo fixtures skipped).");
    return;
  }

  const existingCompany = await db
    .select()
    .from(companies)
    .where(eq(companies.email, "demo@northline.local"))
    .limit(1);
  const company = existingCompany[0] ?? {
    id: randomUUID(),
    name: "Northline Demo Company",
    email: "demo@northline.local",
    phone: "+20 100 000 0000",
    logo: null,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  if (!existingCompany[0]) await db.insert(companies).values(company);

  for (const seedUser of seedUsers) {
    const existing = await getUserByEmail(seedUser.email);
    if (!existing) {
      await createCredentialUser({
        companyId: company.id,
        name: seedUser.name,
        email: seedUser.email,
        passwordHash: await hashPassword(seedUser.password),
        role: seedUser.role,
        emailVerifiedAt: new Date(),
      });
      console.log(`Created ${seedUser.role}: ${seedUser.email}`);
    }
  }

  const existingProject = await db
    .select()
    .from(projects)
    .where(eq(projects.name, "برج النيل"))
    .limit(1);

  if (existingProject.length === 0) {
    await db.insert(projects).values({
      id: randomUUID(),
      companyId: company.id,
      name: "برج النيل",
      location: "Cairo, Egypt",
      status: "active",
      budget: "500000.00",
      startDate: new Date(),
    });
    console.log("Created sample project: برج النيل");
  }

  console.log("Seed complete.");
}

async function run() {
  try {
    await main();
  } catch (error) {
    console.error("Seed failed", error);
    process.exitCode = 1;
  } finally {
    // Release the pool so the process can exit; otherwise this script hangs.
    await closeDb();
  }
}

void run();
