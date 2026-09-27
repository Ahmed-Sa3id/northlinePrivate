import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "./index";
import { isSharedRateLimitStoreEnabled } from "./rateLimit";

async function scrape(): Promise<string> {
  const response = await request(app).get("/metrics");
  expect(response.status).toBe(200);
  return response.text;
}

describe("database-backed login rate limiting", () => {
  it("keeps the shared store engaged for a realistic client key", async () => {
    // Regression: the rate-limit lock name was
    // `northline-rate:` + path + IPv6-mapped client address + email, which for
    // an ordinary address is ~69 bytes against MariaDB's 64-byte ceiling. Every
    // `GET_LOCK` therefore failed with ER_TOO_LONG_IDENT, the catch treated it
    // as "shared store unavailable", and the process silently dropped to
    // per-process memory buckets for the rest of its life — removing any
    // cross-instance throttling with no error surfaced anywhere.
    expect(isSharedRateLimitStoreEnabled()).toBe(true);

    const email = "project.supervisor@construction.local";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(app)
        .post("/auth/login")
        .send({ email, password: "not-the-password" });
      // 401 for a bad password, 429 once the bucket blocks: never a 5xx, and
      // never a lock failure that would flip the shared store off.
      expect(response.status).toBeLessThan(500);
    }

    expect(isSharedRateLimitStoreEnabled()).toBe(true);
    expect(await scrape()).toContain(
      "northline_rate_limit_shared_store_enabled 1",
    );
  });

  it("survives a hostile key that overflows the bucket column", async () => {
    // `rate_limit_buckets.key` is varchar(512) and `clientKey` used to be
    // built straight from the submitted email, so an over-long value failed
    // the INSERT with ER_DATA_TOO_LONG — an unauthenticated, one-request way
    // to permanently degrade a security control. The key is now digested
    // instead of stored raw, so this must leave the shared store untouched.
    expect(isSharedRateLimitStoreEnabled()).toBe(true);

    const hostileEmail = `${"x".repeat(2_000)}@construction.local`;
    const response = await request(app)
      .post("/auth/login")
      .send({ email: hostileEmail, password: "not-the-password" });
    expect(response.status).toBeLessThan(500);

    expect(isSharedRateLimitStoreEnabled()).toBe(true);
    expect(await scrape()).toContain(
      "northline_rate_limit_shared_store_enabled 1",
    );
    expect(await scrape()).not.toContain(
      'northline_rate_limit_fallback_total{code="ER_DATA_TOO_LONG"}',
    );
  });
});
