import { describe, expect, it } from "vitest";
import { MAX_LOCK_NAME_BYTES, toLockName } from "./lock";

/** The exact key that made `GET_LOCK` fail in production before the fix. */
const REALISTIC_RATE_LIMIT_KEY =
  "northline-rate:/auth/login:::ffff:127.0.0.1:project.supervisor@construction.local";

describe("toLockName", () => {
  it("returns short names unchanged", () => {
    expect(toLockName("northline-limit:users:abc")).toBe(
      "northline-limit:users:abc",
    );
    expect(toLockName("a")).toBe("a");
  });

  it("keeps the real rate-limit key within MariaDB's limit", () => {
    const originalLength = Buffer.byteLength(REALISTIC_RATE_LIMIT_KEY, "utf8");
    expect(originalLength).toBeGreaterThan(MAX_LOCK_NAME_BYTES);

    const name = toLockName(REALISTIC_RATE_LIMIT_KEY);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(
      MAX_LOCK_NAME_BYTES,
    );
  });

  it("never exceeds the limit for an arbitrarily long input", () => {
    for (const length of [63, 64, 65, 100, 1_000]) {
      const name = toLockName("x".repeat(length));
      expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(
        MAX_LOCK_NAME_BYTES,
      );
    }
  });

  it("is deterministic, because a named lock must map 1:1 with its input", () => {
    expect(toLockName(REALISTIC_RATE_LIMIT_KEY)).toBe(
      toLockName(REALISTIC_RATE_LIMIT_KEY),
    );
  });

  it("distinguishes different over-long inputs", () => {
    const first = toLockName(`${REALISTIC_RATE_LIMIT_KEY}:a`);
    const second = toLockName(`${REALISTIC_RATE_LIMIT_KEY}:b`);
    expect(first).not.toBe(second);
  });

  it("counts bytes rather than UTF-16 code units", () => {
    // 64 characters but far more than 64 bytes.
    const wide = "鍵".repeat(64);
    expect(wide.length).toBe(64);
    const name = toLockName(wide);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(
      MAX_LOCK_NAME_BYTES,
    );
    expect(name).not.toBe(wide);
  });

  it("leaves multi-byte names that already fit alone", () => {
    const short = "鍵".repeat(10);
    expect(Buffer.byteLength(short, "utf8")).toBeLessThanOrEqual(
      MAX_LOCK_NAME_BYTES,
    );
    expect(toLockName(short)).toBe(short);
  });
});
