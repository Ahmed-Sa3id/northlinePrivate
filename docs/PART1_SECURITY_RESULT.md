# Northline Part 1 Security Result

## 1. Overall status

# **PART 1 — COMPLETE**

The SaaS foundation and security scope is complete. The backend security foundation, tenant boundaries, database migration chain, JWT/session behavior, malicious-input handling, and database concurrency controls were implemented and verified against a clean local MariaDB database. This completion statement covers Part 1 security and foundation scope; it is not a public-launch certification.

## 2. Verified request boundary

The request trust boundary is: **request → authentication → database-loaded user → database-loaded company → role guard → runtime validation → tenant/resource predicate → response**. Browser-supplied `companyId`, role, verification flags, and similar fields are not authorization authorities.

## 3. Security findings addressed

The implementation removes mutable role claims from bearer JWTs, fails closed on malformed cookies and malformed tokens, forwards asynchronous authorization failures through Express, rejects unknown origins, rejects wildcard production origins, rate-limits sensitive token endpoints, restricts workers to their own attendance identity, validates UUID query filters, and keeps error responses generic.

Database-level ownership invariants include composite tenant identity keys and composite foreign keys for project assignments, attendance, materials, material transactions, expenses, and issues. The migration chain includes `0009_tenant_integrity.sql`; `0010_business_audit_feature.sql` makes the canonical seeded business fixture consistent with the RBAC suite.

Database-backed rate-limit decisions serialize per key with MariaDB advisory locks. Project and user plan-limit checks serialize the count-and-insert operation with company/resource advisory locks, preventing concurrent requests from exceeding configured limits. The process-local limiter fallback is explicitly limited to development or database-unavailable operation and is not a distributed multi-instance guarantee.

## 4. Authentication and JWT behavior

Browser sessions remain opaque, database-backed, expiring, individually revocable, and revocable across all devices. Browser logout and logout-all revoke browser sessions. Bearer JWTs remain available for explicit API compatibility, carry only authentication type and user UUID, use allow-listed HS256 verification, expire after the configured short lifetime, and are rejected when malformed, expired, or signed with another algorithm. Browser logout does not retroactively revoke an already-issued stateless bearer JWT; bearer invalidation occurs through expiration or secret rotation. Password changes revoke active browser sessions.

## 5. Verification evidence

| Check | Result |
|---|---|
| TypeScript check | PASS |
| Prettier lint | PASS |
| Production build | PASS |
| Migration chain from zero | PASS — 10 migrations applied to a newly created MariaDB database |
| Existing security/RBAC/tenant suite | PASS — 29/29 tests |
| Expanded security, JWT, tenant, fuzz, and concurrency suite | PASS — 38/38 tests across 14 files |
| Two-company symmetric tenant matrix | PASS — reads, direct mutations, relationship injection, list filtering, and mass-assignment checks |
| Concurrent login rate-limit test | PASS — 25 simultaneous attempts produce bounded persisted bucket state and 429 responses |
| Concurrent project limit test | PASS — one project created under a one-project plan |
| Concurrent user limit test | PASS — two users created under a three-user plan including the owner |
| JWT lifecycle test | PASS — malformed, expired, wrong-algorithm, and browser-logout behavior |
| Malicious-input fuzz test | PASS — hostile types, oversized values, injection strings, invitation tokens, and traversal-like URLs |
| Secret-pattern scan | PASS — no committed provider-secret patterns found |
| Docker build/runtime | Not locally verified because Docker is unavailable in this sandbox |

## 6. Test files added or expanded

The final verification includes `server/tenant.matrix.integration.test.ts`, `server/concurrency.integration.test.ts`, `server/jwt.lifecycle.integration.test.ts`, and `server/security.fuzz.unit.test.ts`, in addition to the existing authentication, RBAC, tenant, billing, and security suites.

## 7. Remaining non-Part-1 launch gates

The real Resend/email, S3-compatible storage, and Stripe test-mode integrations still require staging credentials and delivery verification. Backup restore has not been drilled against a disposable target. Browser end-to-end journeys, malware/content inspection for uploaded files, structured monitoring, alerting, legal/support/cancellation pages, and Docker image execution remain outside this sandbox verification. These are staging/public-launch gates, not remaining Part 1 security blockers.

## 8. Closure

**PART 1 — COMPLETE.** No Part 1 security blocker remains from tenant integrity, composite tenant foreign keys, concurrency testing, clean-database testing, JWT/session documentation, or rate-limit documentation.
