import { useEffect, useState } from "react";
import { api } from "./api";
import type { SubscriptionResponse } from "./types";

export function Billing({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<SubscriptionResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setData(await api<SubscriptionResponse>("/subscription"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load billing");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function openCheckout(planId: "plan-free" | "plan-business") {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        checkoutUrl?: string;
        portalUrl?: string;
        managedExistingSubscription?: boolean;
      }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ planId }),
      });
      const destination = result.portalUrl ?? result.checkoutUrl;
      if (!destination)
        throw new Error("Billing provider returned no destination");
      window.location.assign(destination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start checkout");
      setBusy(false);
    }
  }

  async function openPortal() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ portalUrl: string }>("/billing/portal", {
        method: "POST",
      });
      window.location.assign(result.portalUrl);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to open billing portal",
      );
      setBusy(false);
    }
  }

  if (!data)
    return (
      <section className="panel">
        <p>Loading billing…</p>
        {error && <p className="error">{error}</p>}
      </section>
    );
  const { subscription, plan } = data;
  const trial = subscription.status === "trialing" && subscription.trialEndsAt;
  return (
    <section className="panel billing-panel">
      <div className="panel-heading">
        <div>
          <p className="kicker">Subscription</p>
          <h2>{plan.name} plan</h2>
        </div>
        <strong className={`status status-${subscription.status}`}>
          {subscription.status}
        </strong>
      </div>
      <div className="billing-grid">
        <div>
          <span className="muted">Users</span>
          <strong>{plan.maxUsers ?? "Unlimited"}</strong>
        </div>
        <div>
          <span className="muted">Projects</span>
          <strong>{plan.maxProjects ?? "Unlimited"}</strong>
        </div>
        <div>
          <span className="muted">Billing period</span>
          <strong>
            {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
          </strong>
        </div>
        {trial && (
          <div>
            <span className="muted">Trial ends</span>
            <strong>
              {new Date(subscription.trialEndsAt!).toLocaleDateString()}
            </strong>
          </div>
        )}
      </div>
      {subscription.cancelAtPeriodEnd && (
        <p className="warning">
          Cancellation is scheduled for the end of the current billing period.{" "}
          {/* The only cancellation copy the plan found was this line, with
              nowhere to go for the full policy — now it links to it. */}
          <a href="/refunds">Read the refund &amp; cancellation policy</a>.
        </p>
      )}
      {(subscription.status === "past_due" ||
        subscription.status === "unpaid") && (
        <p className="warning">
          Payment needs attention. Manage your payment method in the billing
          portal.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {canManage && (
        <div className="billing-actions">
          <button
            disabled={busy}
            onClick={() => void openCheckout("plan-business")}
          >
            Choose Business
          </button>
          <button
            className="secondary"
            disabled={
              busy || (!subscription.cancelAtPeriodEnd && !data.subscription)
            }
            onClick={() => void openPortal()}
          >
            Manage billing
          </button>
        </div>
      )}
      <p className="muted billing-links">
        <a href="/refunds">Refund &amp; cancellation policy</a>
        <a href="/support">Contact support</a>
        <a href="/terms">Terms of Service</a>
      </p>
    </section>
  );
}
