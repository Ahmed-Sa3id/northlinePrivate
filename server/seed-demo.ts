import "dotenv/config";
import { and, count, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  attendance,
  expenses,
  issues,
  materialTransactions,
  materials,
  projectAssignments,
  projects,
  users,
} from "../drizzle/schema";
import { closeDb, getDb, getUserByEmail } from "./db";
import { demoFixturesAllowed } from "./_core/seed-guard";

const daysAgo = (days: number, hour: number, minute: number) => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - days);
  value.setUTCHours(hour, minute, 0, 0);
  return value;
};

const seedProjectDefinitions = [
  {
    name: "برج النيل",
    location: "New Cairo, Egypt",
    status: "active" as const,
    budget: "500000.00",
    startDate: daysAgo(62, 7, 0),
    endDate: null,
  },
  {
    name: "مستشفى النور التخصصي",
    location: "6th of October City, Egypt",
    status: "active" as const,
    budget: "780000.00",
    startDate: daysAgo(112, 7, 0),
    endDate: null,
  },
  {
    name: "مدرسة النخبة الدولية",
    location: "New Administrative Capital, Egypt",
    status: "completed" as const,
    budget: "320000.00",
    startDate: daysAgo(210, 7, 0),
    endDate: daysAgo(18, 16, 30),
  },
];

const accountEmails = {
  admin: "admin@construction.local",
  supervisor: "supervisor@construction.local",
  worker: "worker@construction.local",
  accountant: "accountant@construction.local",
};

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required to seed the demo dataset");

  // The whole dataset hangs off the fixture accounts, so production gets a
  // clear refusal rather than the confusing "Missing demo account" error that
  // would otherwise follow from db:seed being skipped.
  if (!demoFixturesAllowed) {
    throw new Error(
      "Refusing to seed demo data with NODE_ENV=production. " +
        "Set SEED_DEMO_USERS=1 only for a non-production demonstration environment.",
    );
  }

  const accountUsers = {} as Record<
    keyof typeof accountEmails,
    typeof users.$inferSelect
  >;
  for (const [role, email] of Object.entries(accountEmails) as [
    keyof typeof accountEmails,
    string,
  ][]) {
    const user = await getUserByEmail(email);
    if (!user)
      throw new Error(
        `Missing demo account: ${email}. Run pnpm db:seed first.`,
      );
    accountUsers[role] = user;
  }

  const projectByName = new Map<string, typeof projects.$inferSelect>();
  for (const definition of seedProjectDefinitions) {
    const existing = await db
      .select()
      .from(projects)
      .where(eq(projects.name, definition.name))
      .limit(1);
    if (existing[0]) {
      projectByName.set(definition.name, existing[0]);
    } else {
      const project = {
        id: randomUUID(),
        companyId: accountUsers.admin.companyId,
        ...definition,
      };
      await db.insert(projects).values(project);
      projectByName.set(definition.name, project);
    }
  }

  const projectList = [...projectByName.values()];
  const projectFor = (name: string) => {
    const project = projectByName.get(name);
    if (!project) throw new Error(`Demo project not found: ${name}`);
    return project;
  };

  const assignmentPairs = [
    [
      accountUsers.supervisor.uuid,
      projectFor("برج النيل").id,
      "Site supervisor",
    ],
    [accountUsers.worker.uuid, projectFor("برج النيل").id, "General worker"],
    [
      accountUsers.supervisor.uuid,
      projectFor("مستشفى النور التخصصي").id,
      "Site supervisor",
    ],
    [
      accountUsers.worker.uuid,
      projectFor("مستشفى النور التخصصي").id,
      "Finishing worker",
    ],
    [
      accountUsers.worker.uuid,
      projectFor("مدرسة النخبة الدولية").id,
      "General worker",
    ],
  ] as const;
  for (const [userId, projectId, roleInProject] of assignmentPairs) {
    const existing = await db
      .select()
      .from(projectAssignments)
      .where(
        and(
          eq(projectAssignments.userId, userId),
          eq(projectAssignments.projectId, projectId),
        ),
      )
      .limit(1);
    if (!existing.length)
      await db.insert(projectAssignments).values({
        id: randomUUID(),
        companyId: accountUsers.admin.companyId,
        userId,
        projectId,
        roleInProject,
      });
  }

  const [{ value: attendanceCount }] = await db
    .select({ value: count() })
    .from(attendance);
  if (Number(attendanceCount) < 15) {
    const attendanceRows = [
      [accountUsers.worker.uuid, "برج النيل", 2, "07:58", "16:12"],
      [accountUsers.worker.uuid, "برج النيل", 4, "08:14", "16:20"],
      [accountUsers.worker.uuid, "برج النيل", 6, "07:51", "16:05"],
      [accountUsers.worker.uuid, "برج النيل", 8, "08:07", "16:18"],
      [accountUsers.worker.uuid, "برج النيل", 10, "07:55", "16:10"],
      [accountUsers.worker.uuid, "مستشفى النور التخصصي", 3, "08:03", "16:30"],
      [accountUsers.worker.uuid, "مستشفى النور التخصصي", 5, "08:22", "16:27"],
      [accountUsers.worker.uuid, "مستشفى النور التخصصي", 7, "07:49", "16:11"],
      [accountUsers.worker.uuid, "مستشفى النور التخصصي", 9, "08:05", "16:16"],
      [accountUsers.worker.uuid, "مدرسة النخبة الدولية", 12, "07:57", "16:02"],
      [accountUsers.supervisor.uuid, "برج النيل", 1, "07:42", "17:02"],
      [accountUsers.supervisor.uuid, "برج النيل", 5, "07:48", "17:10"],
      [accountUsers.supervisor.uuid, "برج النيل", 9, "08:11", "16:55"],
      [
        accountUsers.supervisor.uuid,
        "مستشفى النور التخصصي",
        2,
        "07:39",
        "17:08",
      ],
      [
        accountUsers.supervisor.uuid,
        "مستشفى النور التخصصي",
        8,
        "07:52",
        "17:00",
      ],
    ] as const;
    for (const [
      userId,
      projectName,
      days,
      checkIn,
      checkOut,
    ] of attendanceRows) {
      const workDate = daysAgo(days, 0, 0);
      const [inHour, inMinute] = checkIn.split(":").map(Number);
      const [outHour, outMinute] = checkOut.split(":").map(Number);
      const checkedIn = new Date(workDate);
      checkedIn.setUTCHours(inHour, inMinute, 0, 0);
      const checkedOut = new Date(workDate);
      checkedOut.setUTCHours(outHour, outMinute, 0, 0);
      await db.insert(attendance).values({
        id: randomUUID(),
        companyId: accountUsers.admin.companyId,
        userId,
        projectId: projectFor(projectName).id,
        workDate,
        checkIn: checkedIn,
        checkOut: checkedOut,
      });
    }
  }

  const [{ value: expenseCount }] = await db
    .select({ value: count() })
    .from(expenses);
  if (Number(expenseCount) < 8) {
    const expenseRows = [
      ["برج النيل", "Materials - cement and steel", "72000.00", 24],
      ["برج النيل", "Labor - structural crew", "86000.00", 19],
      ["برج النيل", "Equipment rental - crane", "38000.00", 14],
      ["مستشفى النور التخصصي", "Materials - MEP supplies", "318000.00", 20],
      ["مستشفى النور التخصصي", "Labor - finishing crew", "342000.00", 16],
      ["مستشفى النور التخصصي", "Equipment rental - lift", "144000.00", 8],
      ["مدرسة النخبة الدولية", "Materials - classroom fit-out", "96000.00", 66],
      ["مدرسة النخبة الدولية", "Labor - final fit-out", "178000.00", 34],
      [
        "مدرسة النخبة الدولية",
        "Equipment rental - access platform",
        "58000.00",
        28,
      ],
    ] as const;
    for (const [projectName, category, amount, days] of expenseRows) {
      await db.insert(expenses).values({
        id: randomUUID(),
        companyId: accountUsers.admin.companyId,
        projectId: projectFor(projectName).id,
        category,
        amount,
        expDate: daysAgo(days, 12, 0),
        recordedBy: accountUsers.accountant.uuid,
      });
    }
  }

  const [{ value: materialCount }] = await db
    .select({ value: count() })
    .from(materials);
  if (Number(materialCount) === 0) {
    const materialRows = [
      ["برج النيل", "Ready-mix concrete", "180", "m³"],
      ["برج النيل", "Rebar steel", "24", "tons"],
      ["مستشفى النور التخصصي", "Copper cable", "850", "m"],
      ["مستشفى النور التخصصي", "Ceramic tiles", "1250", "m²"],
      ["مدرسة النخبة الدولية", "Acoustic ceiling panels", "640", "m²"],
    ] as const;
    for (const [projectName, name, quantity, unit] of materialRows) {
      await db.insert(materials).values({
        id: randomUUID(),
        companyId: accountUsers.admin.companyId,
        projectId: projectFor(projectName).id,
        name,
        quantity,
        unit,
      });
    }
    const storedMaterials = await db.select().from(materials);
    for (const material of storedMaterials) {
      await db.insert(materialTransactions).values({
        id: randomUUID(),
        companyId: accountUsers.admin.companyId,
        materialId: material.id,
        type: "in",
        quantity: material.quantity,
        txDate: daysAgo(10, 9, 0),
        recordedBy: accountUsers.accountant.uuid,
      });
    }
  }

  const [{ value: issueCount }] = await db
    .select({ value: count() })
    .from(issues);
  if (Number(issueCount) < 5) {
    const issueRows = [
      [
        "برج النيل",
        "Crane malfunction on floor 3; equipment was isolated pending the maintenance contractor.",
        "high",
        "open",
        1,
      ],
      [
        "مستشفى النور التخصصي",
        "Delayed cement delivery affected the west wing pour schedule by one shift.",
        "medium",
        "in_progress",
        4,
      ],
      [
        "برج النيل",
        "Minor scaffolding safety concern near the service shaft; additional toe boards installed.",
        "low",
        "resolved",
        8,
      ],
      [
        "مدرسة النخبة الدولية",
        "Water seepage found below the sports hall window line and sealed during closeout.",
        "medium",
        "resolved",
        24,
      ],
      [
        "مستشفى النور التخصصي",
        "Temporary cable routing crossed a marked walkway and requires rerouting.",
        "high",
        "open",
        2,
      ],
    ] as const;
    for (const [
      projectName,
      description,
      severity,
      status,
      days,
    ] of issueRows) {
      await db.insert(issues).values({
        id: randomUUID(),
        companyId: accountUsers.admin.companyId,
        projectId: projectFor(projectName).id,
        reportedBy: accountUsers.supervisor.uuid,
        description,
        severity,
        status,
        createdAt: daysAgo(days, 10, 30),
      });
    }
  }

  console.log(
    `Demo seed complete: ${projectList.length} projects, ${Number(attendanceCount) < 15 ? 15 : Number(attendanceCount)}+ attendance records, ${Number(expenseCount) < 8 ? 9 : Number(expenseCount)}+ expenses, ${Number(issueCount) < 5 ? 5 : Number(issueCount)}+ issues.`,
  );
}

async function run() {
  try {
    await main();
  } catch (error) {
    console.error("Demo seed failed", error);
    process.exitCode = 1;
  } finally {
    // Release the pool so the process can exit; otherwise this script hangs.
    await closeDb();
  }
}

void run();
