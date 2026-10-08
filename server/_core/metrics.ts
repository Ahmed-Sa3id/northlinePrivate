/**
 * Prometheus text-format metrics.
 *
 * Written by hand rather than pulled in as a dependency: the exposition
 * format here is small, fixed, and fully covered by unit tests, and keeping
 * the dependency tree unchanged means the frozen lockfile used by CI and the
 * Docker build stays valid.
 *
 * What is exposed and why (per the production plan):
 *   - `http_requests_total` / `http_errors_total`  -> error rate
 *   - `http_request_duration_seconds` + `_p95`     -> latency
 *   - `db_pool_connections`                        -> connection pressure
 *   - `readyz_failures_total`                      -> readiness flapping
 *   - `email_sends_total`                          -> undelivered account mail
 *
 * Every counter label is bounded: route labels come from Express's route
 * pattern where available and are otherwise normalised, so request ids and
 * record ids can never fan out into unbounded cardinality.
 */

export type MetricLabels = Record<string, string | number | undefined>;

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function escapeLabelValue(value: string | number): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return String(value);
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid metric name: ${name}`);
  }
}

function keyOf(labels: MetricLabels): { key: string; used: MetricLabels } {
  const used: MetricLabels = {};
  const names = Object.keys(labels)
    .filter((name) => labels[name] !== undefined)
    .sort();
  for (const name of names) {
    if (!LABEL_PATTERN.test(name)) throw new Error(`Invalid label: ${name}`);
    used[name] = labels[name] as string | number;
  }
  const key = names.map((name) => `${name}=${String(used[name])}`).join("");
  return { key, used };
}

function renderLabels(labels: MetricLabels): string {
  const names = Object.keys(labels);
  if (names.length === 0) return "";
  const body = names
    .map((name) => `${name}="${escapeLabelValue(labels[name] as string)}"`)
    .join(",");
  return `{${body}}`;
}

function sortLabels(labels: MetricLabels): MetricLabels {
  const sorted: MetricLabels = {};
  for (const name of Object.keys(labels).sort()) sorted[name] = labels[name];
  return sorted;
}

abstract class MetricFamily {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "gauge" | "histogram",
    readonly labelNames: string[],
  ) {
    validateName(name);
    for (const label of labelNames) {
      if (!LABEL_PATTERN.test(label))
        throw new Error(`Invalid label: ${label}`);
    }
  }

  header(): string {
    return `# HELP ${this.name} ${escapeHelp(this.help)}\n# TYPE ${this.name} ${this.type}\n`;
  }

  /** Emits this family's samples, or an empty string when there are none. */
  abstract render(): string;

  /** Drops every recorded sample (used by tests between assertions). */
  abstract reset(): void;
}

export class Counter extends MetricFamily {
  private readonly values = new Map<
    string,
    { labels: MetricLabels; value: number }
  >();

  constructor(name: string, help: string, labelNames: string[] = []) {
    super(name, help, "counter", labelNames);
  }

  inc(labels: MetricLabels = {}, delta = 1): void {
    const { key, used } = keyOf(labels);
    const existing = this.values.get(key);
    if (existing) existing.value += delta;
    else this.values.set(key, { labels: used, value: delta });
  }

  get(labels: MetricLabels = {}): number {
    return this.values.get(keyOf(labels).key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    if (this.values.size === 0) return this.header();
    let out = this.header();
    for (const { labels, value } of this.values.values()) {
      out += `${this.name}${renderLabels(sortLabels(labels))} ${formatNumber(value)}\n`;
    }
    return out;
  }
}

export class Gauge extends MetricFamily {
  private readonly values = new Map<
    string,
    { labels: MetricLabels; value: number }
  >();

  constructor(name: string, help: string, labelNames: string[] = []) {
    super(name, help, "gauge", labelNames);
  }

  set(labels: MetricLabels, value: number): void {
    const { key, used } = keyOf(labels);
    this.values.set(key, { labels: used, value });
  }

  get(labels: MetricLabels = {}): number | undefined {
    return this.values.get(keyOf(labels).key)?.value;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    if (this.values.size === 0) return this.header();
    let out = this.header();
    for (const { labels, value } of this.values.values()) {
      out += `${this.name}${renderLabels(sortLabels(labels))} ${formatNumber(value)}\n`;
    }
    return out;
  }
}

interface HistogramSeries {
  labels: MetricLabels;
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends MetricFamily {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    name: string,
    help: string,
    readonly buckets: number[],
    labelNames: string[] = [],
  ) {
    super(name, help, "histogram", labelNames);
    const sorted = [...buckets];
    if (
      sorted.some((value, index) => index > 0 && value <= sorted[index - 1])
    ) {
      throw new Error(`Histogram ${name} buckets must ascend`);
    }
    this.buckets = sorted;
  }

  observe(labels: MetricLabels, value: number): void {
    const { key, used } = keyOf(labels);
    let series = this.series.get(key);
    if (!series) {
      series = {
        labels: used,
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, series);
    }
    series.sum += value;
    series.count += 1;
    for (let index = 0; index < this.buckets.length; index += 1) {
      if (value <= this.buckets[index]) series.counts[index] += 1;
    }
  }

  /** Aggregated samples across every label set, for deriving quantiles. */
  snapshot(): {
    sum: number;
    count: number;
    counts: number[];
    buckets: number[];
  } {
    let sum = 0;
    let count = 0;
    const counts = new Array(this.buckets.length).fill(0);
    for (const series of this.series.values()) {
      sum += series.sum;
      count += series.count;
      series.counts.forEach((value, index) => (counts[index] += value));
    }
    return { sum, count, counts, buckets: this.buckets };
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    if (this.series.size === 0) return this.header();
    let out = this.header();
    for (const series of this.series.values()) {
      const labels = sortLabels(series.labels);
      for (let index = 0; index < this.buckets.length; index += 1) {
        out += `${this.name}_bucket${renderLabels({
          ...labels,
          le: formatNumber(this.buckets[index]),
        })} ${series.counts[index]}\n`;
      }
      out += `${this.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${series.count}\n`;
      out += `${this.name}_sum${renderLabels(labels)} ${formatNumber(series.sum)}\n`;
      out += `${this.name}_count${renderLabels(labels)} ${series.count}\n`;
    }
    return out;
  }
}

/**
 * Quantiles are interpolated from cumulative bucket counts the same way
 * Prometheus's `histogram_quantile` does, so the value exposed as a gauge and
 * the value computed by PromQL agree with each other.
 */
export function quantileFromBuckets(
  buckets: number[],
  counts: number[],
  count: number,
  quantile: number,
): number {
  if (count === 0) return 0;
  const target = quantile * count;
  let previousCount = 0;
  let previousUpper = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    if (counts[index] >= target) {
      const inBucket = counts[index] - previousCount;
      if (inBucket <= 0) return buckets[index];
      const within = (target - previousCount) / inBucket;
      return previousUpper + (buckets[index] - previousUpper) * within;
    }
    previousCount = counts[index];
    previousUpper = buckets[index];
  }
  return buckets[buckets.length - 1];
}

export class Registry {
  private readonly families: MetricFamily[] = [];
  private readonly collectors: Array<() => void> = [];

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const family = new Counter(name, help, labelNames);
    this.families.push(family);
    return family;
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const family = new Gauge(name, help, labelNames);
    this.families.push(family);
    return family;
  }

  histogram(
    name: string,
    help: string,
    buckets: number[],
    labelNames: string[] = [],
  ): Histogram {
    const family = new Histogram(name, help, buckets, labelNames);
    this.families.push(family);
    return family;
  }

  /** Callbacks run immediately before each scrape, so gauges can be derived
   *  from live state instead of a value cached at boot. */
  onCollect(collector: () => void): void {
    this.collectors.push(collector);
  }

  render(): string {
    for (const collector of this.collectors) collector();
    let out = "";
    for (const family of this.families) out += family.render();
    return out;
  }

  reset(): void {
    for (const family of this.families) family.reset();
  }
}

/** Request paths become low-cardinality route labels. */
export function normalizeRoute(
  pathname: string,
  routePattern?: string,
): string {
  if (routePattern) {
    const combined = routePattern.startsWith("/")
      ? routePattern
      : `/${routePattern}`;
    return combined.length > 80 ? "/other" : combined;
  }
  if (!pathname) return "/";
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          segment,
        )
      ) {
        return ":id";
      }
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ":id";
      if (segment.includes("@") || segment.includes(".")) return ":token";
      if (segment.length > 40) return ":token";
      return segment;
    });
  const route = `/${segments.join("/")}`;
  return route.length > 80 ? "/other" : route || "/";
}

/** The process-wide registry used by the HTTP middleware. */
export const metrics = new Registry();

export const httpRequestDuration = metrics.histogram(
  "northline_http_request_duration_seconds",
  "HTTP request latency in seconds, grouped by route.",
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ["method", "route"],
);

export const httpRequests = metrics.counter(
  "northline_http_requests_total",
  "HTTP requests handled, by method, route and status.",
  ["method", "route", "status"],
);

export const httpErrors = metrics.counter(
  "northline_http_errors_total",
  "Unhandled HTTP errors, by error code.",
  ["code"],
);

export const httpInFlight = metrics.gauge(
  "northline_http_requests_in_flight",
  "HTTP requests currently being handled.",
);

export const readyzFailures = metrics.counter(
  "northline_readyz_failures_total",
  "Readiness checks that reported the application unavailable.",
);

export const healthChecks = metrics.counter(
  "northline_health_checks_total",
  "Health probes by result.",
  ["result"],
);

export const dbPoolConnections = metrics.gauge(
  "northline_db_pool_connections",
  "Database connections held by the pool, by state.",
  ["state"],
);

export const dbPoolLimit = metrics.gauge(
  "northline_db_pool_limit",
  "Configured database pool connection limit.",
);

/**
 * Login throttling degrades silently otherwise: when the shared store throws,
 * the process falls back to in-process buckets and cross-instance throttling
 * is off. This gauge makes that state scrapeable — it reads 0 for exactly as
 * long as the store is out of play, and returns to 1 on a successful re-probe,
 * so a transient blip is visible and self-repairing rather than permanent —
 * and the counter records why it fell, by database error code, on every
 * attempt including each failed re-probe.
 */
export const rateLimitSharedStore = metrics.gauge(
  "northline_rate_limit_shared_store_enabled",
  "1 when login throttling uses the shared database store, 0 when it has fallen back to process memory.",
);

export const rateLimitFallbacks = metrics.counter(
  "northline_rate_limit_fallback_total",
  "Times the shared rate-limit store failed and the process fell back to memory, by database error code.",
  ["code"],
);

/**
 * Transactional email is the one integration that is deliberately allowed to
 * fail without failing the request (see `deliverTransactionalEmail`), so
 * without this counter a rejected sender would be invisible: registration
 * would keep returning 201 while nobody could ever verify an account.
 * `flow` and `result` are both closed sets — no address or tenant ever
 * becomes a label.
 */
export const emailSends = metrics.counter(
  "northline_email_sends_total",
  "Transactional email attempts by product flow and outcome (delivered, suppressed, failed).",
  ["flow", "result"],
);

/** Rolling window feeding the exported p95 gauge. */
export class DurationWindow {
  private readonly samples: number[] = [];

  constructor(private readonly capacity = 512) {}

  observe(seconds: number): void {
    this.samples.push(seconds);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  p95(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(0.95 * sorted.length) - 1),
    );
    return sorted[index];
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export const requestDurations = new DurationWindow();

const requestDurationP95 = metrics.gauge(
  "northline_http_request_duration_seconds_p95",
  "95th percentile HTTP request latency over a rolling window.",
);

metrics.onCollect(() => {
  requestDurationP95.set({}, requestDurations.p95());
});
