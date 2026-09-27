import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { auditLogs } from "../drizzle/schema";
import { getDb } from "./db";

const auditDir = path.resolve(process.env.AUDIT_DIR ?? "audit");
const auditFile = path.join(auditDir, "audit.log");

export type AuditEntry = {
  companyId?: string | null;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  method: string;
  path: string;
  status: number;
  at: string;
};

export async function writeAudit(entry: AuditEntry) {
  await mkdir(auditDir, { recursive: true });
  await appendFile(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
  if (entry.companyId) {
    const db = await getDb();
    if (db) {
      await db.insert(auditLogs).values({
        companyId: entry.companyId,
        userId: entry.actorId,
        action: entry.action,
        resourceType: entry.path.split("/")[1] || "system",
        resourceId: null,
        metadata: JSON.stringify({
          method: entry.method,
          status: entry.status,
          path: entry.path,
        }),
      });
    }
  }
}

export async function readTenantAudit(companyId: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.companyId, companyId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.max(1, Math.min(limit, 500)));
}

export function getAuditFile() {
  return auditFile;
}

export async function readAudit(limit = 100): Promise<AuditEntry[]> {
  try {
    const contents = await readFile(auditFile, "utf8");
    return contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((line) => JSON.parse(line) as AuditEntry);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
