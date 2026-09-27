import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  companies,
  type InsertUser,
  users,
  type User,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { logger } from "./_core/logger";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      logger.warn("database connection failed", { err: error as Error });
      _db = null;
    }
  }
  return _db;
}

export interface DbPoolStats {
  /** Configured `connectionLimit`, or `null` if mysql2 does not expose it. */
  limit: number | null;
  active: number;
  idle: number;
}

/**
 * Reads mysql2's pool counters for the `northline_db_pool_*` gauges.
 *
 * mysql2 stores its connections in a `RingQueue` (a denque), which exposes
 * `length` rather than being an array, and the counters sit on the pool
 * itself for a callback-style pool but are nested under `.pool` for the
 * promise wrapper. Both shapes are probed and counted by `length`, and every
 * field is optional-chained: these are driver internals, so an upstream
 * refactor must degrade the metric to `null` instead of breaking a request.
 */
export function getDbPoolStats(): DbPoolStats | null {
  interface PoolLike {
    _allConnections?: unknown;
    _freeConnections?: unknown;
    config?: { connectionLimit?: number };
    pool?: PoolLike;
  }

  /** Arrays and denques both answer `length`; anything else is unusable. */
  const countOf = (value: unknown): number | null => {
    if (Array.isArray(value)) return value.length;
    const length = (value as { length?: unknown } | null)?.length;
    return typeof length === "number" && Number.isFinite(length)
      ? length
      : null;
  };

  const client = _db?.$client as unknown as PoolLike | undefined;
  if (!client) return null;

  const pool =
    countOf(client._allConnections) !== null
      ? client
      : countOf(client.pool?._allConnections) !== null
        ? client.pool
        : null;
  if (!pool) return null;

  const all = countOf(pool._allConnections);
  if (all === null) return null;
  const idle = countOf(pool._freeConnections) ?? 0;
  const limit = pool.config?.connectionLimit;
  return {
    limit: typeof limit === "number" ? limit : null,
    active: Math.max(0, all - idle),
    idle,
  };
}

/**
 * Closes the shared connection pool so one-shot scripts (seeds, migrations)
 * can actually exit. Without this the open pool keeps the event loop alive
 * and `pnpm db:seed` never returns, which hangs any CI or deploy step that
 * waits on it.
 */
export async function closeDb(): Promise<void> {
  const client = _db?.$client as unknown as { end?: () => Promise<void> };
  _db = null;
  if (typeof client?.end === "function") await client.end();
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    logger.warn("cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      companyId: user.companyId,
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = [
      "name",
      "email",
      "passwordHash",
      "loginMethod",
    ] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    logger.error("failed to upsert user", { err: error as Error });
    throw error;
  }
}

export async function getUserByOpenId(
  openId: string,
): Promise<User | undefined> {
  const db = await getDb();
  if (!db) {
    logger.warn("cannot read user: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByUuid(uuid: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db
    .select()
    .from(users)
    .where(eq(users.uuid, uuid))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getCompanyById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  return result[0];
}

export async function createCredentialUser(input: {
  companyId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: User["role"];
  emailVerifiedAt?: Date | null;
}): Promise<User> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");

  const openId = `credentials:${input.email}`;
  await db.insert(users).values({
    companyId: input.companyId,
    openId,
    name: input.name,
    email: input.email,
    passwordHash: input.passwordHash,
    loginMethod: "credentials",
    role: input.role,
    emailVerifiedAt: input.emailVerifiedAt ?? null,
  });

  const created = await getUserByEmail(input.email);
  if (!created) throw new Error("User was created but could not be loaded");
  return created;
}

export async function listUsers(companyId?: string): Promise<User[]> {
  const db = await getDb();
  if (!db) return [];
  return companyId
    ? db.select().from(users).where(eq(users.companyId, companyId))
    : db.select().from(users);
}

export function publicUser(user: User) {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}
