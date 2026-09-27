import { afterEach, describe, expect, it } from "vitest";
import {
  billingConfigured,
  classifyCheckout,
  createCheckoutSession,
  getBillingPriceId,
  mapStripeStatus,
} from "./billing";

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_PLAN_FREE;
  delete process.env.STRIPE_PRICE_PLAN_BUSINESS;
});

describe("billing adapter", () => {
  it("does not claim billing is configured without both provider secrets", () => {
    expect(billingConfigured()).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    expect(billingConfigured()).toBe(false);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_example";
    process.env.STRIPE_PRICE_PLAN_FREE = "price_free_test";
    process.env.STRIPE_PRICE_PLAN_BUSINESS = "price_business_test";
    expect(billingConfigured()).toBe(true);
  });

  it("maps provider lifecycle states to Northline states", () => {
    expect(mapStripeStatus("trialing")).toBe("trialing");
    expect(mapStripeStatus("active")).toBe("active");
    expect(mapStripeStatus("past_due")).toBe("past_due");
    expect(mapStripeStatus("canceled")).toBe("cancelled");
    expect(mapStripeStatus("incomplete_expired")).toBe("expired");
    expect(mapStripeStatus("incomplete")).toBe("incomplete");
    expect(mapStripeStatus("unpaid")).toBe("unpaid");
    expect(mapStripeStatus("paused")).toBe("paused");
  });

  it("maps only known Northline plans to server-side price configuration", () => {
    process.env.STRIPE_PRICE_PLAN_BUSINESS = "price_business_test";
    expect(getBillingPriceId("plan-business")).toBe("price_business_test");
    expect(() => getBillingPriceId("price_attacker_supplied")).toThrow(
      "Unsupported Northline billing plan",
    );
    expect(() => getBillingPriceId("plan-free")).toThrow("not configured");
  });

  it("fails closed instead of fabricating checkout when the provider is absent", async () => {
    await expect(
      createCheckoutSession({
        companyId: "company",
        companyName: "Example Company",
        companyEmail: "owner@example.com",
        planId: "plan-business",
        successUrl: "https://app.example/success",
        cancelUrl: "https://app.example/cancel",
      }),
    ).rejects.toThrow("not configured");
  });

  it("routes existing and concurrent checkout attempts away from new subscriptions", () => {
    expect(
      classifyCheckout({
        status: "trialing",
        providerSubscriptionId: "sub_trial",
      }),
    ).toBe("existing");
    expect(
      classifyCheckout({
        status: "active",
        providerSubscriptionId: "sub_active",
      }),
    ).toBe("existing");
    expect(
      classifyCheckout({
        status: "expired",
        providerCheckoutCreatedAt: new Date(1_000),
        now: 2_000,
      }),
    ).toBe("in_progress");
    expect(
      classifyCheckout({
        status: "expired",
        providerCheckoutCreatedAt: new Date(1_000),
        now: 10 * 60 * 1000 + 2_000,
      }),
    ).toBe("new");
    expect(classifyCheckout({ status: "expired" })).toBe("new");
  });
});
