# Northline SaaS MVP Progress

## Completed

- Phase 1 technical audit documented in `AUDIT.md`.
- Added `companies`, `plans`, `subscriptions`, database-backed `audit_logs`, `invitations`, and shared `rate_limit_buckets` tables.
- Added tenant ownership to users, projects, assignments, attendance, materials, material transactions, expenses, and issues.
- Added backward-compatible migration with legacy data backfill, foreign keys, indexes, seed plans, and a 14-day trial subscription.
- Added server-derived company authorization checks and tenant-scoped resource queries.
- Added company registration with bcrypt password hashing, owner/admin role, HttpOnly session cookie, and Free-plan trial.
- Added company workspace and first-project onboarding APIs.
- Added public SaaS landing page, signup flow, workspace identity, and onboarding UI.
- Added secure, hashed, expiring invitations with acceptance and optional project assignment.
- Added centralized project/user limits and plan feature checks.
- Added minimum-stock inventory fields and a tenant-scoped low-stock endpoint.
- Added tenant-aware database audit logging while preserving local operational JSONL logging.
- Added database-aware `/health` response.
- Added database-backed shared rate limiting with an outage fallback.
- Added deterministic security regression tests and fixed the test script so it never binds the application port.
- Added documented backup/restore procedure and an executable MariaDB backup script.
- Docker/Railway deployment structure remains intact and production build succeeds.

## Validation

- TypeScript check passing after the hardening changes.
- Additive migrations generated through `0005_careless_tyger_tiger.sql`.
- Production frontend and bundled API build previously passing; rerun after final changes.
- Existing full integration suite remains blocked in this sandbox because the configured database belongs to a different WebDev scaffold and contains only its baseline `users` table. Do not force Northline migrations onto that incompatible shared database.

## Remaining pilot / infrastructure work

- Provision a clean Northline MariaDB database and apply migrations `0000` through the latest migration before integration testing.
- Add transactional email delivery for invitation tokens; the API currently returns the one-time token for controlled pilot use.
- Move uploaded issue images and operational audit files to managed object storage/logging for horizontally scaled production.
- Add browser/E2E tests with a dedicated browser runner.
- Add broader automated security fuzzing and a clean two-company end-to-end isolation matrix.
- Run Docker build/startup and a backup restore drill in an environment with Docker and MariaDB available.
- Add configurable reporting and advanced project photo galleries.
- Integrate a real payment provider only after pilot validation; no fake payment success exists.
