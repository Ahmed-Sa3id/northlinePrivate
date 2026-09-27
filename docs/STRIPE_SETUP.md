# Stripe Setup for Northline Part 3

Northline uses Stripe test mode for development and staging. Configure the following values in the process environment or deployment secret manager:

```text
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PLAN_FREE=price_...
STRIPE_PRICE_PLAN_BUSINESS=price_...
APP_URL=http://localhost:3000
```

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server-only. They must never be placed in frontend code or returned by an API response. The Price IDs are also resolved server-side; clients send only `plan-free` or `plan-business`.

Create one test-mode recurring Price for each Northline plan. Configure the Stripe webhook endpoint at:

```text
https://your-host.example.com/billing/webhook
```

Enable only the events used by this integration: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Stripe CLI can forward local test events:

```bash
stripe listen --forward-to localhost:3000/billing/webhook
```

Set the signing secret printed by Stripe CLI as `STRIPE_WEBHOOK_SECRET`. Stripe signatures are verified against the raw request body, and duplicate event IDs are recorded in MariaDB before processing.

Production requires live-mode keys, live Price IDs, an HTTPS `APP_URL`, a production webhook signing secret, and the Stripe Customer Portal enabled in the Stripe Dashboard. Provider delivery, portal configuration, and live webhook retries must be verified in staging before production launch.
