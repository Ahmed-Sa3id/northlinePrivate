import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { getDb } from "./db";

type LockConnection = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<[Array<Record<string, unknown>>, unknown]>;
  beginTransaction: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  release: () => void;
};

type LockPool = {
  promise: () => { getConnection: () => Promise<LockConnection> };
};

/**
 * Runs `work` while holding a MariaDB named (advisory) lock.
 *
 * Named locks are session-scoped and are *not* tied to transaction state, so
 * acquiring and releasing them inside a transaction body means the lock is
 * released before COMMIT runs. A waiter can then take the lock while the
 * previous transaction is still uncommitted, take its REPEATABLE READ snapshot
 * at that moment, and read a pre-commit count — letting two requests both pass
 * the same limit check. That is how plan limits and login throttling were being
 * bypassed under concurrency.
 *
 * The whole critical section therefore runs on a single pinned connection so
 * the ordering is unambiguous:
 *
 *   GET_LOCK -> BEGIN -> work -> COMMIT -> RELEASE_LOCK -> connection returned
 *
 * Because the lock is released only after COMMIT, the next waiter's first
 * InnoDB read happens after the previous write is visible.
 *
 * Each caller holds exactly one pooled connection for the duration, so
 * contention produces back-pressure rather than deadlock.
 */
/** MariaDB rejects a lock name longer than 64 bytes with `ER_TOO_LONG_IDENT`. */
export const MAX_LOCK_NAME_BYTES = 64;

/**
 * Keeps an advisory-lock name inside MariaDB's 64-byte limit.
 *
 * Names that already fit are returned untouched, so every existing lock keeps
 * behaving exactly as before. Longer ones are replaced by a deterministic
 * SHA-256 digest, which preserves the property a named lock depends on — the
 * same input must map to the same lock — while fitting the limit.
 *
 * This is not theoretical: a rate-limit key of `northline-rate:` + path +
 * IPv6-mapped client address + a normal email address is ~69 bytes, so
 * *every* login attempt failed `GET_LOCK` with `ER_TOO_LONG_IDENT`. The
 * caller's catch treated that as "shared store unavailable" and set a
 * process-wide flag, silently pinning the rate limiter to per-process memory
 * for the rest of the process's life — no cross-instance throttling, and no
 * way back without a restart.
 */
export function toLockName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= MAX_LOCK_NAME_BYTES) return name;
  const digest = createHash("sha256").update(name, "utf8").digest("hex");
  // 8 + 56 = 64 bytes, one under the ceiling for safety.
  return `sha256-${digest.slice(0, 56)}`;
}

export async function withAdvisoryLock<T>(
  rawLockName: string,
  work: (tx: MySql2Database<Record<string, never>>) => Promise<T>,
  waitSeconds = 10,
): Promise<T> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");

  const lockName = toLockName(rawLockName);
  const pool = db.$client as unknown as LockPool;
  const connection = await pool.promise().getConnection();
  let locked = false;

  // Coerced before interpolation: this is the only value reaching the
  // statement unparameterised.
  const wait = Number.isFinite(waitSeconds)
    ? Math.max(0, Math.floor(waitSeconds))
    : 10;

  try {
    const [rows] = await connection.query(
      `SELECT GET_LOCK(?, ${wait}) AS acquired`,
      [lockName],
    );
    const acquired = Number(rows?.[0]?.acquired ?? 0);
    // Reported with the caller's original name: the digest tells an operator
    // nothing about which resource was contended.
    if (acquired !== 1) throw new Error(`Lock unavailable: ${rawLockName}`);
    locked = true;

    const tx = drizzle(connection as never);
    await connection.beginTransaction();
    try {
      const result = await work(tx);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Rollback is best-effort; never mask the original failure.
      }
      throw error;
    }
  } finally {
    if (locked) {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    }
    connection.release();
  }
}
