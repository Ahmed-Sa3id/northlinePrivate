# Northline Part 1 Security Matrix

## Request trust boundary

Every protected request follows the same boundary: **request → authentication → server-derived user → server-derived company → role authorization → runtime validation → tenant/resource-scoped query → response**. Company identity comes from the database user loaded through an opaque session or a verified HS256 bearer token. The role in a bearer token is not used for authorization; the current database user is authoritative.

| Area                | Read                                              | Create                           | Update                            | Delete                          | Company scope                                        |
| ------------------- | ------------------------------------------------- | -------------------------------- | --------------------------------- | ------------------------------- | ---------------------------------------------------- |
| Company             | Authenticated company members                     | Registration creates own company | Explicit company routes only      | Not exposed as a generic delete | Derived from authenticated user                      |
| Users               | Admin                                             | Admin                            | No generic over-posting route     | No generic delete route         | `users.companyId = currentUser.companyId`            |
| Projects            | Admin/accountant/all assigned roles               | Admin                            | Admin/supervisor                  | Admin                           | Direct lookup includes company predicate             |
| Project assignments | Admin/supervisor, assignment scope                | Admin                            | Admin                             | Admin                           | User and project are checked against current company |
| Attendance          | Admin/supervisor/worker, project scope            | Admin/supervisor/worker rules    | Owner/role and company predicates | No public generic delete        | Company and project authorization                    |
| Materials           | Admin/supervisor, project scope                   | Admin/supervisor                 | Admin/supervisor                  | Admin/supervisor                | Company and project authorization                    |
| Expenses            | Admin/accountant                                  | Admin/accountant                 | Admin/accountant                  | Admin/accountant                | Company and project authorization                    |
| Issues              | Admin/supervisor, project scope                   | Admin/supervisor                 | Admin/supervisor                  | Admin/supervisor                | Company and project authorization                    |
| Audit               | Admin only                                        | Server-generated                 | Not client-editable               | Not client-editable             | Tenant-scoped query                                  |
| Subscription        | Authenticated company members                     | Server registration/provider     | Provider/server only              | Not client-editable             | Tenant-scoped query                                  |
| Files               | Authenticated company members with project access | Issue upload route               | Not generic                       | Not generic                     | Issue URL and project authorization checked          |

## CSRF, CORS, and origin policy

The service does not use wildcard credentialed CORS. Requests carrying an `Origin` must match the request origin or an explicitly configured `ALLOWED_ORIGINS` value; unknown origins receive `403 ORIGIN_REJECTED`. Cookie sessions remain HttpOnly, SameSite Lax, and Secure in production. The billing webhook is provider-signed and does not rely on browser-origin authorization.

## Rate limiting

Registration, login, password recovery, email verification, and invitation acceptance use the shared limiter. **Database-backed rate-limit buckets are the production/shared mechanism** and serialize decisions per key with MariaDB advisory locks. A process-local fallback exists only for development or database-unavailable operation; it is fail-safe for a single process but **is not a distributed multi-instance production guarantee**.

## Concurrency and database ownership

Invitation acceptance uses a transaction and an atomic `acceptedAt IS NULL` claim before creating the user. Composite tenant identity keys and foreign keys bind project assignments, attendance, materials, material transactions, expenses, and issues to the same company as their referenced resources. Database-backed project and user plan-limit operations serialize count-and-insert decisions with advisory locks. Clean-database migration, tenant-isolation, and concurrency tests have passed.

## Session and JWT lifecycle

Browser sessions are opaque, database-backed, expiring, and individually or globally revocable. Browser logout and logout-all revoke browser sessions. Bearer JWTs are stateless compatibility credentials: they are verified with allow-listed HS256, contain no trusted role claim, expire after the configured short lifetime, and are rejected when malformed, expired, or signed with another algorithm. Browser logout does not retroactively revoke an already-issued bearer JWT; bearer invalidation occurs through expiration or secret rotation.

## Part 1 closure

**PART 1 — COMPLETE.** The security matrix, tenant integrity, clean-database verification, concurrency controls, and associated tests are complete. External provider delivery, browser E2E, backup restore, observability, and customer-facing launch requirements remain separate staging/public-launch gates and are not Part 1 security blockers.
