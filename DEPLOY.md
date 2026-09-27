# Northline deployment on Railway

This guide deploys Northline as a Docker service on Railway and connects it to Railway's managed MySQL service. The repository contains no production secrets; all credentials are entered in Railway's Variables UI or CLI.

## 1. Create the Railway project

1. Create an account at [railway.com](https://railway.com/) and install the Railway CLI if you want to run migration commands from your computer.
2. Create a new Railway project and choose **Deploy from GitHub repo**.
3. Select the repository containing Northline. Railway detects `railway.json` and builds the existing `Dockerfile`.
4. In the project canvas, choose **New → Database → MySQL**. Railway provisions the managed MySQL service and exposes variables including `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, `MYSQLDATABASE`, and `MYSQL_URL`.

## 2. Configure the app service

Open the app service's **Variables** tab and add these values. Use Railway's reference-variable picker for the MySQL value rather than copying a password into the repository:

| Variable                  | Value                                                                    |
| ------------------------- | ------------------------------------------------------------------------ |
| `NODE_ENV`                | `production`                                                             |
| `DATABASE_URL`            | `${{MySQL.MYSQL_URL}}` (select the actual MySQL service name in Railway) |
| `JWT_SECRET`              | A newly generated random secret, at least 32 characters                  |
| `ALLOWED_ORIGINS`         | The app origin, comma-separated — never `*`                              |
| `APP_URL`                 | The public HTTPS origin. **Every emailed link is built from this.**      |
| `EMAIL_FROM`              | Sender for verification / reset / invitation mail — see §7               |
| `RESEND_API_KEY`          | Resend API key, server-side only — see §7                                |
| `UPLOAD_DIR`              | `/app/uploads`                                                           |
| `AUDIT_DIR`               | `/app/audit`                                                             |
| `TRUST_PROXY`             | `true`                                                                   |
| `LOGIN_RATE_WINDOW_MS`    | `900000`                                                                 |
| `LOGIN_RATE_MAX_ATTEMPTS` | `10`                                                                     |
| `LOGIN_RATE_BLOCK_MS`     | `900000`                                                                 |
| `LOG_LEVEL`               | `info` (`debug` \| `info` \| `warn` \| `error`)                           |
| `METRICS_TOKEN`           | A random bearer token — **required for `/metrics` in production**        |
| `SENTRY_DSN`              | Sentry DSN, once a project exists (optional)                             |
| `ENABLE_ERROR_PROBE`      | omit — only set to `1` to allow `/_observability/probe` in production    |

**`METRICS_TOKEN` matters:** in production `/metrics` returns 404 unless this is set, so
the app never exposes route and error-rate data unauthenticated — but that also means
Prometheus cannot scrape it until you configure it. The app logs a warning at startup when
it is missing.

**What the `LOGIN_RATE_*` values actually count:** every request through the limiter
occupies an attempt slot, and a *successful* sign-in hands its slot straight back. That
reset is the difference between "an attacker gets 10 guesses per window" and "a user who
signs in correctly ten times is locked out for 15 minutes" — the second is a bug, so
`clearRateLimitFor()` empties the bucket as soon as the password verifies. Wrong passwords
and malformed payloads still accumulate exactly as before. The buckets live in the
`rate_limit_buckets` table guarded by an advisory lock, so the count is shared across
replicas; watch `northline_rate_limit_shared_store_enabled` (see `docs/OBSERVABILITY.md`)
to confirm a replica has not silently dropped to per-process memory.

Do not add `.env` to Git. `PORT` is intentionally omitted: Railway injects it at runtime, and `server/index.ts` binds to `process.env.PORT` with a local fallback only for development. The production cookie configuration evaluates `secure: true` when `NODE_ENV=production`.

## 3. Deploy and obtain the public URL

Click **Deploy** or run:

```bash
railway link
railway up
```

After deployment, open the app service's **Settings → Networking → Generate Domain**. Verify:

```bash
curl -fsS https://YOUR-RAILWAY-DOMAIN/health
```

The expected response is `{"ok":true}`. Open the generated HTTPS domain in a browser.

## 4. Run the first production migration

Once the app and MySQL services are running, use Railway's shell or the CLI with the app variables injected. From the repository root:

```bash
railway link
railway run pnpm db:push
```

**Do not run `pnpm db:seed` against production.** It creates a demo company, a sample project and four fixture accounts whose passwords are published in README.md; the seed now refuses to do this when `NODE_ENV=production`. Production tenants are created through registration, and subscription plans are provisioned by migration `0002_boring_salo.sql`, so no seed step is required.

For a non-production demonstration environment — and never for a real deployment — the fixture accounts and pitch dataset can still be created by opting in explicitly:

```bash
SEED_DEMO_USERS=1 railway run pnpm db:seed
SEED_DEMO_USERS=1 railway run pnpm db:seed:demo
```

Alternatively, run the commands from the app service's **Shell** tab. Never paste a real database password or `JWT_SECRET` into source files or commit history.

## 5. Production checklist

Confirm that the app domain uses HTTPS, `/health` returns 200 with both `application: "ok"` and `database: "ok"`, the login response contains an `HttpOnly; Secure` `northline_session` cookie, and `/auth/me` works in the browser. Confirm no fixture accounts reached the database — `SELECT email FROM users WHERE email LIKE '%@construction.local'` must return no rows — and that no demo company was created (`demo@northline.local`). Enable database backups on a schedule and retain persistent storage for `/app/uploads` and `/app/audit` if the hosting plan supports volumes; both are filesystem assets that logical backups do not capture. Railway's MySQL service is private by default; the app should connect through the internal `MYSQL_URL` reference.

`.github/workflows/backup.yml` is that schedule. It runs nightly at 03:00 UTC (and on demand via `workflow_dispatch`), dumps whatever the `DATABASE_URL` repository secret points at through `scripts/backup-db.sh`, and stores the dump plus its `.sha256` as a workflow artifact for 30 days — a copy that lives away from wherever the database runs. While the secret is unset it reports a clean notice instead of failing, so the schedule is not permanently red before there is production data. The same workflow runs a second job that has value regardless: seed a database, dump it with the production script, restore it into an isolated copy, then run the **entire test suite against the restored data**. A dump that has never been restored is a guess, not a backup. Two limits worth knowing: GitHub pauses scheduled workflows after 60 days without repository activity, and a GitHub-hosted runner can only reach a database reachable from the public internet — Railway's is private, so a real nightly dump needs a self-hosted runner or an export step on the app side. Artifacts are also not encrypted by us; the encrypted cross-region copy remains outstanding.

The four legal documents — `/terms`, `/privacy`, `/support` and `/refunds` — ship with the app and are reachable from the landing page, the sign-up consent line, the signed-in workspace footer, the billing panel's refund link, and directly as deep links. They still require review by counsel before any paid pilot: the contracting entity and the governing-law jurisdiction are deliberately left unstated so counsel can set them. Support contact details come from one place, `CONTACT_EMAIL` in `web/Legal.tsx`, so changing the address is a one-line edit.

The migration history in `drizzle/` is additive and must be applied before starting a new environment. If a target database already contains a different WebDev scaffold migration journal, do not force the Northline migrations over it; provision a clean database or reconcile the schemas with a reviewed migration. Run the backup/restore drill described in `BACKUP-RESTORE.md` before accepting production traffic; drill results are recorded in [`docs/BACKUP_DRILL.md`](./docs/BACKUP_DRILL.md). Drill #1 passed on 2026-09-26.

The login and registration limiter uses the `rate_limit_buckets` table when the database is available, which makes throttling shared across replicas. It falls back to a bounded process-local bucket only during database outages, so database health alerts remain important. That fallback is a one-way switch for the life of the process, so it is surfaced explicitly: `northline_rate_limit_shared_store_enabled` reads `1` while the shared store is in use and `0` after any failure, and `northline_rate_limit_fallback_total{code}` records the reason. Alert on either.

## 6. Observability

See [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) for the full reference (log fields, redaction rules, metric catalogue, example alert expressions).

1. **Structured logs.** Everything the API logs is one JSON object per line on stdout, with `requestId` on every record. Point Railway's log drain at it and index `requestId`.
2. **Scrape metrics.** `curl -H "Authorization: Bearer $METRICS_TOKEN" https://YOUR-DOMAIN/metrics` must return Prometheus text, including `northline_http_requests_total`.
3. **Verify a deployment end to end:**

   ```bash
   curl -i https://YOUR-DOMAIN/_observability/probe
   ```

   Expect `X-Request-ID` on the response, a JSON `INTERNAL_ERROR` body with no stack trace, a matching `error`-level log line, an entry in the error reporter under that request id, and incremented `northline_http_requests_total{status="500"}` / `northline_http_errors_total`. This route is disabled in production unless `ENABLE_ERROR_PROBE=1`; enable it briefly, verify, then remove the variable.
4. **Errors.** Set `SENTRY_DSN` when a Sentry project exists — events are forwarded over plain HTTP, no SDK or dependency change is involved.

## 7. Transactional email (Resend)

Northline sends three kinds of mail — email verification, password reset and
workspace invitations — through Resend's HTTP API. There is no SDK and no SMTP
library: `server/email.ts` posts JSON to `https://api.resend.com/emails` with
`RESEND_API_KEY` as a bearer token. The key is read from the environment on
the server only; it is never part of a response body, a log record or the
frontend bundle.

**The one thing that still blocks real delivery: Resend requires a verified
sending domain.** Resend's own documentation is explicit — *"Resend sends
emails using a domain you own (i.e. not a shared or public domain). You must
add and verify at least one domain to send and receive emails with Resend."*
There is no single-sender verification (the flow some other providers offer
for one address), so until a domain is added at
[resend.com/domains](https://resend.com/domains) and its DNS records verified:

- Any `EMAIL_FROM` on an unverified domain makes Resend answer
  `403 validation_error: The <domain> domain is not verified.` — the app logs
  that message at `error` level and increments
  `northline_email_sends_total{result="failed"}`, but **no email leaves the
  system**.
- The only sender Resend accepts without a domain is its own test address,
  `onboarding@resend.dev`, and it can then deliver **only to the single email
  address registered to your Resend account**. That is enough to watch one
  verification link arrive end to end, and nothing more. It is deliberately
  not a default anywhere in the code — `EMAIL_FROM` has no fallback.
- Northline does not hard-code a sending domain, and `.env.example` ships only
  placeholders.

Buying a domain is not required to *run* Northline — it is required to
*deliver mail through Resend*. When a domain is available, the change is two
environment variables and a DNS record; no code changes.

### Behaviour when sending fails

Delivery is attempted **after** the database work commits, and a provider
failure does not fail the request. Registering an account whose verification
mail was rejected still returns `201` with `emailDelivered: false`, because
otherwise the caller would receive a `500` for an account that now exists —
and a retry would hit `EMAIL_ALREADY_EXISTS` while
`/auth/resend-verification` would fail the same way, leaving no path forward.
`POST /invitations` reports `emailDelivered` the same way.

The failure is therefore surfaced three ways:

| Signal | Meaning |
| --- | --- |
| `error` log record `transactional email delivery failed` | Carries `flow`, `to`, `subject`, `requestId` and the provider's own reason |
| `northline_email_sends_total{flow,result="failed"}` | Alert on any non-zero rate |
| `emailDelivered: false` in the API response | The client tells the user immediately |

`flow` is one of `verification`, `password-reset`, `invitation`; `result` is
one of `delivered`, `suppressed`, `failed`.

`/auth/forgot-password` and `/auth/resend-verification` deliberately **do not**
return `emailDelivered`: they answer identically whether or not an account
exists, and a delivery flag would turn them into an account-enumeration
oracle.

Only transient failures are retried (timeout, `408`, `429`, `5xx`, network
error) — one attempt after a 250 ms pause. A `4xx` rejection is permanent and
is not repeated.

### Verify a deployment end to end

```bash
# 1. Set EMAIL_FROM + RESEND_API_KEY, then register a test account.
# 2. Confirm the send was recorded (rather than assuming):
curl -H "Authorization: Bearer $METRICS_TOKEN" https://YOUR-DOMAIN/metrics | grep northline_email_sends
# 3. Follow the link from the received email: /verify-email?token=…
#    must return the application shell (HTTP 200), not `Cannot GET`.
```

## Render alternative

Render can build the Dockerfile, but it does not provide a first-party managed MySQL add-on equivalent to Railway's MySQL template. If Railway is unavailable, use Render for the app service and connect `DATABASE_URL` to an externally managed MySQL/MariaDB provider, keeping the same variable names and migration commands.
