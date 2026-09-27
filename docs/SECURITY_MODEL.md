# Northline Security Model

## Authentication and sessions

Passwords are validated with the shared 12–128 character policy and hashed with bcrypt at cost factor 12. Registration creates an unverified account and sends a verification email; it does not issue an authenticated browser session or bearer token. Login rejects unverified accounts. Protected platform routes require `emailVerifiedAt`.

Browser authentication uses random opaque session identifiers whose SHA-256 hashes are stored in MariaDB. Browser sessions expire, track last use, can be revoked individually, and can be revoked across all devices. Cookies are HttpOnly, SameSite Lax, Secure in production, and scoped to the root path. Active-session listing excludes expired and revoked sessions.

Bearer JWTs remain available for explicit API compatibility, carry only authentication type and user UUID, use an allow-listed HS256 algorithm, and expire after a short configured lifetime. Roles are always loaded from the current database user rather than trusted from token claims. Browser logout and logout-all revoke browser sessions; they do not retroactively revoke an already-issued stateless bearer JWT. Bearer invalidation occurs through expiry or secret rotation.

## Account lifecycle

Email-verification and password-reset tokens are random, hashed at rest, time-limited, and one-time use. Verification consumption and account verification occur atomically. Resending verification invalidates prior unconsumed verification tokens. Forgot-password always returns a generic response and does not reveal whether an address exists. Reset-token consumption and password replacement occur atomically; successful reset revokes all browser sessions.

Password changes require the current password and the shared password policy. The current browser session remains active while all other browser sessions are revoked. The old password stops working after the update. Authentication emails use the existing provider abstraction; production requires `RESEND_API_KEY` and `EMAIL_FROM`. Development/test mode logs only recipient and subject metadata and does not claim delivery.

## RBAC and tenant isolation

The server derives the current user from the authenticated session or bearer token. Company identity, role, subscription state, and resource ownership are never accepted from the browser as authorization facts. Route guards check authentication, verification state, company status, role, and resource ownership. Direct resource lookups include the authenticated company ID. The clean two-company attack matrix verifies symmetric read, mutation, relationship-injection, and mass-assignment boundaries.

## Database integrity

Company foreign keys exist on operational resources. Composite tenant identity keys and foreign keys bind project assignments, attendance, materials, material transactions, expenses, and issues to the same company as their referenced project, material, or user. The schema evolves through numbered Drizzle migrations, including `0009_tenant_integrity.sql` and `0010_business_audit_feature.sql`. The migration chain has been applied from zero to a clean MariaDB database.

## Concurrency and limits

Database-backed rate-limit buckets serialize per-key decisions with MariaDB advisory locks. Project and user plan-limit checks serialize the count-and-insert operation under company/resource advisory locks. Authentication token consumption uses conditional single-use updates inside transactions, so concurrent verification or reset requests cannot successfully consume the same token twice. Clean integration tests exercise simultaneous requests and verify persisted limits and token replay behavior.

## CSRF and request security

Requests carrying an Origin validate it against the request origin or `ALLOWED_ORIGINS`; unknown origins are rejected rather than relying only on mutation checks. JSON and URL-encoded bodies have size limits. Security headers include `nosniff`, frame denial, strict referrer policy, a restrictive permissions policy, CSP, and HSTS in production. Rate limits protect registration, login, password recovery, password reset, email verification, verification resend, and invitation acceptance.

## File security

Public `/uploads` serving is disabled. Files are delivered through an authenticated route that checks the issue record's company and project authorization. Storage keys are normalized and traversal attempts are rejected. Production storage uses an S3-compatible provider. Browser MIME claims are not sufficient for a production file-inspection pipeline; content-signature inspection and malware scanning should be added before broad file support.

## Audit logging

Mutating requests write redacted operational JSONL entries and tenant-scoped database audit records. Audit metadata contains route, method, and status rather than secrets. Future platform-level administration must use separate privileged identities and audit every action.

## Secrets and limitations

Secrets come from environment configuration and are not committed. Production startup fails when required database, session, email, or S3 settings are absent. Remaining launch risks include real provider delivery, backup restore evidence, structured observability, browser end-to-end coverage, and operational/legal launch requirements. These are staging/public-launch gates, not unresolved Part 2 authentication defects.
