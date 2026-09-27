import { describe, expect, it } from "vitest";
import {
  Counter,
  DurationWindow,
  Gauge,
  Histogram,
  Registry,
  escapeLabelValue,
  metrics,
  normalizeRoute,
  quantileFromBuckets,
} from "./_core/metrics";

describe("counters and gauges", () => {
  it("increments per label set and renders the exposition format", () => {
    const counter = new Registry().counter("demo_total", "A demo counter.", [
      "code",
    ]);
    counter.inc({ code: "OK" });
    counter.inc({ code: "OK" });
    counter.inc({ code: "ERR" });

    expect(counter.get({ code: "OK" })).toBe(2);
    expect(counter.get({ code: "ERR" })).toBe(1);
    expect(counter.get({ code: "MISSING" })).toBe(0);

    const rendered = counter.render();
    expect(rendered).toContain("# HELP demo_total A demo counter.");
    expect(rendered).toContain("# TYPE demo_total counter");
    expect(rendered).toContain('demo_total{code="OK"} 2');
    expect(rendered).toContain('demo_total{code="ERR"} 1');
  });

  it("keeps label order stable so scrapes do not churn", () => {
    const counter = new Registry().counter("demo_total", "help", ["a", "b"]);
    counter.inc({ b: "2", a: "1" });
    expect(counter.render()).toContain('demo_total{a="1",b="2"} 1');
  });

  it("escapes label values that would otherwise break parsing", () => {
    expect(escapeLabelValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeLabelValue("back\\slash")).toBe("back\\\\slash");
    expect(escapeLabelValue("line\nbreak")).toBe("line\\nbreak");
  });

  it("stores gauge values by label set", () => {
    const gauge = new Registry().gauge("demo_gauge", "help", ["state"]);
    gauge.set({ state: "active" }, 3);
    gauge.set({ state: "idle" }, 7);

    expect(gauge.get({ state: "active" })).toBe(3);
    expect(gauge.render()).toContain('demo_gauge{state="active"} 3');
    expect(gauge.render()).toContain('demo_gauge{state="idle"} 7');
  });

  it("rejects malformed metric and label names", () => {
    expect(() => new Registry().counter("bad name", "help")).toThrow(
      /Invalid metric name/,
    );
    expect(() =>
      new Registry().counter("ok_total", "help", ["bad-label"]),
    ).toThrow(/Invalid label/);
  });

  it("emits HELP and TYPE even before the first sample", () => {
    const counter = new Registry().counter("demo_total", "help");
    expect(counter.render()).toContain("# TYPE demo_total counter");
  });

  it("clears samples on reset", () => {
    const registry = new Registry();
    const counter = registry.counter("demo_total", "help");
    counter.inc();
    registry.reset();
    expect(counter.get()).toBe(0);
    expect(counter.render()).not.toContain("demo_total 1");
  });
});

describe("histograms", () => {
  it("accumulates cumulative buckets, sum and count", () => {
    const histogram = new Registry().histogram(
      "demo_seconds",
      "Latency.",
      [0.1, 0.5, 1],
      ["route"],
    );
    histogram.observe({ route: "/a" }, 0.05);
    histogram.observe({ route: "/a" }, 0.3);

    const rendered = histogram.render();
    expect(rendered).toContain("# TYPE demo_seconds histogram");
    expect(rendered).toContain('demo_seconds_bucket{route="/a",le="0.1"} 1');
    expect(rendered).toContain('demo_seconds_bucket{route="/a",le="0.5"} 2');
    expect(rendered).toContain('demo_seconds_bucket{route="/a",le="1"} 2');
    expect(rendered).toContain('demo_seconds_bucket{route="/a",le="+Inf"} 2');
    expect(rendered).toContain('demo_seconds_count{route="/a"} 2');
    expect(rendered).toMatch(/demo_seconds_sum\{route="\/a"\} 0\.35/);
  });

  it("requires ascending buckets", () => {
    expect(() =>
      new Registry().histogram("demo_seconds", "help", [1, 0.5]),
    ).toThrow(/must ascend/);
  });

  it("aggregates a snapshot across label sets", () => {
    const histogram = new Registry().histogram(
      "demo_seconds",
      "help",
      [1, 10],
      ["route"],
    );
    histogram.observe({ route: "/a" }, 0.5);
    histogram.observe({ route: "/b" }, 5);

    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(2);
    expect(snapshot.sum).toBeCloseTo(5.5, 10);
    expect(snapshot.counts).toEqual([1, 2]);
  });
});

describe("quantileFromBuckets", () => {
  it("returns 0 when nothing has been observed", () => {
    expect(quantileFromBuckets([0.1, 0.2, 0.3], [0, 0, 0], 0, 0.95)).toBe(0);
  });

  it("interpolates within the bucket that holds the target", () => {
    // Values 0.05, 0.15, 0.25 -> cumulative 1, 2, 3.
    // p95 targets the 2.85th sample, inside the last bucket.
    const value = quantileFromBuckets([0.1, 0.2, 0.3], [1, 2, 3], 3, 0.95);
    expect(value).toBeCloseTo(0.285, 6);
  });

  it("returns the histogram upper bound for samples beyond the last bucket", () => {
    // Everything landed in the +Inf bucket, so the best estimate is the
    // widest bucket we have.
    const value = quantileFromBuckets([1, 5], [0, 0], 4, 0.95);
    expect(value).toBe(5);
  });
});

describe("DurationWindow", () => {
  it("reports 0 with no samples", () => {
    expect(new DurationWindow().p95()).toBe(0);
  });

  it("reports the 95th percentile of observed durations", () => {
    const window = new DurationWindow();
    for (let value = 1; value <= 100; value += 1) window.observe(value);
    expect(window.p95()).toBe(95);
  });

  it("forgets samples beyond its capacity", () => {
    const window = new DurationWindow(10);
    for (let value = 0; value < 100; value += 1) window.observe(value);
    expect(window.p95()).toBe(99);
  });
});

describe("normalizeRoute", () => {
  it("collapses record ids so cardinality stays bounded", () => {
    expect(
      normalizeRoute("/projects/550e8400-e29b-41d4-a716-446655440000"),
    ).toBe("/projects/:id");
    expect(normalizeRoute("/projects/123/attachments")).toBe(
      "/projects/:id/attachments",
    );
    expect(normalizeRoute("/files/0123456789abcdef0123")).toBe("/files/:id");
  });

  it("collapses values that are neither ids nor stable segments", () => {
    expect(normalizeRoute("/invitations/user@construction.local")).toBe(
      "/invitations/:token",
    );
    expect(normalizeRoute("/assets/index-a1b2c3d4.js")).toBe("/assets/:token");
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("")).toBe("/");
  });

  it("prefers Express's route pattern when the request matched one", () => {
    expect(normalizeRoute("/projects/123", "/projects/:id")).toBe(
      "/projects/:id",
    );
    expect(normalizeRoute("/projects/123", "projects/:id")).toBe(
      "/projects/:id",
    );
  });

  it("falls back to a sentinel for unbounded paths", () => {
    expect(normalizeRoute("/projects/123", "y".repeat(100))).toBe("/other");
    const wide = Array.from(
      { length: 5 },
      () => `/${"seg".padEnd(30, "x")}`,
    ).join("");
    expect(normalizeRoute(wide)).toBe("/other");
  });
});

describe("default registry", () => {
  it("exposes the families the production plan calls for", () => {
    const rendered = metrics.render();
    for (const family of [
      "northline_http_requests_total",
      "northline_http_errors_total",
      "northline_http_request_duration_seconds",
      "northline_http_request_duration_seconds_p95",
      "northline_readyz_failures_total",
      "northline_health_checks_total",
      "northline_db_pool_connections",
      "northline_db_pool_limit",
      "northline_http_requests_in_flight",
    ]) {
      expect(rendered).toContain(`# TYPE ${family}`);
    }
  });

  it("runs collectors before each scrape", () => {
    const registry = new Registry();
    const gauge = registry.gauge("demo_gauge", "help");
    registry.onCollect(() => gauge.set({}, 42));
    expect(registry.render()).toContain("demo_gauge 42");
  });
});

describe("Counter", () => {
  it("supports partial label sets being merged over time", () => {
    const counter: Counter = new Registry().counter("demo_total", "help", [
      "code",
    ]);
    counter.inc({ code: "OK" }, 5);
    counter.inc({ code: "OK" }, 5);
    expect(counter.get({ code: "OK" })).toBe(10);
  });
});

describe("Gauge", () => {
  it("overwrites rather than accumulates", () => {
    const gauge: Gauge = new Registry().gauge("demo_gauge", "help");
    gauge.set({}, 1);
    gauge.set({}, 9);
    expect(gauge.get({})).toBe(9);
  });
});

describe("Histogram", () => {
  it("keeps separate series per label set", () => {
    const histogram: Histogram = new Registry().histogram(
      "demo_seconds",
      "help",
      [1],
      ["route"],
    );
    histogram.observe({ route: "/a" }, 0.5);
    histogram.observe({ route: "/b" }, 2);

    const rendered = histogram.render();
    expect(rendered).toContain('demo_seconds_count{route="/a"} 1');
    expect(rendered).toContain('demo_seconds_count{route="/b"} 1');
  });
});
