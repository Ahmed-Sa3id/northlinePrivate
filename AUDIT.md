# Northline SaaS Transformation — Phase 1 Audit

**Audit scope:** Read-only inspection of the existing Northline repository before the multi-tenant SaaS transformation. No application code, schema, authentication, RBAC, or deployment behavior was modified during this audit.

## Current architecture

Northline is a single-process TypeScript monolith. The backend uses Express, Drizzle ORM, MariaDB/MySQL, Zod, bcrypt, jose JWTs, Multer, and a Vite-built React frontend. `server/index.ts` creates the Express app, applies security headers and JSON/form middleware, serves `/uploads` and `dist/web`, registers the platform routes, and exposes `GET /health`. Production is bundled with esbuild into `dist-server/index.js`; the Docker image runs that bundle. The frontend is a small component-based React application under `web/` and uses a shared `api()` wrapper with `credentials: "include"`.

The deployment artifacts include Dockerfile, Docker Compose, Railway configuration, `.env.example`, and `DEPLOY.md`. The application is suitable for a well-structured-monolith SaaS V1; there are no microservices, queues, workers, or external payment integrations.

## Current features

The existing application supports credential login and logout, admin user creation/listing, project CRUD, project assignments, attendance check-in/check-out, materials, material transactions, expenses, safety issues with image upload support, a role-aware overview dashboard, an admin/audit screen, in-memory login rate limiting, and an append-only file audit log. The demo seed creates four role accounts and the additive demo seed creates three Egyptian projects plus attendance, expenses, materials, assignments, and safety issues.

The frontend has screens for Overview, Projects, Attendance, Materials, Finance, Safety Issues, and Admin & Audit. The Finance screen includes budget-versus-actual calculations and an intentional active-project overrun for demonstrations. Attendance responses now join and return `userName`, `userEmail`, and `projectName`, so the UI displays names rather than UUIDs.

## Current database

The schema contains eight tables: `users`, `projects`, `project_assignments`, `attendance`, `materials`, `material_transactions`, `expenses`, and `issues`. Existing foreign keys cover project relationships and user/material transaction relationships with a mixture of cascade and restrict behavior. The migration journal contains two migrations: the initial schema and the foreign-key migration.

The current schema has **no `companies` table, no subscription/plan tables, and no tenant/company ownership columns**. `users` are globally unique by email/openId, and projects are globally visible to admins/accountants or filtered by project assignment for supervisors/workers. Audit entries are not stored in the database and have no company field. Uploads are stored under a local filesystem directory and are not tenant-namespaced.

## Current API

The platform routes currently include:

| Area | Routes and behavior |
| --- | --- |
| Authentication | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| Users | `POST /users`, `GET /users`; admin-only |
| Audit | `GET /audit`; admin-only, reads a local JSONL file |
| Projects | `GET /projects`, `GET /projects/:id`, `POST/PATCH/DELETE /projects`; admin mutation, assignment-aware reads |
| Assignments | `GET/POST /project-assignments`, `PATCH/DELETE /project-assignments/:id`; admin mutation |
| Attendance | `GET /attendance`, `POST /attendance/check-in`, `POST /attendance/:id/check-out` |
| Materials | `GET/POST /materials`, `PATCH/DELETE /materials/:id`, `GET/POST /materials/:id/transactions` |
| Expenses | `GET/POST /expenses`, `PATCH/DELETE /expenses/:id` |
| Issues | `GET/POST /issues`, `PATCH/DELETE /issues/:id`, including multipart image upload handling |
| Health | `GET /health` |

The API has consistent error objects in many paths and uses Zod for request body and UUID validation. It does not currently have company endpoints, registration, invitations, onboarding, subscription endpoints, reports, or a public marketing route.

## Current authentication

Credential authentication uses bcrypt with cost factor 12 and an 8-hour HS256 JWT. The preferred browser session is the `northline_session` HttpOnly cookie with `SameSite=Lax` and `secure: true` in production. The API also returns the JWT and accepts `Authorization: Bearer` for non-browser clients. The frontend uses `credentials: "include"` and does not use localStorage for tokens.

Logout clears the cookie but there is no server-side token revocation or refresh-token model. Registration, password reset, email verification, invitation acceptance, account recovery, and company creation do not exist. The JWT includes a role claim, but authorization ultimately reloads the user from the database by UUID.

## Current RBAC and project authorization

Roles are `admin`, `supervisor`, `worker`, and `accountant`, plus a legacy `user` enum value. Admins have broad access; accountants can read projects and manage expenses; supervisors and workers are restricted to assigned projects; workers are further restricted to their own attendance. Backend middleware enforces role and assignment checks for the current modules, and the existing tests cover wrong-role denial and some assignment scope.

The critical limitation is that project authorization is the only isolation boundary. There is no tenant context. A future SaaS implementation must derive `companyId` from the authenticated user and add it to every relevant query; frontend filtering cannot be treated as security.

## Current tests

The repository contains seven Vitest files and 18 passing tests at the time of the audit. Supertest exercises login cookies, authentication requirements, password redaction, role denial, bearer-token compatibility, project access, and module-specific RBAC. There are no tenant-isolation tests, registration/onboarding tests, subscription tests, invitation tests, frontend tests, security-fuzz tests, cross-company IDOR tests, or backup/restore tests.

The test harness imports the Express app and requires a configured database. Running tests while a production preview already owns port 3000 can cause an `EADDRINUSE` collision because the application entrypoint listens unless `NODE_ENV=test`; isolated test runs should set `NODE_ENV=test` and/or an isolated port.

## Current deployment and operations

Docker Compose runs one app container and one MariaDB container with named volumes for database, uploads, and audit data. The Dockerfile builds the React frontend and bundled server, then runs the server on the platform-provided `PORT` with a local default of 3000. Railway configuration defines a Dockerfile build and `/health` health check. `DEPLOY.md` documents Railway MySQL variable references and migration/seed commands.

The current health endpoint reports application liveness only; it does not verify database connectivity. Errors are logged server-side and a generic 500 JSON response is returned. Rate limiting is in-memory, which is unsuitable for multiple replicas. Audit logs and uploads are local filesystem data, so production deployment requires persistent storage or later object/database-backed implementations. There is no documented automated backup/restore process yet.

## Current problems and discrepancies

1. **No multi-tenancy:** users and all operational resources are global; there is no company context or tenant middleware.
2. **No company lifecycle:** no registration, company creation, onboarding, invitations, company settings, or one-company-per-user model.
3. **No subscription architecture:** no plans, subscriptions, trial state, limits, or configurable feature entitlements.
4. **Audit storage is not SaaS-safe:** audit data is a local JSONL file without company ID, resource ID, metadata, or durable database constraints.
5. **Upload isolation is incomplete:** issue image paths are local and not company/project namespaced.
6. **Authentication lifecycle is incomplete:** cookie authentication is implemented, but there is no registration, refresh/revocation, password reset, invitation acceptance, or CSRF strategy documented for cookie mutations.
7. **API conventions are transitional:** responses are generally `{ projects: [...] }` or `{ user: ... }`, not a single consistent `{ data: ... }` contract; endpoint names are operational rather than organized under a versioned API structure.
8. **Business fields are incomplete:** issues have description but no separate title; materials lack minimum stock/current-stock fields; expenses lack description; projects lack explicit manager/progress fields; issue severity lacks `critical`.
9. **Dashboard is not tenant-aware:** metrics are calculated from the current role's global/assignment-filtered response, not from a company context.
10. **Frontend is not a public SaaS shell:** there is no public landing page, pricing page, signup flow, onboarding flow, company workspace header, settings page, or company switcher.
11. **Testing gaps:** no automated tenant-isolation, registration, onboarding, subscription, frontend, security, or backup/restore coverage.
12. **Operational gaps:** rate limiting is process-local, health does not test the database, audit/upload persistence is filesystem-based, and backup retention/restore procedures are undocumented.
13. **Documentation drift:** older README language describes the project as a single/demo construction platform and still documents bearer tokens as the primary session concept, while the actual browser implementation uses an HttpOnly cookie and also exposes bearer compatibility.
14. **Demo seed assumptions:** the demo seed is appropriate for a clean pitch database but is not a tenant-aware production seed and must not become the model for cross-company data ownership.

## Recommended implementation sequence after audit

The required next step is Phase 2: introduce `companies`, establish a one-company-per-user ownership model, add company ownership to resources where needed, add tenant-aware foreign keys and indexes, and implement a server-derived tenant context. This should be delivered with migration tests and cross-company IDOR tests before changing onboarding or UI flows.

Phase 3 should then add registration and company creation while preserving the current bcrypt and HttpOnly-cookie approach. Phase 4 should extend RBAC and project authorization under the tenant boundary. Only after those security foundations are tested should onboarding, SaaS dashboard work, landing/pricing pages, subscription architecture, production deployment hardening, and the broader QA portfolio be implemented.
