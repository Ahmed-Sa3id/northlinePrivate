import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  logger,
  redactFields,
  resetLogging,
  scrubString,
  serializeError,
  setLogLevel,
  setLogSink,
} from "./_core/logger";

type Entry = Record<string, unknown> & {
  level: string;
  msg: string;
  time: string;
};

let captured: string[];

function entries(): Entry[] {
  return captured.map((line) => JSON.parse(line) as Entry);
}

beforeEach(() => {
  captured = [];
  setLogSink((line) => {
    captured.push(line);
  });
  setLogLevel("debug");
});

afterEach(() => {
  resetLogging();
});

describe("structured logger", () => {
  it("emits one JSON object per line with level, time and message", () => {
    logger.info("hello", { route: "/projects" });

    expect(captured).toHaveLength(1);
    const record = entries()[0];
    expect(record.level).toBe("info");
    expect(record.msg).toBe("hello");
    expect(record.route).toBe("/projects");
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
  });

  it("suppresses records below the active level", () => {
    setLogLevel("warn");
    logger.debug("nope");
    logger.info("nope either");
    logger.warn("yes");
    logger.error("yes too");

    expect(entries().map((record) => record.level)).toEqual(["warn", "error"]);
  });

  it("keeps an explicit level pinned above the LOG_LEVEL environment value", () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error";
    setLogLevel("debug");
    try {
      logger.debug("still visible");
      expect(entries()).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });

  it("stamps child bindings onto every record", () => {
    const requestScoped = logger.child({ requestId: "req-123" });
    requestScoped.info("first");
    requestScoped.warn("second");
    logger.info("unrelated");

    const scoped = entries().filter(
      (record) => record.msg === "first" || record.msg === "second",
    );
    expect(scoped).toHaveLength(2);
    for (const record of scoped) expect(record.requestId).toBe("req-123");
    expect(entries()[2].requestId).toBeUndefined();
  });

  it("does not let fields overwrite the reserved keys", () => {
    logger.info("hello", {
      level: "error",
      time: "not-a-time",
      msg: "replaced",
    });

    const record = entries()[0];
    expect(record.level).toBe("info");
    expect(record.msg).toBe("hello");
    expect(record.time).not.toBe("not-a-time");
  });

  it("serializes errors with type, message and stack", () => {
    const error = new Error("boom");
    logger.error("failed", { err: error });

    const record = entries()[0] as unknown as {
      err: { type: string; message: string; stack: string };
    };
    expect(record.err.type).toBe("Error");
    expect(record.err.message).toBe("boom");
    expect(record.err.stack).toContain("Error: boom");
  });

  it("survives circular references", () => {
    const payload: Record<string, unknown> = { name: "root" };
    payload.self = payload;

    expect(() => logger.info("circular", { payload })).not.toThrow();
    expect(JSON.stringify(entries()[0])).toContain("[Circular]");
  });

  it("truncates deeply nested payloads instead of recursing forever", () => {
    let payload: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 12; depth += 1) payload = { nested: payload };

    logger.info("deep", { payload });
    expect(JSON.stringify(entries()[0])).toContain("[Truncated]");
  });
});

describe("redaction", () => {
  it("replaces values for sensitive keys in any casing or separator style", () => {
    const fields = redactFields({
      password: "hunter2",
      passwordHash: "$2b$10$abcdefghijklmnop",
      newPassword: "hunter3",
      apiKey: "ak_live_123",
      authorization: "Bearer abc",
      cookie: "northline_session=abc",
      stripeSignature: "whsec_abc",
      nested: { clientSecret: "shh" },
    });

    expect(fields.password).toBe("[REDACTED]");
    expect(fields.passwordHash).toBe("[REDACTED]");
    expect(fields.newPassword).toBe("[REDACTED]");
    expect(fields.apiKey).toBe("[REDACTED]");
    expect(fields.authorization).toBe("[REDACTED]");
    expect(fields.cookie).toBe("[REDACTED]");
    expect(fields.stripeSignature).toBe("[REDACTED]");
    expect((fields.nested as Record<string, unknown>).clientSecret).toBe(
      "[REDACTED]",
    );
  });

  it("leaves correlation and business fields intact", () => {
    const fields = redactFields({
      requestId: "req-123",
      email: "owner@construction.local",
      route: "/projects",
      status: 500,
      companyId: "c-1",
    });

    expect(fields).toEqual({
      requestId: "req-123",
      email: "owner@construction.local",
      route: "/projects",
      status: 500,
      companyId: "c-1",
    });
  });

  it("scrubs secret-shaped values filed under harmless keys", () => {
    expect(scrubString("auth is Bearer abcdef123456")).toBe(
      "auth is Bearer [REDACTED]",
    );
    expect(
      scrubString(
        "connection mysql://construction_app:s3cr3t@db:3306/app failed",
      ),
    ).toBe("connection mysql://construction_app:[REDACTED]@db:3306/app failed");
    expect(scrubString("key sk_live_4eC39HqLyjWDarjtT1zdp7dc")).toBe(
      "key [REDACTED]",
    );
    expect(
      scrubString(
        "jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      ),
    ).toBe("jwt [REDACTED]");
  });

  it("never lets a request-like object leak a password", () => {
    logger.info("request completed", {
      path: "/auth/login",
      body: { email: "worker@construction.local", password: "hunter2" },
      query: { token: "re_1234567890abcdef" },
      authorization: "Bearer abcdef123456",
    });

    const line = captured[0];
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain("abcdef123456");
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("/auth/login");
  });
});

describe("serializeError", () => {
  it("reports a non-Error value without throwing", () => {
    const serialized = serializeError("plain failure");
    expect(serialized.type).toBe("string");
    expect(serialized.message).toBe("plain failure");
  });

  it("carries a machine-readable code when the error has one", () => {
    const error = Object.assign(new Error("db down"), { code: "ECONNREFUSED" });
    expect(serializeError(error).code).toBe("ECONNREFUSED");
  });
});
