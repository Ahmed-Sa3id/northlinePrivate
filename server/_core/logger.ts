/**
 * Structured JSON logging.
 *
 * Every record is a single line of JSON so log aggregators can index fields
 * directly instead of parsing free text. Two properties matter most here:
 *
 *  1. **Redaction.** Request bodies, headers and error messages routinely
 *     contain passwords, session cookies, Stripe signatures and database
 *     URLs. Anything whose key looks sensitive has its value replaced, and
 *     every string is additionally scanned for secret-shaped *values* so a
 *     token cannot leak just because it was filed under an innocuous key.
 *  2. **Correlation.** `child({ requestId })` stamps the request id onto every
 *     record emitted while handling that request, which is what lets an
 *     error in the dashboard be matched back to the log line that produced it.
 *
 * The sink is injectable so tests can assert on emitted records without
 * scraping stdout.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVELS = Object.keys(LEVEL_VALUE) as LogLevel[];

export const REDACTED = "[REDACTED]";

/** Keys are compared after stripping non-alphanumerics, so `api_key`,
 *  `apiKey` and `Api-Key` all match the same entry. */
const SENSITIVE_KEY_SNIPPETS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "authorization",
  "cookie",
  "credential",
  "privatekey",
  "signature",
  "bearer",
];

/** Value-shaped secrets, applied to every string regardless of key. The
 *  database-URL pattern matters most: `DATABASE_URL` embeds the MySQL
 *  password after the scheme. */
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/mysql:\/\/([^:/@\s]+):([^@\s]+)@/gi, "mysql://$1:" + REDACTED + "@"],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1" + REDACTED],
  [/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{8,}\b/g, REDACTED],
  [/\bre_[A-Za-z0-9]{10,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
];

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

/** Scrubs secret-shaped substrings out of a free-form string. */
export function scrubString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    // Fresh RegExp each pass: the patterns carry the `g` flag and a shared
    // `lastIndex` would otherwise skip matches.
    out = out.replace(new RegExp(pattern.source, pattern.flags), replacement);
  }
  return out;
}

export function serializeError(
  error: unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth > MAX_DEPTH) return { type: "DepthLimit", message: "truncated" };
  if (!(error instanceof Error)) {
    return { type: typeof error, message: scrubString(String(error)) };
  }
  const out: Record<string, unknown> = {
    type: error.name,
    message: scrubString(error.message),
  };
  if (error.stack) out.stack = scrubString(error.stack);
  const withCode = error as Error & { code?: unknown; cause?: unknown };
  if (withCode.code !== undefined) out.code = withCode.code;
  if (withCode.cause !== undefined && withCode.cause !== error) {
    out.cause = redactValue(withCode.cause, depth + 1, new WeakSet());
  }
  return out;
}

export function redactValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "string") return scrubString(value as string);
  if (type === "number" || type === "boolean") return value;
  if (type === "bigint") return (value as bigint).toString();
  if (type === "function") return "[Function]";
  if (type === "symbol") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value, depth);
  if (depth > MAX_DEPTH) return "[Truncated]";

  const object = value as object;
  if (seen.has(object)) return "[Circular]";
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_ARRAY)
        .map((item) => redactValue(item, depth + 1, seen));
      if (value.length > MAX_ARRAY) {
        items.push(`[${value.length - MAX_ARRAY} more omitted]`);
      }
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = isSensitiveKey(key)
        ? REDACTED
        : redactValue(entry, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** Redacts a flat bag of log fields (including its nested values). */
export function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(value);
  }
  return out;
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => process.stdout.write(`${line}\n`);

let sink: LogSink = defaultSink;
/** Explicit call-site wins over `LOG_LEVEL`, which tests toggle per suite. */
let levelOverride: LogLevel | null = null;

function parseLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const candidate = value.toLowerCase() as LogLevel;
  return LEVELS.includes(candidate) ? candidate : undefined;
}

/** Swaps the output destination (tests, or a future log shipper). */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? defaultSink;
}

/**
 * Pins the minimum level, bypassing `LOG_LEVEL`. Pass `null` to fall back to
 * the environment, which is what `resetLogging()` does in test teardown.
 */
export function setLogLevel(level: LogLevel | null): void {
  levelOverride = level;
}

export function getLogLevel(): LogLevel {
  return levelOverride ?? parseLevel(process.env.LOG_LEVEL) ?? "info";
}

/** Restores the default sink and environment-derived level. */
export function resetLogging(): void {
  sink = defaultSink;
  levelOverride = null;
}

function emit(
  bindings: LogFields,
  level: LogLevel,
  message: string,
  fields?: LogFields,
): void {
  const minimum = getLogLevel();
  if (LEVEL_VALUE[level] < LEVEL_VALUE[minimum]) return;

  const merged = { ...redactFields(bindings), ...redactFields(fields ?? {}) };
  delete merged.time;
  delete merged.level;
  delete merged.msg;

  const entry: LogFields = {
    time: new Date().toISOString(),
    level,
    msg: scrubString(String(message)),
    ...merged,
  };

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg: "log record was not serializable",
    });
  }
  sink(line);
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps `bindings` onto every record it emits. */
  child(bindings: LogFields): Logger;
}

function createLogger(bindings: LogFields): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void =>
      emit(bindings, level, message, fields);
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

/** Process-wide root logger. */
export const logger: Logger = createLogger({});
