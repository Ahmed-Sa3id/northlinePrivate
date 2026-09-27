# Northline SaaS Launch Audit

## Scope

This audit follows the production launch brief supplied with the project. The canonical source is the structured Northline repository containing `server/`, `drizzle/`, `web/`, migrations, Docker, Railway, and CI configuration.

## Current state

Northline is a single-process Express/React/Drizzle/MariaDB construction SaaS foundation with companies, users, RBAC, projects, attendance, materials, expenses, issues, assignments, invitations, plans, subscriptions, trial creation, tenant-scoped audit logs, rate limiting, onboarding, and health endpoints.

The canonical source has a reproducible package layout, a lockfile, a consistent `server/index.ts → dist-server/index.js → Docker` production path, request IDs, `/health`, `/livez`, `/readyz`, a Prettier lint gate, and a GitHub Actions verification workflow.

## Authentication and session status

Passwords use bcrypt. Browser cookies are HttpOnly, SameSite Lax, and Secure in production. Browser cookies use hashed, database-backed opaque sessions with expiration, last-used tracking, individual revocation, logout-all revocation, and logout revocation. Bearer JWTs remain available for explicit non-browser API compatibility, use allow-listed HS256 verification, carry no trusted role claim, and expire after a short configured lifetime. Browser logout revokes browser sessions but does not retroactively revoke an already-issued stateless bearer token; bearer invalidation occurs through expiration or secret rotation.

Email verification, password reset, password change, logout-all-sessions, and transactional email foundation behavior are implemented. Real provider delivery still requires staging credentials and delivery verification.

## Tenant and authorization status

Company identity is derived from the authenticated user and operational list/direct-resource queries are company-scoped. The schema contains company foreign keys, composite tenant identity keys, and composite foreign keys binding project assignments, attendance, materials, material transactions, expenses, and issues to the same company as their referenced resources. A clean two-company symmetric tenant attack matrix passes for reads, direct mutations, relationship injection, list filtering, and mass assignment.

## Database and migrations

The canonical repository includes the complete numbered migration chain through `0010_business_audit_feature.sql`. A fresh MariaDB database was created, all 10 migrations were applied from zero, the canonical seed was applied, and the complete test suite passed. Database-backed rate limiting and company/resource plan-limit operations use MariaDB advisory locks for serialized decisions. The process-local rate-limit fallback is limited to development or database-unavailable operation and is not a distributed multi-instance production guarantee.

## Billing and subscriptions

Plans, trial subscriptions, feature checks, usage checks, and a Stripe adapter exist. The adapter provides server-created checkout and portal sessions, signed webhook parsing, lifecycle status mapping, and an idempotent provider-event ledger. Real Stripe test-mode delivery, payment failure, cancellation, renewal, and customer billing UX remain staging/public-launch gates.

## Invitations

Invitation tokens are cryptographically random, hashed at rest, expiring, company-associated, and single-use. Acceptance claims the invitation atomically with `acceptedAt IS NULL` inside a transaction before creating the user. A concurrent losing request receives an invalid-invitation response and does not create a second user.

## File storage

Local storage is available for development and issue uploads are size-limited and MIME-filtered. Production object storage, signed access, content-signature inspection, and malware scanning still require staging/production operational verification. Authenticated download authorization and cross-tenant file protection are implemented and covered by security checks.

## Observability and backups

Request IDs, health/readiness endpoints, redacted audit logging, Docker/Compose healthchecks, and backup checksum validation exist. Structured monitoring, error tracking integration, scheduled production backup execution, and a completed restore drill remain public-launch operational gates.

## Testing and CI

Typecheck, lint, production build, migration consistency, existing security/RBAC/tenant tests, expanded tenant isolation tests, JWT lifecycle tests, malicious-input tests, and concurrency tests pass. Final verification is **38/38 tests across 14 files**, including the clean-database two-company matrix and simultaneous rate/project/user-limit cases. Docker runtime and browser E2E remain separate launch gates because Docker is unavailable in this sandbox and browser journeys are not part of Part 1.

## Part 1 closure

**PART 1 — COMPLETE.** Tenant integrity, composite tenant foreign keys, concurrency testing, clean-database testing, JWT/session behavior, and rate-limit behavior are complete and documented. Remaining items are external provider, staging, browser, recovery, observability, and customer-facing public-launch gates; they are not Part 1 security blockers.
