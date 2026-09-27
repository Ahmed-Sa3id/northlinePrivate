import Stripe from "stripe";
import { logger } from "./_core/logger";

export type BillingStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled"
  | "expired"
  | "incomplete"
  | "unpaid"
  | "paused";

const PLAN_IDS = ["plan-free", "plan-business"] as const;
export type BillingPlanId = (typeof PLAN_IDS)[number];

export type CheckoutDisposition = "new" | "existing" | "in_progress";

export function classifyCheckout(input: {
  providerSubscriptionId?: string | null;
  status: BillingStatus;
  cancelAtPeriodEnd?: boolean;
  providerCheckoutCreatedAt?: Date | null;
  now?: number;
}): CheckoutDisposition {
  const managedStatuses = new Set<BillingStatus>([
    "trialing",
    "active",
    "past_due",
    "incomplete",
    "unpaid",
    "paused",
  ]);
  if (
    input.providerSubscriptionId &&
    (managedStatuses.has(input.status) || input.cancelAtPeriodEnd)
  )
    return "existing";
  if (
    input.providerCheckoutCreatedAt &&
    (input.now ?? Date.now()) - input.providerCheckoutCreatedAt.getTime() <
      10 * 60 * 1000
  )
    return "in_progress";
  return "new";
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2025-08-27.basil" });
}

export function billingConfigured() {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_WEBHOOK_SECRET &&
    process.env.STRIPE_PRICE_PLAN_FREE &&
    process.env.STRIPE_PRICE_PLAN_BUSINESS,
  );
}

export function billingPlanIds() {
  return PLAN_IDS;
}

export function getBillingPriceId(planId: string) {
  if (!PLAN_IDS.includes(planId as BillingPlanId))
    throw new Error("Unsupported Northline billing plan");
  const envName =
    planId === "plan-free"
      ? "STRIPE_PRICE_PLAN_FREE"
      : "STRIPE_PRICE_PLAN_BUSINESS";
  const priceId = process.env[envName];
  if (!priceId)
    throw new Error(`Billing price is not configured for ${planId}`);
  return priceId;
}

export async function ensureStripeCustomer(input: {
  customerId?: string | null;
  companyId: string;
  companyName: string;
  companyEmail: string;
}) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Billing provider is not configured");
  if (input.customerId) return input.customerId;
  const customer = await stripe.customers.create({
    name: input.companyName,
    email: input.companyEmail,
    metadata: { companyId: input.companyId },
  });
  return customer.id;
}

export async function createCheckoutSession(input: {
  companyId: string;
  companyName: string;
  companyEmail: string;
  customerId?: string | null;
  planId: BillingPlanId;
  successUrl: string;
  cancelUrl: string;
}) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Billing provider is not configured");
  const customerId = await ensureStripeCustomer(input);
  const priceId = getBillingPriceId(input.planId);
  return {
    customerId,
    session: await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.companyId,
      metadata: { companyId: input.companyId, planId: input.planId },
      subscription_data: {
        metadata: { companyId: input.companyId, planId: input.planId },
      },
    }),
  };
}

export async function createBillingPortalSession(
  customerId: string,
  returnUrl: string,
) {
  const stripe = getStripe();
  if (!stripe) throw new Error("Billing provider is not configured");
  return stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
}

export function parseSignedWebhook(
  rawBody: Buffer,
  signature: string | undefined,
) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret || !signature)
    throw new Error("Billing webhook is not configured");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export function mapStripeStatus(
  status: Stripe.Subscription.Status | string,
): BillingStatus {
  if (status === "trialing") return "trialing";
  if (status === "active") return "active";
  if (status === "past_due") return "past_due";
  if (status === "unpaid") return "unpaid";
  if (status === "incomplete") return "incomplete";
  if (status === "paused") return "paused";
  if (status === "canceled") return "cancelled";
  return "expired";
}

export function safeBillingError(error: unknown) {
  logger.error("billing provider operation failed", { err: error });
  return "Billing provider operation failed";
}
