# Northline Part 3 — Payments & Subscriptions

## Status

**PART 3 — COMPLETE after correction/hardening pass.** Part 4 and all later parts were not started.

## Scope and implementation

The existing React, Express, MariaDB, Drizzle, authentication, sessions, RBAC, audit logging, and tenant-isolation architecture was preserved. Part 3 adds the production billing foundation in `server/billing.ts`, billing routes and Stripe webhooks in `server/routes/platform.ts`, subscription lifecycle fields in `drizzle/schema.ts`, migrations `drizzle/0011_subscription_lifecycle.sql` and `drizzle/0012_billing_hardening.sql`, and the workspace Billing panel in `web/Billing.tsx`.

The server resolves billing from the authenticated session to the current company, then to the local subscription and Stripe customer. Browser-supplied `companyId`, subscription IDs, customer IDs, and arbitrary Stripe price IDs are not trusted. Northline plan keys map to Stripe prices on the server. Checkout and Customer Portal actions require authentication and the existing billing authorization role.

The correction pass adds a distributed MariaDB company lock and durable Checkout reservation. Companies with an active, trialing, incomplete, past-due, unpaid, paused, or period-end-canceling Stripe subscription are routed to the Customer Portal rather than a second Checkout Session. The legacy seeded `plan-pro` row is retained for compatibility but is migration-safely marked unavailable and is not customer-facing.

## Subscription and payment behavior

The local database is the authoritative application representation. Subscription records include plan, status, trial dates, billing-period dates, Stripe identifiers, cancellation state, and timestamps. The adapter normalizes Stripe lifecycle state, including trialing, active, past-due, canceled, incomplete, incomplete-expired, and unpaid states where returned by the configured integration.

Failed payments synchronize local state without deleting company data. Period-end cancellation retains the trusted period end and cancellation marker. Downgrades do not delete existing data; server-side mutation limits block additional usage above the new plan until the company upgrades or reduces usage. Trials are represented by server-side timestamps and cannot be extended by the browser.

## Webhooks and idempotency

The webhook endpoint uses the raw Stripe request body and requires a valid `Stripe-Signature` verified with `STRIPE_WEBHOOK_SECRET`. It handles the implemented checkout, subscription, and invoice payment lifecycle events, including `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed` where applicable. Persistent billing-event claims are marked successful only after business effects complete; failed or stale claims remain retryable, while successfully processed duplicates are ignored. Customer, subscription, and company ownership relationships are validated before synchronization.

## Security

Billing endpoints enforce authentication, tenant isolation, role authorization, input validation, safe error responses, and server-side plan limits. Existing concurrency-safe limit enforcement remains intact. Billing secrets and internal credentials are never returned to the frontend. Structured billing logs include safe correlation identifiers and do not log secrets or payment credentials.

The production/shared rate-limit mechanism is database-backed. The process-local fallback is only an availability fallback and is **not a distributed multi-instance guarantee**. A minimal compatibility fix made during final verification scopes authentication rate-limit buckets by route and uses a reset-token discriminator, preventing unrelated endpoints and independent reset flows from exhausting one another's bucket.

## Database and configuration

Migrations `0011_subscription_lifecycle.sql` and `0012_billing_hardening.sql` were applied successfully to the local MariaDB verification database; `drizzle-kit check` also passed. The correction migration adds webhook processing/failure fields, checkout reservation fields, and `plans.isAvailable`, then deactivates legacy `plan-pro`. `.env.example`, `docs/BILLING.md`, `docs/STRIPE_SETUP.md`, and `docs/STRIPE_WEBHOOK_NOTES.md` document plans, limits, trial behavior, Stripe test mode, required environment variables, webhook forwarding, checkout, portal access, lifecycle states, payment failures, cancellation, downgrade behavior, and troubleshooting.

Stripe keys and price IDs remain environment configuration. Test mode uses separate test credentials and test webhook secrets. No real credentials are included in the source archive.

## Verification results

All checks below were executed against the local MariaDB test database:

| Check                                         | Result                                           |
| --------------------------------------------- | ------------------------------------------------ |
| TypeScript (`pnpm check`)                     | Passed                                           |
| Formatting/lint (`pnpm lint`)                 | Passed                                           |
| Full Vitest suite                             | **49/49 tests passed across 17 files**           |
| Billing unit, security, and integration tests | Passed                                           |
| Tenant-isolation and RBAC tests               | Passed                                           |
| Concurrency tests                             | Passed                                           |
| Authentication lifecycle regression tests     | Passed                                           |
| Production build (`pnpm build`)               | Passed; Vite client and bundled server generated |

The initially flaky billing fixture and session selection were made deterministic without weakening assertions. The reset-password replay regression was stabilized by the route-scoped rate-limit correction. New correction-pass coverage verifies stale webhook reclaim, ownership mismatch handling, and checkout disposition policy.

## Known issues and deferred scope

No known critical billing or security blocker remains within Part 3. Production deployment still requires valid operator-supplied Stripe credentials, configured price IDs, an HTTPS webhook endpoint, and normal Stripe Dashboard configuration. These are deployment inputs, not source-code blockers.

Email/invitations, storage/data protection, monitoring/backup operations, the Customer APP redesign, and the final production gate are intentionally deferred to later parts.

## Final declaration

**PART 3 — COMPLETE.** The source tree at `/home/ubuntu/northline-final` was verified from actual source and tests. The accompanying archive contains this corrected Part 3 state and excludes secrets, `node_modules`, build output, caches, logs, and temporary files.

Awaiting instructions before starting Part 4.

_Correction-pass verification run and archive finalization: 2026-09-25._
