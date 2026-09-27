# Northline Billing & Subscriptions

## Plans and local authority

Northline keeps the local `plans` and `subscriptions` tables as the application authority for entitlement checks. The seeded plans remain **Free** (`plan-free`, 3 users, 1 project, dashboard) and **Business** (`plan-business`, 20 users, 10 projects, operational features). The server enforces user and project limits under a MariaDB advisory lock, so concurrent requests cannot bypass limits. Downgrades do not delete data; existing records remain available, while new mutations are blocked once the lower limit is reached.

The legacy seeded `plan-pro` row is retained for migration compatibility but is marked unavailable and is not exposed by the Stripe billing flow. Pro is therefore not a customer-facing plan in Part 3.

Each company receives a 14-day trial at registration. Trial dates and subscription status are stored locally. The browser cannot change trial dates, plan IDs, status, Stripe customer IDs, or subscription IDs. Stripe webhooks update local state after signature verification.

## Subscription states

Northline supports `trialing`, `active`, `past_due`, `cancelled`, `expired`, `incomplete`, `unpaid`, and `paused`. `active` and `trialing` provide the plan’s configured features. `past_due`, `incomplete`, and `unpaid` remain visible to the company and do not grant unlimited access; server-side feature and resource limits continue to apply. `cancelled`, `expired`, and `paused` follow the existing local feature policy and never bypass plan limits. Customer data is retained after payment failure or cancellation.

A period-end cancellation is represented by `cancelAtPeriodEnd` and `canceledAt`; access remains tied to the current period until Stripe sends the final lifecycle state. Immediate cancellation is synchronized as `cancelled` or `expired` according to the Stripe event status.

## Stripe integration

The server uses the official Stripe Node SDK. Secret keys are read only from environment configuration. Checkout accepts only a Northline `planId`; the server maps that identifier to the configured Stripe Price ID. Browser-provided price IDs, company IDs, customer IDs, subscription IDs, and billing URLs are ignored or rejected. The authenticated company determines the Stripe Customer association.

Checkout creates or reuses one Stripe Customer per company, includes `companyId` and `planId` metadata on both the Checkout Session and the Stripe Subscription, and derives success/cancel URLs from `APP_URL`. A company with an active, trialing, incomplete, past-due, unpaid, paused, or period-end-canceling subscription is never sent through a second Checkout flow: the server returns a Customer Portal session instead. New companies without a managed Stripe subscription use Checkout. A distributed MariaDB lock and durable checkout reservation protect repeated and concurrent requests. The customer portal uses the locally stored Stripe customer for the authenticated company and derives its return URL from `APP_URL`. Billing management is restricted to administrators; all authenticated roles can view sanitized subscription status and plan data.

## Webhooks

`POST /billing/webhook` requires Stripe’s `Stripe-Signature` header and verifies the raw request body with `STRIPE_WEBHOOK_SECRET`. The persistent `billing_events` ledger claims events before processing, marks them successful only after business effects complete, and leaves failed events retryable. Successfully processed duplicate provider event IDs are acknowledged without reprocessing. Stripe customer, subscription, and local-company relationships are checked before state synchronization; conflicting events are ignored safely and recorded diagnostically.

The implementation handles:

| Event                           | Local behavior                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`    | Stores the company’s Stripe Customer and Subscription identifiers.                                                      |
| `customer.subscription.created` | Creates the local Stripe identity mapping and synchronizes plan, status, period, trial, price, and cancellation fields. |
| `customer.subscription.updated` | Synchronizes the same subscription state fields.                                                                        |
| `customer.subscription.deleted` | Maps the Stripe cancellation state to local cancellation/expiration behavior.                                           |
| `invoice.paid`                  | Restores the local subscription to `active` for the associated company.                                                 |
| `invoice.payment_failed`        | Marks the local subscription `past_due` without deleting customer data.                                                 |

Webhook logs contain event, company, customer, and subscription identifiers only; secrets, payment credentials, and full sensitive provider credentials are never returned to the browser. Provider errors are logged server-side with safe client messages.

## Test mode and environment configuration

Configure these values in the deployment secret manager or local shell; do not commit them:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PLAN_FREE=price_...
STRIPE_PRICE_PLAN_BUSINESS=price_...
APP_URL=https://app.example.com
```

Use Stripe test-mode keys and prices for development and staging. For local forwarding, run Stripe CLI forwarding to `/billing/webhook` and set the generated test-mode signing secret as `STRIPE_WEBHOOK_SECRET`. Production requires live-mode credentials and an HTTPS webhook endpoint. The current `.env.example` contains the shared application and Stripe variables; production billing validation requires all four Stripe values above.

## Verification and operations

The billing unit and integration tests cover server-controlled price mapping, authentication and billing authorization, tenant isolation, webhook signature failure, duplicate delivery, state synchronization, payment failure, cancellation, trial dates, downgrade-safe limits, and concurrent plan-limit enforcement. Real Stripe Checkout, portal redirects, and external webhook delivery still require a configured Stripe test account and reachable staging URL; no live payment is required for the automated suite.
