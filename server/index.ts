import "dotenv/config";
import express from "express";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { registerPlatformRoutes } from "./routes/platform";
import { getDb, getDbPoolStats } from "./db";
import { sql } from "drizzle-orm";
import { assertProductionConfiguration } from "./_core/env";
import { logger, type Logger } from "./_core/logger";
import {
  dbPoolConnections,
  dbPoolLimit,
  healthChecks,
  httpRequestDuration,
  httpErrors,
  httpInFlight,
  httpRequests,
  metrics,
  normalizeRoute,
  readyzFailures,
  requestDurations,
} from "./_core/metrics";
import { configureErrorTracking, reportException } from "./_core/errorTracking";

configureErrorTracking();

export const app = express();
const port = Number(process.env.PORT ?? 3000);

/** Requests currently being handled; kept here so the gauge is a plain set. */
let inFlight = 0;

/** Constant-time comparison so a metrics token cannot be guessed by timing. */
function secretMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * `/metrics` is open outside production. In production it needs a bearer
 * token, and when no token is configured it is not served at all rather
 * than exposed unauthenticated — hence the startup warning.
 */
function metricsEndpointAllowed(req: express.Request): boolean {
  const token = process.env.METRICS_TOKEN?.trim();
  if (!token) return process.env.NODE_ENV !== "production";
  const header = req.header("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  return provided.length > 0 && secretMatches(provided, token);
}

export { metricsEndpointAllowed };

function refreshPoolGauges(): void {
  const stats = getDbPoolStats();
  if (!stats) return;
  dbPoolConnections.set({ state: "active" }, stats.active);
  dbPoolConnections.set({ state: "idle" }, stats.idle);
  if (stats.limit !== null) dbPoolLimit.set({}, stats.limit);
}

function requestLogger(res: express.Response): Logger {
  return (res.locals.logger as Logger | undefined) ?? logger;
}

app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.use((req, res, next) => {
  const requestId = req.header("x-request-id")?.trim() || randomUUID();
  res.setHeader("X-Request-ID", requestId);
  res.locals.requestId = requestId;
  // Every record emitted while this request is in flight carries the id
  // that the client sees in the response header.
  res.locals.logger = logger.child({ requestId });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (process.env.NODE_ENV === "production")
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

// Access log + metrics. Registered before the body parsers and the static
// handler so every response — including origin rejections and 404s — is
// counted exactly once, whether it completed or the socket dropped.
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  inFlight += 1;
  httpInFlight.set({}, inFlight);

  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    inFlight = Math.max(0, inFlight - 1);
    httpInFlight.set({}, inFlight);

    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const route = normalizeRoute(
      req.path,
      (req as express.Request & { route?: { path?: string } }).route?.path,
    );
    const status = res.statusCode;
    httpRequests.inc({
      method: req.method,
      route,
      status: String(status),
    });
    httpRequestDuration.observe(
      { method: req.method, route },
      durationMs / 1000,
    );
    requestDurations.observe(durationMs / 1000);

    const fields = {
      method: req.method,
      path: req.path,
      query: req.query,
      route,
      status,
      durationMs: Math.round(durationMs * 100) / 100,
    };
    const log = requestLogger(res);
    if (status >= 500) log.error("request failed", fields);
    else log.info("request completed", fields);
  };

  res.on("finish", record);
  // Aborted uploads never emit `finish`; `close` still does.
  res.on("close", record);
  next();
});

app.use(
  "/billing/webhook",
  express.raw({ type: "application/json", limit: "2mb" }),
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req, res, next) => {
  const origin = req.header("origin");
  if (!origin) return next();
  const configured = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const sameOrigin = `${req.protocol}://${req.get("host")}`;
  if (origin !== sameOrigin && !configured.includes(origin)) {
    return res.status(403).json({
      error: {
        code: "ORIGIN_REJECTED",
        message: "Origin is not allowed",
      },
    });
  }
  return next();
});
app.use(express.static(path.resolve("dist/web")));
registerPlatformRoutes(app);

app.get("/health", async (_req, res) => {
  const db = await getDb();
  if (!db) {
    healthChecks.inc({ result: "unavailable" });
    readyzFailures.inc();
    return res
      .status(503)
      .json({ ok: false, application: "ok", database: "unavailable" });
  }
  try {
    await db.execute(sql`select 1`);
    healthChecks.inc({ result: "ok" });
    return res.json({ ok: true, application: "ok", database: "ok" });
  } catch {
    healthChecks.inc({ result: "unhealthy" });
    readyzFailures.inc();
    requestLogger(res).warn("readiness probe failed", { route: "/health" });
    return res
      .status(503)
      .json({ ok: false, application: "ok", database: "unhealthy" });
  }
});

// Liveness never depends on external services; readiness is the database-aware check above.
app.get("/livez", (_req, res) => res.json({ ok: true, application: "ok" }));
app.get("/readyz", (_req, res) => res.redirect(307, "/health"));

app.get("/metrics", (req, res) => {
  if (!metricsEndpointAllowed(req)) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  }
  refreshPoolGauges();
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return res.send(metrics.render());
});

// Deliberate fault-injection endpoint: firing it proves that an error is
// logged, counted and reported under one request id. It must be registered
// *before* the error handler below or Express's default final handler would
// answer instead, with an HTML stack trace and no structured record.
// Enabled outside production by default; in production it needs an explicit
// opt-in because it is also an easy way to generate error-rate noise.
if (
  process.env.NODE_ENV !== "production" ||
  process.env.ENABLE_ERROR_PROBE === "1"
) {
  app.get("/_observability/probe", () => {
    throw new Error("Deliberate observability probe error");
  });
}

// The verification, password-reset and invitation emails link to these
// paths, and Northline ships as a single index.html with no server-side
// router, so the shell has to answer them. Before this existed every link
// the product emailed returned `Cannot GET /verify-email`: the account was
// created, the token was minted, and there was nowhere to redeem it.
//
// The allowlist is deliberate. A catch-all rewrite would hand the HTML shell
// to unknown API paths too, turning a JSON 404 into a 200 that looks like a
// successful response to a client, so only these known client routes are
// rewritten and everything else keeps falling through.
//
// Two lists must stay in step: the emailed deep links below, and the four
// static legal documents in `web/Legal.tsx`. `LEGAL_PATHS` is exported from
// the frontend and the integration test walks it against this server, so a
// path added on one side only fails the suite instead of 404ing in the
// browser. `/` is served by the SPA fallback above, not here.
//
// Exported so `server/billing.spa.integration.test.ts` can walk it the same
// way rather than re-declaring it: a path listed here but missing from the
// billing test, or vice versa, would otherwise only be caught in the browser.
export const SPA_LINK_PATHS = [
  "/verify-email",
  "/reset-password",
  "/accept-invitation",
  "/terms",
  "/privacy",
  "/support",
  "/refunds",
  // Where Stripe sends the browser once Checkout finishes
  // (`createCheckoutSession`, `success_url` / `cancel_url`). These are real
  // URLs the provider navigates to directly, so they must answer 200 — before
  // this existed a *successful payment* landed the customer on "Cannot GET
  // /billing/success". They open the Billing panel; see `sectionForPath` in
  // `web/main.tsx`.
  "/billing/success",
  "/billing/cancel",
];
for (const spaPath of SPA_LINK_PATHS) {
  app.get(spaPath, (_req, res, next) => {
    res.sendFile(path.resolve("dist/web/index.html"), (error) => {
      // `dist/web` is produced by `pnpm build`; without it there is no shell
      // to serve, so fall through to a 404 rather than leaving the request
      // hanging with no response.
      if (error) next();
    });
  });
}

app.use(
  (
    error: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const route = normalizeRoute(
      req.path,
      (req as express.Request & { route?: { path?: string } }).route?.path,
    );
    const user = res.locals.user as { uuid?: string } | undefined;
    requestLogger(res).error("unhandled request error", {
      err: error,
      route,
      method: req.method,
      path: req.path,
      status: 500,
    });
    httpErrors.inc({ code: "INTERNAL_ERROR" });
    reportException(error, {
      requestId: res.locals.requestId as string | undefined,
      method: req.method,
      route,
      url: req.path,
      status: 500,
      userId: user?.uuid,
    });
    if (res.headersSent) return;
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Unexpected server error" },
    });
  },
);

if (
  process.env.NODE_ENV === "production" &&
  !process.env.METRICS_TOKEN?.trim()
) {
  logger.warn(
    "/metrics is disabled because METRICS_TOKEN is not set; set it to allow Prometheus to scrape",
  );
}

if (process.env.NODE_ENV !== "test") {
  assertProductionConfiguration();
  app.listen(port, "0.0.0.0", () => {
    logger.info("construction api listening", {
      port,
      level: process.env.LOG_LEVEL ?? "info",
    });
  });
}
