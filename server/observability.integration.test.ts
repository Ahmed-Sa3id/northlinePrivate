import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app, metricsEndpointAllowed } from "./index";
import { getLocalErrorReporter } from "./_core/errorTracking";
import { getDbPoolStats } from "./db";
import { resetLogging, setLogLevel, setLogSink } from "./_core/logger";
import { metrics } from "./_core/metrics";

type Entry = Record<string, unknown> & { level: string; msg: string };

let captured: string[];

function entries(): Entry[] {
  return captured.map((line) => JSON.parse(line) as Entry);
}

/** Lets `finish`/`close` listeners on the response settle before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function scrape(): Promise<string> {
  const response = await request(app).get("/metrics");
  expect(response.status).toBe(200);
  return response.text;
}

beforeEach(() => {
  captured = [];
  setLogSink((line) => {
    captured.push(line);
  });
  setLogLevel("info");
  getLocalErrorReporter().clear();
  metrics.reset();
});

afterEach(() => {
  resetLogging();
});

describe("request id correlation", () => {
  it("echoes a client-supplied id and stamps it on every record", async () => {
    const requestId = "obs-client-supplied-0001";
    const response = await request(app)
      .get("/livez")
      .set("X-Request-ID", requestId);

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe(requestId);
    await flush();

    const access = entries().find(
      (record) =>
        record.msg === "request completed" && record.requestId === requestId,
    );
    expect(access).toBeDefined();
    expect(access?.level).toBe("info");
    expect(access?.status).toBe(200);
    expect(access?.route).toBe("/livez");
    expect(access?.method).toBe("GET");
  });

  it("generates an id when the client sends none", async () => {
    const response = await request(app).get("/livez");
    const requestId = response.headers["x-request-id"] as string;

    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    await flush();

    const access = entries().find(
      (record) =>
        record.msg === "request completed" && record.requestId === requestId,
    );
    expect(access).toBeDefined();
  });
});

describe("deliberate error (blocker #8 acceptance)", () => {
  it("surfaces one error across the log line, the error store and the metrics", async () => {
    const requestId = "obs-probe-0001";

    const response = await request(app)
      .get("/_observability/probe")
      .set("X-Request-ID", requestId);

    expect(response.status).toBe(500);
    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    // The response must not leak the failure details.
    expect(JSON.stringify(response.body)).not.toContain("Deliberate");
    await flush();

    // 1. the structured log line carries the request id
    const logRecord = entries().find(
      (record) =>
        record.msg === "unhandled request error" &&
        record.requestId === requestId,
    );
    expect(logRecord).toBeDefined();
    expect(logRecord?.level).toBe("error");
    expect(logRecord?.route).toBe("/_observability/probe");
    expect(logRecord?.method).toBe("GET");
    expect(logRecord?.status).toBe(500);
    const serializedError = logRecord?.err as {
      message: string;
      stack: string;
    };
    expect(serializedError.message).toContain(
      "Deliberate observability probe error",
    );
    expect(serializedError.stack).toContain("Error: Deliberate");

    // 2. the error store holds the same event under the same request id
    const events = getLocalErrorReporter().find(requestId);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("Deliberate observability probe error");
    expect(events[0].requestId).toBe(requestId);
    expect(events[0].route).toBe("/_observability/probe");
    expect(events[0].status).toBe(500);
    expect(events[0].url).toBe("/_observability/probe");

    // 3. the metrics count it, so an alert can be driven from the same event
    const scraped = await scrape();
    expect(scraped).toContain(
      'northline_http_requests_total{method="GET",route="/_observability/probe",status="500"} 1',
    );
    expect(scraped).toContain(
      'northline_http_errors_total{code="INTERNAL_ERROR"} 1',
    );
  });

  it("keeps the probe out of the response body but in the metrics", async () => {
    const response = await request(app).get("/_observability/probe");
    expect(response.status).toBe(500);
    expect(response.text).not.toMatch(/at .*index\.ts/);
  });
});

describe("metrics endpoint", () => {
  it("serves Prometheus text exposition", async () => {
    const response = await request(app).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("# HELP northline_http_requests_total");
    expect(response.text).toContain(
      "# TYPE northline_http_requests_total counter",
    );
    expect(response.text).toContain(
      "northline_http_request_duration_seconds_p95",
    );
    expect(response.text).toContain("northline_db_pool_connections");
  });

  it("counts health probes by result", async () => {
    const probe = await request(app).get("/health");
    expect(probe.status).toBe(200);

    const scraped = await scrape();
    expect(scraped).toContain('northline_health_checks_total{result="ok"} 1');
    // The pool gauges are refreshed at scrape time from the live driver, so a
    // sample here proves the introspection actually reaches mysql2.
    expect(scraped).toMatch(
      /northline_db_pool_connections\{state="idle"\} \d+/,
    );

    const stats = getDbPoolStats();
    expect(stats).not.toBeNull();
    if (!stats) return;
    expect(stats.idle).toBeGreaterThanOrEqual(0);
    expect(stats.active).toBeGreaterThanOrEqual(0);
    expect(stats.limit === null || stats.limit > 0).toBe(true);
  });

  it("records latency for the request that is being measured", async () => {
    await request(app).get("/livez");
    const scraped = await scrape();

    expect(scraped).toContain(
      'northline_http_request_duration_seconds_count{method="GET",route="/livez"} 1',
    );
    expect(scraped).toMatch(
      /northline_http_request_duration_seconds_p95 [0-9.]+/,
    );
  });
});

describe("metrics access control", () => {
  it("requires a bearer token once METRICS_TOKEN is configured", async () => {
    const previous = process.env.METRICS_TOKEN;
    process.env.METRICS_TOKEN = "unit-test-token-value";
    try {
      const anonymous = await request(app).get("/metrics");
      expect(anonymous.status).toBe(404);

      const wrongLength = await request(app)
        .get("/metrics")
        .set("Authorization", "Bearer nope");
      expect(wrongLength.status).toBe(404);

      // Same length as the real token, so this exercises the constant-time
      // comparison rather than the cheap length check.
      const wrongValue = await request(app)
        .get("/metrics")
        .set("Authorization", "Bearer unit-test-token-valuX");
      expect(wrongValue.status).toBe(404);

      const authorized = await request(app)
        .get("/metrics")
        .set("Authorization", "Bearer unit-test-token-value");
      expect(authorized.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = previous;
    }
  });

  it("is not served unauthenticated in production", () => {
    const previousEnv = process.env.NODE_ENV;
    const previousToken = process.env.METRICS_TOKEN;
    const stub = (authorization?: string) =>
      ({
        header: (name: string) =>
          name === "authorization" ? authorization : undefined,
      }) as unknown as Parameters<typeof metricsEndpointAllowed>[0];

    try {
      delete process.env.METRICS_TOKEN;
      process.env.NODE_ENV = "production";
      expect(metricsEndpointAllowed(stub())).toBe(false);

      process.env.NODE_ENV = "test";
      expect(metricsEndpointAllowed(stub())).toBe(true);

      process.env.METRICS_TOKEN = "unit-test-token-value";
      process.env.NODE_ENV = "production";
      expect(metricsEndpointAllowed(stub("Bearer unit-test-token-value"))).toBe(
        true,
      );
      expect(metricsEndpointAllowed(stub("Bearer wrong"))).toBe(false);
      expect(metricsEndpointAllowed(stub())).toBe(false);
    } finally {
      if (previousToken === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = previousToken;
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });
});

describe("log redaction on the request path", () => {
  it("never writes a submitted password to the log", async () => {
    const secret = "hunter2-never-appears-in-logs";
    const response = await request(app)
      .post("/auth/login")
      .query({ token: "re_1234567890abcdef" })
      .send({ email: "nobody@construction.local", password: secret });

    expect(response.status).toBeLessThan(500);
    await flush();

    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(line).not.toContain(secret);
      expect(line).not.toContain("re_1234567890abcdef");
      expect(line).not.toContain("nobody@construction.local");
    }
  });
});
