import type { NextFunction, Request, Response } from "express";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { rateLimitBuckets } from "../drizzle/schema";
import { getDb } from "./db";
import { withAdvisoryLock } from "./lock";
import { logger } from "./_core/logger";
import { rateLimitFallbacks, rateLimitSharedStore } from "./_core/metrics";

type Bucket = { attempts: number[]; blockedUntil: number };
const fallbackBuckets = new Map<string, Bucket>();
let sharedStoreDisabled = false;
const windowMs = Number(process.env.LOGIN_RATE_WINDOW_MS ?? 15 * 60 * 1000);
const maxAttempts = Number(process.env.LOGIN_RATE_MAX_ATTEMPTS ?? 10);
const blockMs = Number(process.env.LOGIN_RATE_BLOCK_MS ?? 15 * 60 * 1000);

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
 * Whether the database-backed limiter is still in play.
 *
 * The fallback in the catch below is a one-way switch: once the shared store
 * throws, the process stays on in-memory buckets until it restarts, which
 * silently removes any cross-instance throttling. Tests assert against this so
 * a regression cannot quietly degrade login protection again.
 */
export function isSharedRateLimitStoreEnabled(): boolean {
  return !sharedStoreDisabled;
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

async function consumeDatabaseBucket(key: string) {
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
 * (the bucket is kept) rather than a broken login. It also never clears the
 * shared-store degradation flag — that is a separate, deliberate signal.
 */
export async function clearRateLimitFor(req: Request): Promise<void> {
  const key = clientKey(req);
  // The in-process bucket is only consulted when the shared store is out of
  // play, but clearing it costs nothing and keeps the two in step.
  fallbackBuckets.delete(key);
  try {
    if (sharedStoreDisabled) return;
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
  try {
    const result = sharedStoreDisabled
      ? undefined
      : await consumeDatabaseBucket(key);
    const decision = result ?? consumeFallbackBucket(key);
    rateLimitSharedStore.set({}, sharedStoreDisabled ? 0 : 1);
    if (decision.blocked) return response429(res, decision.retryAfter);
    return next();
  } catch (error) {
    sharedStoreDisabled = true;
    // Surfaced three ways: the log line below, a counter carrying the reason,
    // and a gauge that reads 0 from then on. Without these the degradation is
    // invisible — a single bad request can silently remove cross-instance
    // throttling for the remaining life of the process.
    rateLimitFallbacks.inc({ code: errorCodeOf(error) });
    rateLimitSharedStore.set({}, 0);
    logger.warn("rate limit store unavailable; using in-process fallback", {
      err: error,
    });
    const decision = consumeFallbackBucket(key);
    if (decision.blocked) return response429(res, decision.retryAfter);
    return next();
  }
}

export const registrationRateLimit = loginRateLimit;
