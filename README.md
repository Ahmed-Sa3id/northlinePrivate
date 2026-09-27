# Northline Construction Lifecycle Platform

Northline is a role-based construction operations platform for projects, attendance, materials, expenses, and site-safety issues. The repaired snapshot is a standalone Express, Drizzle, MariaDB, React, and Vite application reconstructed from a flattened project export.

## Requirements

Node.js 22 or newer (Vite requires 22.12+), pnpm, and MySQL or MariaDB are required. The application stores all timestamps as UTC database timestamps. Browser sessions use the HttpOnly `northline_session` cookie; the login response also returns a short-lived JWT for non-browser API clients that use the `Authorization: Bearer` header. The migration chain currently runs `0000` through `0014` (15 migrations).

## Local setup

```bash
pnpm install
export DATABASE_URL='mysql://construction_app:change-me@127.0.0.1:3306/construction_platform'
export JWT_SECRET='replace-with-a-long-random-secret'
pnpm db:push
pnpm db:seed
pnpm dev
```

The API listens on `http://localhost:3000`. The frontend is built with `pnpm build` and emitted to `dist/web`; the production server serves it alongside the API.

For local MariaDB, create the database and user before running migrations:

```sql
CREATE DATABASE construction_platform;
CREATE USER 'construction_app'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON construction_platform.* TO 'construction_app'@'localhost';
FLUSH PRIVILEGES;
```

## Demo accounts

| Role          | Email                           | Password         |
| ------------- | ------------------------------- | ---------------- |
| Administrator | `admin@construction.local`      | `Admin123!`      |
| Supervisor    | `supervisor@construction.local` | `Supervisor123!` |
| Worker        | `worker@construction.local`     | `Worker123!`     |
| Accountant    | `accountant@construction.local` | `Accountant123!` |

These are **local development and test fixtures** — the integration suite authenticates as them, which is why their passwords are fixed and public.

They are **never created in production**: `pnpm db:seed` skips the demo company, sample project and all four accounts whenever `NODE_ENV=production`, and `pnpm db:seed:demo` refuses to run at all. Set `SEED_DEMO_USERS=1` only for a deliberate non-production demonstration. Production tenants are created by registration, not by seeding.

## API modules

The API provides credential login, admin-only user management, project CRUD, project assignments, attendance check-in/check-out, materials and material transactions, expenses, and safety issues with image uploads. Every protected route authenticates the session cookie or bearer token and enforces role and project scope on the server. Password hashes are removed from public user objects.

Login and registration attempts use a database-backed shared bucket when the database is available, with a bounded in-memory fallback for database outages. Mutating requests are recorded as newline-delimited JSON entries under `audit/audit.log` and persisted to tenant-scoped `audit_logs`; configure `AUDIT_DIR` to change the directory. Uploaded issue images are stored locally under `uploads/`; configure `UPLOAD_DIR` to change the directory. Browser sessions use the secure `northline_session` httpOnly cookie; the login response also exposes the JWT for non-browser API clients that use the `Authorization: Bearer` header.

The React workspace includes overview, projects, attendance, materials, finance, safety issues, and admin/audit screens. Admins can create projects, update project status, delete projects, assign users to projects, inspect users, and review audit entries. Supervisors can manage assigned operational records, workers can check in and out of their own attendance, and accountants can record expenses and inspect financial data.

## Deployment with Docker

Copy `.env.example` to `.env`, replace every placeholder secret, and start the stack:

```bash
cp .env.example .env
# edit .env and set strong passwords/secrets
docker compose up -d --build
```

The application container serves the compiled React frontend and API on the configured `PORT`. Run the database migration and seed once after the database is available:

```bash
docker compose exec app pnpm db:push
docker compose exec app pnpm db:seed
```

Place the stack behind HTTPS in production. Set `TRUST_PROXY=true` only when the reverse proxy is configured correctly, use persistent volumes for `uploads` and `audit`, and rotate the JWT and database secrets.

Rate limiting needs no extra infrastructure: sign-in attempts are counted in the `rate_limit_buckets` table under an advisory lock, so replicas share one counter rather than each keeping an in-memory one, and a successful sign-in resets that counter (see `DEPLOY.md` §2). `northline_rate_limit_shared_store_enabled` on `/metrics` tells you whether a replica is still on the shared store.

## Validation

```bash
pnpm lint
pnpm check
pnpm test
pnpm build
pnpm e2e
bash verify_phase1.sh http://localhost:3000
bash verify_phase2.sh http://localhost:3000
```

The phase scripts require a running API with a migrated and seeded database. Phase 1 verifies authentication, password redaction, invalid credentials, and admin-only user creation. Phase 2 verifies project reads, module reads, project create/update/delete, and permission-aware routing. The module-specific `server/*.rbac.test.ts` suites exercise unauthenticated requests, correct-role access, wrong-role denial, assignment scope, cookie sessions, bearer-token sessions, and password redaction. `pnpm lint` is Prettier in check mode over `server/`, `drizzle/`, `web/`, `e2e/` and the root config files.

`pnpm e2e` is the browser suite, driven by `@playwright/test`. It needs `DATABASE_URL` and `JWT_SECRET` in the environment, then builds the app and starts the real server against that database on port 3099 (`E2E_PORT` overrides it). It walks the primary journey end to end — register → verify the emailed link → sign in → onboarding → first project → invite a teammate by email → accept the invitation → record attendance, an expense and a safety issue → open the billing panel and follow its refund-policy link. Nothing is mocked; the one step that reads the database instead of the UI is fetching the emailed token, because tokens are stored as `sha256(plaintext)` and cannot be recovered. The harness blanks the Resend credentials, so the suite can never place a real email call. CI runs it on every push and pull request.

## Project structure

- `server/index.ts` — standalone Express entrypoint
- `server/routes/platform.ts` — validated role-aware API routes
- `server/auth.ts` — bcrypt and JWT credential authentication
- `server/rateLimit.ts` — login throttling
- `server/audit.ts` — append-only mutation audit log
- `drizzle/schema.ts` — database schema
- `server/seed.ts` — demo users and sample project
- `web/main.tsx` — React login and role-aware dashboard
- `web/Legal.tsx` — terms, privacy, support and refund policy, at `/terms`, `/privacy`, `/support` and `/refunds`
- `e2e/` — Playwright specs for the primary journey and the harness itself (`pnpm e2e`)
- `vite.config.ts` — frontend build configuration

## Meeting demo dataset

After running the original seed, use `pnpm db:seed:demo` to add the three-project meeting dataset: Egyptian project names, varied attendance, categorized expenses, materials, assignments, and mixed-status safety issues. The demo seed is additive and idempotent for a clean database. It intentionally places the active مستشفى النور التخصصي project slightly over budget so the Finance alert is visible during a pitch.

## SaaS V1 architecture

Northline now supports a tenant boundary through the `companies` table. Every user and operational record carries a `companyId` foreign key, and protected route queries derive the company from the authenticated session rather than trusting a client-supplied company ID. Existing demo data is preserved under the migrated legacy workspace.

New accounts can be created with `POST /auth/register` or from the public landing page. Registration creates the company, makes the registering user an administrator, starts a configurable 14-day trial on the Free plan, and establishes the secure `northline_session` cookie. The onboarding flow then creates the first project and optionally adds a teammate. Workspace identity is shown in the authenticated header through `GET /company`.

Plans and subscription state are represented by the `plans` and `subscriptions` tables. The current implementation is subscription-ready but does not process payments or claim successful payment. The available seed plans are configurable database records: Free, Business, and Pro. Subscription status is available through `GET /subscription`.

Project creation, user creation, invitations, and audit access use centralized plan-limit and feature checks. The invitation flow creates a hashed, single-use token that expires after 72 hours; the invited person chooses their own password through `POST /invitations/accept`. Materials support `minimumStock` and `GET /materials/low-stock`. Payment processing, managed object storage, and advanced reporting remain planned integrations rather than fake in-app successes; transactional email is implemented through Resend (see [Email delivery](#email-delivery)).

Audit mutations continue to be written to the local JSONL file for operational debugging and are also persisted in the tenant-scoped `audit_logs` table. `GET /audit` reads only the authenticated administrator's company records. For horizontally scaled production deployment, replace the local audit file and the in-memory rate-limit *fallback* with managed shared services.

## SaaS validation

The regression suite includes signup, company workspace access, tenant-filtered project listing, direct cross-company project IDOR protection, malformed input redaction, invitation validation, and rate-limit behavior. `vitest.config.ts` sets `NODE_ENV=test` so importing the Express app never binds the production port. The database must be migrated **and seeded**, since a large share of the suite authenticates as the seeded demo accounts:

```bash
pnpm db:push
pnpm db:seed
DATABASE_URL=mysql://... JWT_SECRET=... pnpm test
```

The database must be migrated before integration tests. `GET /health` reports application and database status. The backup and restore procedure is documented in [`BACKUP-RESTORE.md`](./BACKUP-RESTORE.md), and the executable backup script is [`scripts/backup-db.sh`](./scripts/backup-db.sh).

## Email delivery

Email verification, password reset and workspace invitations are sent through Resend's HTTP API by `server/email.ts` — no SDK, no SMTP library. `RESEND_API_KEY` and `EMAIL_FROM` are read from the environment on the server only; the key is sent as an `Authorization` header, never appears in a response body, a log record or the frontend bundle, and `.env.example` carries placeholders only.

Every link Northline emails points at one of three client-side routes — `/verify-email`, `/reset-password`, `/accept-invitation` — which `server/index.ts` answers with the application shell.

**Resend requires a verified sending domain.** Until one is added at [resend.com/domains](https://resend.com/domains), `EMAIL_FROM` on an unverified domain is rejected with `403 … domain is not verified` and no email leaves the system; the app records `northline_email_sends_total{result="failed"}` and returns `emailDelivered: false` rather than failing the request. Resend's only domain-free sender is its own test address `onboarding@resend.dev`, which can deliver to your own Resend account address alone — it is documented here but deliberately never used as a default. See [`DEPLOY.md` §7](./DEPLOY.md) for the full limitation and the end-to-end check.

## Observability

Every log record is a single line of JSON on stdout with a `requestId` that matches the `X-Request-ID` response header, and both keys and values are redacted for secrets. `GET /metrics` serves Prometheus text exposition (error rate, p95 latency, database pool, readiness failures, rate-limiter health); outside production it is open, and in production it requires a bearer `METRICS_TOKEN`. Unhandled errors are recorded locally and, when `SENTRY_DSN` is set, forwarded to Sentry without adding any dependency. `GET /_observability/probe` throws a deliberate error so a deployment can be verified end to end. Full reference in [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md).
