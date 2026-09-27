/**
 * Error tracking.
 *
 * Errors are funnelling into two places that can be correlated with each
 * other:
 *
 *   1. the structured log line (via `server/_core/logger.ts`), and
 *   2. an `ErrorReporter`.
 *
 * The default reporter keeps a bounded in-memory ring, which is what the
 * tests assert against and what a self-hosted install gets for free — an
 * error never disappears without a trace just because no vendor is wired up.
 *
 * When `SENTRY_DSN` is present the reporter forwards to Sentry over HTTP
 * using the envelope format, so enabling an account is configuration only
 * (no SDK, no lockfile change). Delivery is best-effort: a failure is logged
 * and swallowed, and the local reporter keeps the event.
 */

import { scrubString } from "./logger";
import { logger } from "./logger";

export interface ErrorEvent {
  timestamp: string;
  message: string;
  requestId?: string;
  type?: string;
  code?: string;
  stack?: string;
  method?: string;
  route?: string;
  url?: string;
  status?: number;
  userId?: string;
  tags?: Record<string, string>;
}

export interface ErrorReporter {
  capture(event: ErrorEvent): void;
}

export interface LocalReporter extends ErrorReporter {
  events(): ErrorEvent[];
  find(requestId: string): ErrorEvent[];
  clear(): void;
}

export function createLocalErrorReporter(capacity = 200): LocalReporter {
  const buffer: ErrorEvent[] = [];
  return {
    capture(event) {
      buffer.push(event);
      if (buffer.length > capacity) buffer.shift();
    },
    events: () => [...buffer],
    find: (requestId) =>
      buffer.filter((event) => event.requestId === requestId),
    clear: () => {
      buffer.length = 0;
    },
  };
}

const localReporter = createLocalErrorReporter();
let reporter: ErrorReporter = localReporter;

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next;
}

export function getErrorReporter(): ErrorReporter {
  return reporter;
}

export function getLocalErrorReporter(): LocalReporter {
  return localReporter;
}

export type ErrorInput = Partial<ErrorEvent> & { message: string };

/** Normalises, redacts and forwards an error event. Never throws. */
export function reportError(input: ErrorInput): void {
  const event: ErrorEvent = {
    timestamp: input.timestamp ?? new Date().toISOString(),
    message: scrubString(input.message),
    requestId: input.requestId,
    type: input.type,
    code: input.code,
    stack: input.stack ? scrubString(input.stack) : undefined,
    method: input.method,
    route: input.route,
    url: input.url,
    status: input.status,
    userId: input.userId,
    tags: input.tags,
  };
  try {
    localReporter.capture(event);
    if (reporter !== localReporter) reporter.capture(event);
  } catch (error) {
    logger.warn("error reporter failed", {
      err: error as Error,
    });
  }
}

/** Pairs an `Error` with request context in one call. */
export function reportException(
  error: unknown,
  context: Partial<ErrorEvent> = {},
): void {
  const err = error instanceof Error ? error : undefined;
  reportError({
    message: err?.message ?? String(error),
    type: err?.name,
    code:
      context.code ??
      ((err as (Error & { code?: unknown }) | undefined)?.code as string) ??
      undefined,
    stack: err?.stack,
    ...context,
  });
}

// ---------------------------------------------------------------------------
// Sentry transport (envelope v7)
// ---------------------------------------------------------------------------

export interface SentryDsn {
  publicKey: string;
  host: string;
  projectId: string;
  protocol: string;
}

/**
 * Accepts `https://<key>@<host>/<project>` — optionally with `:9443` or a
 * path segment, which the host part must not swallow.
 */
export function parseSentryDsn(dsn: string): SentryDsn | null {
  const match = /^([a-z]+):\/\/([^@]+)@([^/:]+)(?::(\d+))?\/(\d+)/i.exec(
    dsn.trim(),
  );
  if (!match) return null;
  const [, protocol, key, host, port, projectId] = match;
  if (!key || !host || !projectId) return null;
  return {
    publicKey: key,
    host: port ? `${host}:${port}` : host,
    projectId,
    protocol,
  };
}

function eventId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface SentryFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
}

const STACK_LINE = /^\s*at (?:(.+?) \((.+?)\)|(.+))$/;
const LOCATION = /^(.*?):(\d+):(\d+)$/;

/**
 * Node prints the innermost frame first; Sentry expects the oldest frame
 * first, so the parsed list is reversed before it is attached.
 */
export function parseStackFrames(stack: string): SentryFrame[] {
  const frames: SentryFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = STACK_LINE.exec(line.trimEnd());
    if (!match) continue;
    const [, functionName, inner, standalone] = match;
    const location = inner ?? standalone;
    if (!location) continue;
    const parsed = LOCATION.exec(location);
    const frame: SentryFrame = {
      filename: parsed ? parsed[1] : location,
      function: functionName ?? "<anonymous>",
    };
    if (parsed) {
      frame.lineno = Number(parsed[2]);
      frame.colno = Number(parsed[3]);
    }
    frames.push(frame);
  }
  return frames.reverse();
}

export function buildSentryEvent(
  event: ErrorEvent,
  id: string,
): Record<string, unknown> {
  const sentryEvent: Record<string, unknown> = {
    event_id: id,
    timestamp:
      Math.floor(Date.parse(event.timestamp) / 1000) || Date.now() / 1000,
    platform: "node",
    level: "error",
    logger: "northline",
    message: event.message,
  };

  const frames = event.stack ? parseStackFrames(event.stack) : [];
  const exception: Record<string, unknown> = {
    type: event.type ?? "Error",
    value: event.message,
  };
  if (frames.length > 0) exception.stacktrace = { frames };
  sentryEvent.exception = { values: [exception] };

  const tags: Record<string, string> = { ...(event.tags ?? {}) };
  if (event.requestId) tags.requestId = event.requestId;
  if (event.code) tags.code = event.code;
  if (event.status !== undefined) tags.status = String(event.status);
  if (Object.keys(tags).length > 0) sentryEvent.tags = tags;

  const request: Record<string, unknown> = {};
  if (event.method) request.method = event.method;
  if (event.url) request.url = event.url;
  if (Object.keys(request).length > 0) sentryEvent.request = request;

  return sentryEvent;
}

export function buildSentryEnvelope(event: ErrorEvent, dsn: SentryDsn): string {
  const id = eventId();
  const header = JSON.stringify({
    event_id: id,
    sent_at: new Date().toISOString(),
    sdk: { name: "northline-observability", version: "1.0.0" },
  });
  const itemHeader = JSON.stringify({
    type: "event",
    content_type: "application/json",
  });
  const body = JSON.stringify(buildSentryEvent(event, id));
  void dsn;
  return `${header}\n${itemHeader}\n${body}`;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Forwards errors to Sentry. Safe to construct with an unparseable DSN —
 * `capture` degrades to a no-op rather than throwing inside a request.
 */
export function createSentryReporter(
  dsn: string,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): ErrorReporter {
  const parsed = parseSentryDsn(dsn);
  const endpoint = parsed
    ? `${parsed.protocol}://${parsed.host}/api/${parsed.projectId}/envelope/`
    : null;

  return {
    capture(event: ErrorEvent) {
      if (!endpoint || !parsed) return;
      const body = buildSentryEnvelope(event, parsed);
      void fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": [
            "Sentry sentry_version=7",
            `sentry_key=${parsed.publicKey}`,
            "sentry_client=northline-observability/1.0.0",
          ].join(", "),
        },
        body,
        signal: AbortSignal.timeout(5_000),
      }).catch((error: unknown) => {
        logger.warn("sentry delivery failed", { err: error as Error });
      });
    },
  };
}

/**
 * Chooses the reporter from the environment. Call once during startup;
 * calling it again replaces the current reporter.
 */
export function configureErrorTracking(): ErrorReporter {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    reporter = localReporter;
    return reporter;
  }
  if (!parseSentryDsn(dsn)) {
    logger.warn("SENTRY_DSN is not a valid DSN; keeping local reporter");
    reporter = localReporter;
    return reporter;
  }
  const sentry = createSentryReporter(dsn);
  reporter = {
    capture(event) {
      localReporter.capture(event);
      sentry.capture(event);
    },
  };
  return reporter;
}
