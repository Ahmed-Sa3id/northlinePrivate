import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { rateLimitBuckets } from "../drizzle/schema";
import { getDb } from "./db";
import { withAdvisoryLock } from "./lock";
import { logger } from "./_core/logger";
import { rateLimitFallbacks, rateLimitSharedStore } from "./_core/metrics";

type Bucket = { attempts: number[]; blockedUntil: number };
type Decision = { blocked: boolean; retryAfter: number };
const fallbackBuckets = new Map<string, Bucket>();
let sharedStoreDisabled = false;
/**
 * When the shared store last failed. The re-probe window is measured from this
 * instant rather than stored as a deadline, so the cooldown knob keeps applying
 * for as long as the process stays degraded.
 */
let sharedStoreFailedAt = 0;
const windowMs = Number(process.env.LOGIN_RATE_WINDOW_MS ?? 15 * 60 * 1000);
const maxAttempts = Number(process.env.LOGIN_RATE_MAX_ATTEMPTS ?? 10);
const blockMs = Number(process.env.LOGIN_RATE_BLOCK_MS ?? 15 * 60 * 1000);
/** One probe a minute at most while the database is down. */
const DEFAULT_REPROBE_MS = 60_000;
/**
 * Floor on the re-probe window: `LOGIN_RATE_REPROBE_MS=0` would put a probe, a
 * warning line and a counter increment on every login request for the whole
 * length of an outage.
 */
const MIN_REPROBE_MS = 1_000;

/**
 * `rate_limit_buckets.key` is `varchar(512)`. `clientKey` is built from a
 * client-supplied email, so an unbounded value made the INSERT fail with
 * `ER_DATA_TOO_LONG` — and because that failure is caught below, a single
 * unauthenticated request could permanently drop the whole process to
 * in-memory throttling.
 */
const BUCKET_KEY_MAX_CHARS = 512;

function clientKey(req: Request) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : typeof req.body?.token === "string"
        ? req.body.token.slice(0, 24)
        : "unknown";
  const raw = `${req.path}:${ip}:${email}`;
  // UTF-16 code units are never fewer than the character count MariaDB
  // counts against VARCHAR(n), so this bound is conservative.
  if (raw.length <= BUCKET_KEY_MAX_CHARS) return raw;
  // Too long to store: substitute a digest, which stays unique per client,
  // fits the column, and keeps a hostile probe's payload out of the table.
  return `${req.path}:sha256-${createHash("sha256")
    .update(raw, "utf8")
    .digest("hex")}`;
}

/**
 * Whether the database-backed limiter is currently in play.
 *
 * A store failure degrades the process to in-memory buckets, which removes any
 * cross-instance throttling. That used to be permanent for the life of the
 * process — a genuine transient blip needed a restart to repair. It now holds
 * for `LOGIN_RATE_REPROBE_MS` and then re-probes, so a blip repairs itself
 * while a sustained outage still probes at most once per window. Tests assert
 * against this so a regression cannot quietly degrade login protection again.
 */
export function isSharedRateLimitStoreEnabled(): boolean {
  return !sharedStoreDisabled;
}

/**
 * How long a degraded process stays on in-memory buckets before it tries the
 * shared store again.
 *
 * Unlike `windowMs`/`maxAttempts`/`blockMs`, which are snapshotted once at
 * import, this is read per request: it is a plain integer parse on a path that
 * already round-trips to the database, and reloading this module to change one
 * constant would leave two copies of the switch alive behind the same app.
 */
function reprobeCooldownMs(): number {
  const value = Number(process.env.LOGIN_RATE_REPROBE_MS ?? DEFAULT_REPROBE_MS);
  if (!Number.isFinite(value)) return DEFAULT_REPROBE_MS;
  return Math.max(MIN_REPROBE_MS, value);
}

/**
 * Whether this request may touch the shared store.
 *
 * While healthy, always. Once degraded, only the first request to arrive after
 * the window has elapsed — and the slot is claimed **synchronously**, with no
 * `await` between the check and the write, so N concurrent logins produce one
 * probe rather than N. A failed probe moves `sharedStoreFailedAt` forward again
 * inside `degradeSharedStore`, so a sustained outage costs one probe per window
 * instead of a hot loop.
 */
function shouldProbeSharedStore(): boolean {
  if (!sharedStoreDisabled) return true;
  const now = Date.now();
  if (now - sharedStoreFailedAt < reprobeCooldownMs()) return false;
  sharedStoreFailedAt = now;
  return true;
}

function degradeSharedStore(error: unknown): void {
  sharedStoreDisabled = true;
  sharedStoreFailedAt = Date.now();
  // Surfaced three ways: the log line below, a counter carrying the reason, and
  // a gauge that reads 0 until the store answers again. Without these the
  // degradation is invisible — a single bad request can silently remove
  // cross-instance throttling.
  rateLimitFallbacks.inc({ code: errorCodeOf(error) });
  logger.warn("rate limit store unavailable; using in-process fallback", {
    err: error,
    retryInMs: reprobeCooldownMs(),
  });
}

function recoverSharedStore(): void {
  if (!sharedStoreDisabled) return;
  sharedStoreDisabled = false;
  sharedStoreFailedAt = 0;
  logger.info(
    "rate limit store answered; re-enabled database-backed throttling",
  );
}

/**
 * MySQL's error code for a metric label. Bounded by the (finite) set of
 * MariaDB error codes, with an explicit fallback for anything unrecognised so
 * a thrown string cannot create unbounded label cardinality.
 */
function errorCodeOf(error: unknown): string {
  const withCode = error as { code?: unknown; cause?: { code?: unknown } };
  const candidates = [withCode?.cause?.code, withCode?.code];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^ER_[A-Z0-9_]{1,48}$/.test(candidate))
      return candidate;
  }
  return "UNKNOWN";
}

function response429(res: Response, retryAfter: number) {
  res.setHeader("Retry-After", retryAfter);
  return res.status(429).json({
    error: {
      code: "RATE_LIMITED",
      message: "Too many login attempts. Try again later.",
    },
  });
}

async function consumeDatabaseBucket(
  key: string,
): Promise<Decision | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  // The lock has to stay held until this bucket update commits, otherwise
  // concurrent attempts can read the same pre-commit attempt list.
  return withAdvisoryLock(
    `northline-rate:${key}`,
    async (tx) => {
      const now = Date.now();
      const rows = await tx
        .select()
        .from(rateLimitBuckets)
        .where(eq(rateLimitBuckets.key, key))
        .limit(1);
      const existing = rows[0];
      const bucket: Bucket = existing
        ? {
            attempts: JSON.parse(existing.attempts) as number[],
            blockedUntil: existing.blockedUntil,
          }
        : { attempts: [], blockedUntil: 0 };
      bucket.attempts = bucket.attempts.filter(
        (timestamp) => now - timestamp < windowMs,
      );
      // Attempts taken while the store was out of play exist nowhere but this
      // process. Handing them over on the way back in is what stops the
      // re-probe from granting a fresh `LOGIN_RATE_MAX_ATTEMPTS` allowance to
      // whoever was mid-brute-force when the blip started. Only the attempts
      // travel: the block is re-derived below from the merged count, so an
      // in-memory `blockedUntil` can neither shorten nor extend a shared one.
      const local = fallbackBuckets.get(key);
      if (local?.attempts.length)
        bucket.attempts = [
          ...new Set([...bucket.attempts, ...local.attempts]),
        ].filter((timestamp) => now - timestamp < windowMs);
      if (bucket.blockedUntil <= now && bucket.attempts.length >= maxAttempts)
        bucket.blockedUntil = now + blockMs;
      const blocked = bucket.blockedUntil > now;
      if (!blocked) bucket.attempts.push(now);
      const values = {
        key,
        attempts: JSON.stringify(bucket.attempts),
        blockedUntil: bucket.blockedUntil,
      };
      if (existing)
        await tx
          .update(rateLimitBuckets)
          .set(values)
          .where(eq(rateLimitBuckets.key, key));
      else await tx.insert(rateLimitBuckets).values(values);
      // Reached only after a successful write, so a probe that throws leaves
      // the in-memory bucket intact for the next attempt.
      if (local) fallbackBuckets.delete(key);
      return {
        blocked,
        retryAfter: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)),
      };
    },
    5,
  );
}

function consumeFallbackBucket(key: string) {
  const now = Date.now();
  const bucket = fallbackBuckets.get(key) ?? { attempts: [], blockedUntil: 0 };
  bucket.attempts = bucket.attempts.filter(
    (timestamp) => now - timestamp < windowMs,
  );
  if (bucket.blockedUntil > now)
    return {
      blocked: true,
      retryAfter: Math.ceil((bucket.blockedUntil - now) / 1000),
    };
  if (bucket.attempts.length >= maxAttempts) {
    bucket.blockedUntil = now + blockMs;
    fallbackBuckets.set(key, bucket);
    return { blocked: true, retryAfter: Math.ceil(blockMs / 1000) };
  }
  bucket.attempts.push(now);
  fallbackBuckets.set(key, bucket);
  return { blocked: false, retryAfter: 0 };
}

/**
 * Hands the allowance back once a credential has been proven correct.
 *
 * `loginRateLimit` consumes an attempt *before* the handler runs, so without
 * this a successful sign-in occupies a slot: **ten correct logins inside the
 * window locked a legitimate user out for `blockMs`, while an attacker who
 * stopped at nine kept their full allowance.** Failures still accumulate the
 * same way — they are simply forgotten the moment the right password arrives,
 * which is the standard semantic for a failed-attempt counter.
 *
 * Deliberately best-effort: a reset that cannot be written must never turn a
 * valid sign-in into an error, so the worst case is the previous behaviour
 * (the bucket is kept) rather than a broken login.
 *
 * The shared bucket is attempted **even while the store is degraded**, which is
 * the one case where skipping it would hurt. What degrades the switch is a
 * failure of the bucket operation itself — `GET_LOCK`, an over-long key — not
 * of the database, so a sign-in can complete while `sharedStoreDisabled` is
 * still true. Ignoring the reset there would strand the pre-outage counter, and
 * the re-probe would then return this process to a bucket the user had already
 * earned back: a sign-in that succeeds today could come back as an instant
 * `LOGIN_RATE_BLOCK_MS` lockout the moment the store recovers. A request that
 * reached this point has already proved the database is answering, so the write
 * costs nothing that the limiter itself does not already spend; if it does fail
 * it is logged and swallowed, and it never clears the degradation flag — that is
 * a separate, deliberate signal only a successful re-probe may change.
 */
export async function clearRateLimitFor(req: Request): Promise<void> {
  const key = clientKey(req);
  // The in-process bucket is only consulted when the shared store is out of
  // play, but clearing it costs nothing and keeps the two in step.
  fallbackBuckets.delete(key);
  try {
    const db = await getDb();
    if (!db) return;
    await withAdvisoryLock(
      `northline-rate:${key}`,
      async (tx) => {
        await tx.delete(rateLimitBuckets).where(eq(rateLimitBuckets.key, key));
      },
      5,
    );
  } catch (error) {
    logger.warn("rate limit bucket reset failed", { err: error });
  }
}

export async function loginRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const key = clientKey(req);
  let shared: Decision | undefined;
  let failure: unknown;
  let failed = false;

  if (shouldProbeSharedStore()) {
    try {
      shared = await consumeDatabaseBucket(key);
    } catch (error) {
      failure = error;
      failed = true;
    }
  }

  let decision: Decision;
  if (failed) {
    degradeSharedStore(failure);
    decision = consumeFallbackBucket(key);
  } else if (shared) {
    // Either an ordinary healthy read or the first successful probe after an
    // outage — `consumeDatabaseBucket` has already handed any in-memory
    // attempts over, so both land in exactly the same place.
    recoverSharedStore();
    decision = shared;
  } else {
    // Either still inside the re-probe window (the store was deliberately not
    // asked) or no `DATABASE_URL` is configured at all — a supported mode, not
    // an outage. Neither is a new failure, so the switch is left alone.
    decision = consumeFallbackBucket(key);
  }

  // One update on every path: 0 exactly while the shared store is out of play.
  rateLimitSharedStore.set({}, sharedStoreDisabled ? 0 : 1);
  if (decision.blocked) return response429(res, decision.retryAfter);
  return next();
}

export const registrationRateLimit = loginRateLimit;
