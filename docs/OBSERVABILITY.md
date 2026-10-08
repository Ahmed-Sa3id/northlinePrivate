# Observability

Everything below is implemented and covered by tests in this repository — no vendor
account is required to run it. The external pieces (a real Sentry project, a metrics
scrape, log shipping) are configuration-only when those accounts exist.

Design note: **no new dependencies were added.** The exposition format and the JSON
log shape are small, fixed surfaces covered by unit tests, so keeping the dependency
tree untouched preserves the frozen lockfile that CI and the Docker build rely on.

---

## 1. Structured logs

Every log record is a single line of JSON written to stdout:

```json
{"time":"2026-09-26T21:44:02.913Z","level":"error","msg":"unhandled request error","requestId":"e2f1…","route":"/projects","method":"POST","path":"/projects","status":500,"err":{"type":"Error","message":"…","stack":"…"}}
```

| Field | Meaning |
| --- | --- |
| `time` | ISO-8601 UTC |
| `level` | `debug` \| `info` \| `warn` \| `error` |
| `msg` | stable, low-cardinality event name |
| `requestId` | matches the `X-Request-ID` response header |
| `err` | serialised `Error`: `type`, `message`, `stack`, `code`, nested `cause` |

Controlled by `LOG_LEVEL` (`debug` \| `info` \| `warn` \| `error`, default `info`).

### Redaction

Two independent layers, both applied to every record:

1. **By key** — a field whose name contains `password`, `passwd`, `passphrase`,
   `secret`, `token`, `apikey`, `authorization`, `cookie`, `credential`,
   `privatekey`, `signature` or `bearer` has its value replaced with
   `[REDACTED]`. Matching is done on the key with non-alphanumerics stripped, so
   `passwordHash`, `api_key` and `Api-Key` are all caught.
2. **By value** — every string is scanned for secret-shaped content regardless of
   key: database URLs (`mysql://user:password@host`), `Bearer …` tokens, JWTs,
   Stripe `sk_live_`/`pk_test_` keys, Resend `re_…` keys and AWS `AKIA…` ids.

Layer 2 is what stops a credential filed under an innocuous key from reaching the
log. `server/logger.unit.test.ts` asserts both layers, including that a submitted
login password never appears in an emitted record.

---

## 2. Request IDs

`server/index.ts` mints (or honours a client-supplied) `X-Request-ID` before any
other middleware and creates a child logger bound to it. Every access-log record,
error record and error-tracking event for that request carries the same id, which
is what makes a dashboard error traceable back to the log line that produced it.

Verified by `server/observability.integration.test.ts`:
"request id correlation" and "deliberate error".

---

## 3. Metrics

`GET /metrics` serves Prometheus text exposition.

| Metric | Type | Purpose |
| --- | --- | --- |
| `northline_http_requests_total{method,route,status}` | counter | request and error rate |
| `northline_http_errors_total{code}` | counter | unhandled errors by code |
| `northline_http_request_duration_seconds{method,route}` | histogram | latency, native `histogram_quantile` |
| `northline_http_request_duration_seconds_p95` | gauge | p95 over a rolling window, no PromQL needed |
| `northline_http_requests_in_flight` | gauge | concurrency |
| `northline_db_pool_connections{state}` | gauge | `active` / `idle` connections |
| `northline_db_pool_limit` | gauge | configured `connectionLimit` |
| `northline_health_checks_total{result}` | counter | `ok` / `unhealthy` / `unavailable` |
| `northline_readyz_failures_total` | counter | readiness flapping |
| `northline_rate_limit_shared_store_enabled` | gauge | `1` shared DB store, `0` degraded to memory — returns to `1` on a successful re-probe |
| `northline_rate_limit_fallback_total{code}` | counter | why the limiter degraded, and every failed re-probe, by MariaDB error code |
| `northline_email_sends_total{flow,result}` | counter | transactional mail that never arrived |

**Label sets are closed.** `flow` is `verification` | `password-reset` |
`invitation`; `result` is `delivered` | `suppressed` | `failed`
(`suppressed` = no credentials configured, so nothing was attempted). No
recipient address or tenant ever becomes a label. Because delivery happens
*after* the database commits and a rejection does not fail the request, this
counter is the only thing that distinguishes "sign-ups are working" from
"sign-ups that can never be verified".

**Route labels are bounded.** They come from Express's route pattern when the
request matched one, and are otherwise normalised — record ids become `:id`,
emails, hashes and hashed asset names become `:token`, and anything longer than
80 characters collapses to `/other`. Request ids can never fan out into
unbounded cardinality.

### Access control

| Environment | `METRICS_TOKEN` | `/metrics` |
| --- | --- | --- |
| not production | unset | open |
| not production | set | requires `Bearer <token>` |
| production | unset | **404** (logged at startup) |
| production | set | requires `Bearer <token>` (constant-time compare) |

### Example alerts

```promql
# 5xx rate > 1% over 5m
sum(rate(northline_http_requests_total{status=~"5.."}[5m]))
  / sum(rate(northline_http_requests_total[5m])) > 0.01

# p95 latency above 1s
northline_http_request_duration_seconds_p95 > 1

# readiness flapping
increase(northline_readyz_failures_total[15m]) > 3

# login throttling is on per-process memory, or has degraded recently.
# A transient blip self-repairs after LOGIN_RATE_REPROBE_MS (default 60s), so a
# 0 that survives longer than that window means the store is genuinely
# unreachable — while a rise in the counter is worth a look even if the gauge
# has already recovered, because it shows the outage happened at all.
northline_rate_limit_shared_store_enabled == 0
  or increase(northline_rate_limit_fallback_total[1h]) > 0

# pool saturation
northline_db_pool_connections{state="active"} / northline_db_pool_limit > 0.8

# account mail is being rejected — nobody can verify or get invited
increase(northline_email_sends_total{result="failed"}[15m]) > 0
```

---

## 4. Error tracking

Every unhandled error goes through `reportException()` and lands in **two** places:

1. the structured log line (`msg: "unhandled request error"`), and
2. an `ErrorReporter`.

The default reporter is a bounded in-memory ring of the last 200 events, keyed by
request id — so an error is never silently dropped just because no vendor is
configured, and the tests assert against it.

Setting `SENTRY_DSN` forwards the same events to Sentry over HTTP using the
envelope format — **no SDK and no lockfile change**, enabling an account is
purely configuration. Delivery is best-effort: a failure is logged at `warn` and
swallowed, and the event is still kept locally.

---

## 5. Verifying a deployment

```
GET /_observability/probe
```

Throws a deliberate error. A single request should therefore produce:

- an `X-Request-ID` header,
- a JSON 500 body (`INTERNAL_ERROR`, no stack leaked),
- an `error`-level log line with that request id,
- an event in the error reporter with that request id,
- an incremented `northline_http_requests_total{status="500"}` and
  `northline_http_errors_total{code="INTERNAL_ERROR"}`.

Enabled outside production by default. In production it requires an explicit
`ENABLE_ERROR_PROBE=1`, because it is also an easy way to generate error-rate
noise. It is registered before the error handler, which is what guarantees the
structured handler — not Express's default HTML stack page — answers the request.

---

## 6. What the instrumentation already caught

Both were invisible before: they only ever produced a `console.warn`, and the suite
stayed green because the in-process fallback still rate-limits — just not across
instances, and not after a restart.

| | Symptom | Cause |
| --- | --- | --- |
| **Lock name overflow** | every `GET_LOCK` raised `ER_TOO_LONG_IDENT` | `northline-rate:` + path + IPv6-mapped client address + a normal email is **~69 bytes** against MariaDB's 64-byte ceiling — so *no* login ever used the shared store |
| **Bucket key overflow** | the `INSERT` raised `ER_DATA_TOO_LONG` | `rate_limit_buckets.key` is `varchar(512)` but `clientKey` embedded the submitted email unbounded — an **unauthenticated one-request** way to permanently degrade throttling |

Both hit the same `catch`, which flips a process-wide flag. The fixes:

- `toLockName()` (`server/lock.ts`) passes short names through untouched and
  substitutes a SHA-256 digest over 64 bytes — protecting all three lock call sites.
- `clientKey()` (`server/rateLimit.ts`) digests keys longer than the column.
- The degradation itself is now observable (`northline_rate_limit_shared_store_enabled`
  and `northline_rate_limit_fallback_total`), so a future failure is an alert rather
  than a silent loss of cross-instance throttling.
- The flag is no longer one-way. After `LOGIN_RATE_REPROBE_MS` the next sign-in
  re-probes the store and restores shared throttling on the first success; a failed
  probe restarts the window, so an outage costs at most one probe per window rather
  than one per request. Attempts counted in memory are carried into the shared bucket
  on recovery, so re-probing cannot be used to reset a lockout in progress.

Regression coverage: `server/lock.unit.test.ts`,
`server/rateLimit.store.integration.test.ts` and
`server/rateLimit.reprobe.integration.test.ts`.

---

## 7. Still outstanding (needs an account)

- A verified Resend sending domain → the API key is already configured, but
  **no domain is verified**, so every send is answered with
  `403 … domain is not verified`, `northline_email_sends_total{result="failed"}`
  counts it, and no verification or invitation mail can leave the system. The
  alert above will fire until then. Full limitation in
  [`DEPLOY.md` §7](../DEPLOY.md).
- A real Sentry project → paste its DSN into `SENTRY_DSN` and re-run the probe.
- A Prometheus scrape + Grafana/Alertmanager → point at `/metrics` with
  `METRICS_TOKEN`.
- Centralised log shipping → stdout is already JSON; retain `requestId` as an
  indexed field so logs and dashboard errors join on it.
