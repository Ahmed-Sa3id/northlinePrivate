import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "./index";

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe("billing endpoint security", () => {
  it("requires authentication for subscription, checkout, and portal access", async () => {
    expect((await request(app).get("/subscription")).status).toBe(401);
    expect(
      (
        await request(app)
          .post("/billing/checkout")
          .send({ planId: "plan-business" })
      ).status,
    ).toBe(401);
    expect((await request(app).post("/billing/portal")).status).toBe(401);
  });

  it("rejects missing and invalid Stripe webhook signatures", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_placeholder";
    const missing = await request(app)
      .post("/billing/webhook")
      .send({ type: "invoice.paid" });
    expect(missing.status).toBe(400);
    const invalid = await request(app)
      .post("/billing/webhook")
      .set("stripe-signature", "t=1,v1=invalid")
      .send({ type: "invoice.paid" });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain("sk_test_placeholder");
    expect(JSON.stringify(invalid.body)).not.toContain(
      "whsec_test_placeholder",
    );
  });
});
