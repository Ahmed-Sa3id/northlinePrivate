# Stripe webhook implementation notes

Source: https://docs.stripe.com/webhooks

Stripe requires the raw request body for signature verification. The webhook endpoint must verify the `Stripe-Signature` header with the endpoint secret before acting. Stripe recommends logging processed event IDs and ignoring duplicates. Required subscription integrations should process only needed event types, and webhook handling should be designed for retries and asynchronous processing at scale. The Northline adapter preserves raw request bytes, verifies signatures through the official Stripe SDK, stores provider event IDs under a unique constraint, and returns a duplicate acknowledgment without reprocessing.
