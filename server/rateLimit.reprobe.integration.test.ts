import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
// Must precede `./rateLimit`: `server/index.ts` runs `import "dotenv/config"` as
// its first statement, while `server/_core/env.ts` snapshots `JWT_SECRET` at
// module evaluation time, and `./rateLimit` pulls that module in through
// `./db`. Importing first in this file leaves `ENV.cookieSecret` empty for the
// whole worker and every login fails.
import { app } from "./index";
import { rateLimitBuckets } from "../drizzle/schema";
import { getDb } from "./db";
import { isSharedRateLimitStoreEnabled } from "./rateLimit";

/**
 * Production-plan product issue #3: the shared-store fallback used to be a
 * one-way switch, so a single failure of the *bucket* operation pinned the
 * process to in-memory buckets until a restart and quietly removed
 * cross-instance throttling.
 *
 * These drive the real middleware against the real database. The failure is
 * produced by corrupting the bucket row of a key used nowhere else, which is
 * the same shape as the ones that degraded the flag in production (an
 * unreadable row discovered inside the advisory lock) and leaves every other
 * row — and every other suite running in parallel against this database —
 * untouched.
 */
const REPROBE_MS = "1000";
const GAUGE = "northline_rate_limit_shared_store_enabled ";
const FALLBACK_UNKNOWN = 'northline_rate_limit_fallback_total{code="UNKNOWN"} ';
const ORIGINAL_REPROBE_MS = process.env.LOGIN_RATE_REPROBE_MS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("DATABASE_URL is required for this test");
  return db;
}

async function attemptLogin(email: string) {
  return request(app)
    .post("/auth/login")
    .send({ email, password: "not-the-password" });
}

/** Leaves a bucket row that throws the moment the limiter parses it. */
async function corruptBucket(email: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(rateLimitBuckets)
    .where(like(rateLimitBuckets.key, `%${email}`))
    .limit(1);
  // With no row there is nothing to parse and nothing to fail, so the whole
  // scenario would degrade into a silent no-op and still "pass".
  expect(rows[0]).toBeDefined();
  await db
    .update(rateLimitBuckets)
    .set({ attempts: "{not-json" })
    .where(like(rateLimitBuckets.key, `%${email}`));
}

/** Removes it, so the next shared-store read succeeds again. */
async function dropBucket(email: string) {
  const db = await requireDb();
  await db
    .delete(rateLimitBuckets)
    .where(like(rateLimitBuckets.key, `%${email}`));
}

async function scrape(): Promise<string> {
  const response = await request(app).get("/metrics");
  expect(response.status).toBe(200);
  return response.text;
}

/** Reads one exposition sample by exact line prefix; absent means never set. */
function sample(text: string, prefix: string): number | undefined {
  const line = text.split(/\r?\n/).find((row) => row.startsWith(prefix));
  return line === undefined ? undefined : Number(line.slice(prefix.length));
}

beforeAll(() => {
  process.env.LOGIN_RATE_REPROBE_MS = REPROBE_MS;
});

afterAll(async () => {
  const db = await requireDb();
  await db
    .delete(rateLimitBuckets)
    .where(like(rateLimitBuckets.key, "%reprobe-%"));
  if (ORIGINAL_REPROBE_MS === undefined)
    delete process.env.LOGIN_RATE_REPROBE_MS;
  else process.env.LOGIN_RATE_REPROBE_MS = ORIGINAL_REPROBE_MS;
});

describe("rate-limit shared store re-probe", () => {
  it("falls back, holds the window, then repairs itself", async () => {
    const email = `reprobe-hold-${randomUUID()}@example.test`;
    expect(isSharedRateLimitStoreEnabled()).toBe(true);

    // A healthy request first, so this key has a row to corrupt.
    expect((await attemptLogin(email)).status).toBeLessThan(500);
    await corruptBucket(email);

    const failed = await attemptLogin(email);
    expect(failed.status).toBeLessThan(500);
    expect(isSharedRateLimitStoreEnabled()).toBe(false);
    expect(sample(await scrape(), GAUGE)).toBe(0);

    // The row is readable again, but the window has not elapsed: the store
    // must still not be asked. This is the assertion that separates "holding
    // the cooldown" from "re-probing on every single request".
    await dropBucket(email);
    expect((await attemptLogin(email)).status).toBeLessThan(500);
    expect(isSharedRateLimitStoreEnabled()).toBe(false);

    // Once the window elapses the next request probes and fixes itself — the
    // restart that used to be the only cure is no longer needed.
    await sleep(Number(REPROBE_MS) + 400);
    expect((await attemptLogin(email)).status).toBeLessThan(500);
    expect(isSharedRateLimitStoreEnabled()).toBe(true);
    expect(sample(await scrape(), GAUGE)).toBe(1);
  });

  it("carries in-memory attempts across the outage", async () => {
    const email = `reprobe-carry-${randomUUID()}@example.test`;

    // Widened so the whole degraded phase is provably inside one window: all
    // six attempts below must land in memory, and none may trigger a probe.
    process.env.LOGIN_RATE_REPROBE_MS = "10000";

    expect((await attemptLogin(email)).status).toBeLessThan(500);
    await corruptBucket(email);
    expect((await attemptLogin(email)).status).toBeLessThan(500);
    expect(isSharedRateLimitStoreEnabled()).toBe(false);

    // Heal the row and keep counting in memory: one attempt already taken by
    // the failed probe, plus five more.
    await dropBucket(email);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await attemptLogin(email)).status).toBeLessThan(500);
    }
    // Still degraded, so those six really were counted in process memory.
    expect(isSharedRateLimitStoreEnabled()).toBe(false);

    // Re-open the window; the next request in the loop below is the probe.
    process.env.LOGIN_RATE_REPROBE_MS = REPROBE_MS;
    await sleep(Number(REPROBE_MS) + 400);
    expect(isSharedRateLimitStoreEnabled()).toBe(false);

    let untilBlocked = 0;
    let blocked = false;
    while (!blocked && untilBlocked < 20) {
      const response = await attemptLogin(email);
      untilBlocked += 1;
      if (response.status === 429) blocked = true;
    }

    expect(blocked).toBe(true);
    expect(isSharedRateLimitStoreEnabled()).toBe(true);
    // Six attempts were taken while the store was out of play. Dropping them
    // on recovery would hand back a fresh LOGIN_RATE_MAX_ATTEMPTS (10) and
    // this would read 11 — the re-probe would be a way to reset a lockout.
    // Carrying them into the shared bucket keeps it at 6 + 5.
    expect(untilBlocked).toBe(5);
  });

  it("stays degraded when a re-probe fails, and does not hot-loop", async () => {
    const email = `reprobe-fail-${randomUUID()}@example.test`;
    expect(isSharedRateLimitStoreEnabled()).toBe(true);

    expect((await attemptLogin(email)).status).toBeLessThan(500);
    await corruptBucket(email);
    expect((await attemptLogin(email)).status).toBeLessThan(500);
    expect(isSharedRateLimitStoreEnabled()).toBe(false);
    const afterFirst = sample(await scrape(), FALLBACK_UNKNOWN) ?? 0;

    // The window elapses and the probe finds the same unreadable row.
    await sleep(Number(REPROBE_MS) + 400);
    expect((await attemptLogin(email)).status).toBeLessThan(500);
    expect(isSharedRateLimitStoreEnabled()).toBe(false);
    const afterSecond = sample(await scrape(), FALLBACK_UNKNOWN) ?? 0;
    // Proof the re-probe actually ran: had it not, nothing would have
    // incremented the counter for this reason a second time.
    expect(afterSecond).toBeGreaterThan(afterFirst);

    // The window restarted on that failure, so the next requests must not
    // reach the store at all — one probe per window, never one per request.
    const beforeRapid = sample(await scrape(), FALLBACK_UNKNOWN) ?? 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await attemptLogin(email)).status).toBeLessThan(500);
    }
    expect(sample(await scrape(), FALLBACK_UNKNOWN) ?? 0).toBe(beforeRapid);
    expect(isSharedRateLimitStoreEnabled()).toBe(false);

    // A later, genuinely successful probe restores full database-backed
    // throttling.
    await dropBucket(email);
    await sleep(Number(REPROBE_MS) + 400);
    expect((await attemptLogin(email)).status).toBeLessThan(500);
    expect(isSharedRateLimitStoreEnabled()).toBe(true);
    expect(sample(await scrape(), GAUGE)).toBe(1);
  });
});
