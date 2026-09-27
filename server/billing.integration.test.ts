import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { billingEvents, companies, subscriptions } from "../drizzle/schema";
import { getDb } from "./db";
import { app } from "./index";

const webhookSecret = "whsec_test_northline_part3";

function signed(payload: string) {
  return Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: webhookSecret,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_PLAN_FREE;
  delete process.env.STRIPE_PRICE_PLAN_BUSINESS;
});

describe("Stripe billing synchronization", () => {
  it("synchronizes a signed subscription event, handles payment failure, and ignores duplicates", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRICE_PLAN_FREE = "price_free_test";
    process.env.STRIPE_PRICE_PLAN_BUSINESS = "price_business_test";
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const companyId = randomUUID();
    const subscriptionId = randomUUID();
    const customerId = `cus_${companyId.replaceAll("-", "")}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Billing Integration Company",
      email: `billing-${companyId}@example.test`,
      phone: null,
      logo: null,
      status: "active",
    });
    await db.insert(subscriptions).values({
      id: subscriptionId,
      companyId,
      planId: "plan-free",
      status: "trialing",
      providerCustomerId: customerId,
      trialStartsAt: new Date(),
      trialEndsAt: new Date(Date.now() + 86_400_000),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 2_592_000_000),
    });
    const payload = JSON.stringify({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_test_northline",
          object: "subscription",
          customer: customerId,
          status: "active",
          metadata: { companyId, planId: "plan-business" },
          cancel_at_period_end: false,
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
          items: { data: [{ price: { id: "price_business_test" } }] },
        },
      },
    });
    const first = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", signed(payload))
      .set("content-type", "application/json")
      .send(payload);
    expect(first.status).toBe(200);
    const synced = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.companyId, companyId))
      .limit(1);
    expect(synced[0].status).toBe("active");
    expect(synced[0].planId).toBe("plan-business");
    expect(synced[0].providerCustomerId).toBe(customerId);
    const duplicate = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", signed(payload))
      .set("content-type", "application/json")
      .send(payload);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);

    const failedPayload = JSON.stringify({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_test_northline",
          object: "invoice",
          customer: customerId,
          subscription: "sub_test_northline",
        },
      },
    });
    const failed = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", signed(failedPayload))
      .set("content-type", "application/json")
      .send(failedPayload);
    expect(failed.status).toBe(200);
    const pastDue = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.companyId, companyId))
      .limit(1);
    expect(pastDue[0].status).toBe("past_due");
  });

  it("reclaims stale webhook processing and rejects mismatched ownership", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRICE_PLAN_FREE = "price_free_test";
    process.env.STRIPE_PRICE_PLAN_BUSINESS = "price_business_test";
    const db = await getDb();
    if (!db) throw new Error("DATABASE_URL is required");
    const companyId = randomUUID();
    const subscriptionId = randomUUID();
    const customerId = `cus_${companyId.replaceAll("-", "")}`;
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Webhook Ownership Company",
      email: `ownership-${companyId}@example.test`,
      phone: null,
      logo: null,
      status: "active",
    });
    await db.insert(subscriptions).values({
      id: subscriptionId,
      companyId,
      planId: "plan-free",
      status: "trialing",
      providerCustomerId: customerId,
      providerSubscriptionId: "sub_owned",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_owned",
          object: "subscription",
          customer: customerId,
          status: "active",
          metadata: { companyId, planId: "plan-business" },
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
          items: { data: [{ price: { id: "price_business_test" } }] },
        },
      },
    });
    await db.insert(billingEvents).values({
      provider: "stripe",
      providerEventId: eventId,
      eventType: "customer.subscription.updated",
      payload,
      processingAt: new Date(Date.now() - 10 * 60 * 1000),
      failedAt: new Date(),
      lastError: "simulated processing failure",
    });
    const retry = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", signed(payload))
      .set("content-type", "application/json")
      .send(payload);
    expect(retry.status).toBe(200);
    const processed = await db
      .select({ processedAt: billingEvents.processedAt })
      .from(billingEvents)
      .where(eq(billingEvents.providerEventId, eventId))
      .limit(1);
    expect(processed[0].processedAt).toBeTruthy();

    const mismatchPayload = JSON.stringify({
      id: `evt_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_other",
          object: "subscription",
          customer: customerId,
          status: "active",
          metadata: { companyId, planId: "plan-business" },
          items: { data: [{ price: { id: "price_business_test" } }] },
        },
      },
    });
    const mismatch = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", signed(mismatchPayload))
      .set("content-type", "application/json")
      .send(mismatchPayload);
    expect(mismatch.status).toBe(200);
    expect(mismatch.body.ignored).toBe(true);
    const unchanged = await db
      .select({ providerSubscriptionId: subscriptions.providerSubscriptionId })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1);
    expect(unchanged[0].providerSubscriptionId).toBe("sub_owned");
  });
});
