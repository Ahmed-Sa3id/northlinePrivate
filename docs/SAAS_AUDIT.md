# Northline Production SaaS Audit and Implementation Record

**Date:** 2026-09-18  
**Assessment target:** Northline construction lifecycle platform  
**Working source:** `northline-construction-platform-source.zip` (the outer `final1.zip` is a flattened export and is not independently buildable)

## Executive assessment

Northline is a well-structured TypeScript/Express/Drizzle/MariaDB and React SaaS V1 foundation. The canonical source has already implemented substantial multi-tenant hardening: company ownership on operational tables, server-derived tenant authorization, bcrypt credential hashing, HttpOnly cookie sessions, expiring hashed invitations, subscription records, plan checks, database audit logs, rate-limit buckets, onboarding APIs, and a production frontend/API bundle.

It is **not yet production-ready as a self-service SaaS**. The main blockers are a clean dedicated database and restore-tested deployment, complete account lifecycle, real billing/provider webhook integration, durable object storage, platform administration, stronger database integrity constraints, operational observability, and a clean CI/Docker/E2E verification path.

## Repository and packaging findings

The submitted outer archive contains source files at its root while its package scripts and TypeScript configuration expect `server/`, `drizzle/`, and `web/` directories. It also omits `pnpm-lock.yaml` even though the Dockerfile requires it. As a result, the outer archive is not a reproducible clean-checkout build artifact. The embedded `northline-construction-platform-source.zip` contains the coherent canonical layout, lockfile, Dockerfile, migrations, server, web, and documentation and should be treated as the source of truth for further work.

## Current architecture

The application is a single-process monolith. `server/index.ts` creates the Express application, applies request limits and security headers, serves the compiled React frontend and uploads, registers platform routes, and exposes `/health`. The frontend is built by Vite from `web/`; the API is bundled with esbuild to `dist-server/index.js`. Drizzle ORM targets MariaDB/MySQL. Authentication uses bcrypt and jose HS256 JWTs, with an HttpOnly `northline_session` cookie for browsers and bearer-token compatibility for API clients.

The data model includes companies, plans, subscriptions, users, projects, assignments, attendance, materials, material transactions, expenses, issues, invitations, audit logs, and database-backed rate-limit buckets. Most tenant-owned records have a `companyId` and foreign key to companies, while route queries derive the company from the authenticated user.

## Implemented capabilities

The canonical source currently includes credential registration and login, company creation, trial subscription creation, onboarding/first-project APIs, role-based project operations, assignment-scoped worker/supervisor access, materials and transactions, expenses, safety issues with image uploads, invitations with hashed expiring tokens, minimum-stock inventory, plan feature and usage checks, tenant audit persistence, database-aware health checks, and rate limiting with a database-backed bucket model plus fallback.

The source also contains Docker, Docker Compose, Railway configuration, migration scripts, seed scripts, backup documentation, phase smoke scripts, and focused RBAC/security/tenant tests.

## Confirmed validation baseline

| Check | Result | Notes |
| --- | --- | --- |
| TypeScript check | Passed | `npm run check` completed with exit code 0 in the canonical source. |
| Production build | Passed | Vite frontend and esbuild server bundle completed with exit code 0. |
| Correct Vitest invocation | Executed | `npm test` ran 9 test files. |
| Tests | 7 passed, 16 failed | The integration suite requires a migrated, dedicated Northline MariaDB. The sandbox database is absent/incompatible, producing login 401s and registration/tenant 503s. |
| Docker build/start | Not verified | Docker/MariaDB runtime is not available in the current validation environment. |
| Migration-from-empty-db | Not verified | Requires a clean MariaDB instance. |
| Backup/restore drill | Not verified | Requires MariaDB client/server and isolated restore target. |

The earlier test attempt with `--runInBand` was invalid because that flag belongs to Jest, not Vitest. The correctly invoked Vitest run is the result recorded above.

## Security assessment

### Strengths

Passwords are hashed with bcrypt cost 12 and password hashes are removed from public user objects. Browser sessions use HttpOnly cookies with SameSite Lax and production Secure behavior. Zod validates request bodies and UUID route parameters. Role and assignment checks are performed server-side. Company context is derived from the authenticated user instead of trusted client input. Invitation tokens are stored as SHA-256 hashes and have expiration and accepted state. Request size limits, upload size limits, and basic security headers are present.

### Risks and remaining hardening

Bearer tokens are still returned by some credential endpoints, which is useful for API clients but unnecessary exposure for browser JavaScript; browser flows should rely on cookies and the API should document the distinction. Logout clears the cookie but there is no general server-side revocation/session table, so already-issued bearer tokens remain valid until expiry. Cookie-based mutating requests need an explicit CSRF strategy or a strict same-origin deployment policy with tests. Upload validation currently relies heavily on MIME filtering; actual content-signature validation and controlled object access remain incomplete. Error logging must be reviewed to guarantee tokens, invitation secrets, connection strings, and personal data are never emitted.

### Tenant integrity

Application-level tenant filters are substantially present. The schema still deserves composite relationship constraints or transactional validation for cross-company combinations such as a Company A assignment pointing to a Company B user/project. Cross-company direct-ID tests must run against a clean database, not only mocked or unavailable-database paths.

## Missing or incomplete SaaS lifecycle

Email verification and password recovery are not complete. Password change and session invalidation need explicit flows. Invitations are hashed and expiring, but transactional single-use concurrency behavior needs a dedicated concurrent acceptance test and delivery integration. Subscription records and feature checks exist, but there is no authoritative payment provider, checkout, webhook verification/idempotency, cancellation, plan-change, or payment-failure lifecycle. Platform administration is not clearly separated from company administration. Local uploads and JSONL audit files are not horizontally scalable production sources of truth. Structured logging, request IDs, metrics, error tracking, staging configuration, and CI/CD gates require completion.

## Recommended implementation order

1. Preserve the canonical repository layout in the deliverable and remove or clearly exclude nested backup archives from the production source package.
2. Add CI with install, lint/format check, typecheck, unit tests, integration tests against a disposable MariaDB service, production build, and Docker build.
3. Provision a clean MariaDB test service and verify migrations from an empty database, seed behavior, rollback expectations, and all integration tests.
4. Add a session/revocation model, email verification, password reset, password change, logout auditing, and a documented CSRF strategy.
5. Complete tenant database integrity and concurrent invitation acceptance tests.
6. Make plan limits concurrency-safe through transactions/locking and add usage accounting where storage limits are introduced.
7. Introduce a provider-neutral billing service and verified, idempotent webhook endpoint. Keep provider credentials optional and never fabricate payment success.
8. Finish self-service onboarding, company settings, subscription/billing UX, usage indicators, and platform-admin separation.
9. Replace local upload/audit sources with managed object/log storage adapters while retaining local development adapters.
10. Add request IDs, structured redacted logs, readiness checks, metrics, error tracking hooks, scheduled backups, and a tested restore drill.
11. Add browser E2E, file-signature, cross-tenant IDOR, concurrency, billing, and Docker smoke tests.
12. Update README, architecture, security, deployment, billing, testing, and operations documentation so each claim matches verified behavior.

## Readiness estimate

**Current SaaS readiness: approximately 60% for an internal/pilot MVP; approximately 35–40% for the full production checklist in `promptcheck.txt`.** The estimate is intentionally conservative because billing, email, restore testing, object storage, platform administration, and clean-environment verification are not complete.

## Completion policy

No phase should be marked complete until its migration (where applicable), automated tests, deployment implications, and documentation are updated. Any missing provider credentials or infrastructure must be recorded as an explicit limitation and represented by a tested adapter/mock path rather than a claimed production integration.
