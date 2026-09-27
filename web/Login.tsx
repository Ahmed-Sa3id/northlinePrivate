import React, { useState } from "react";
import { api } from "./api";
import { CONTACT_EMAIL } from "./Legal";
import type { Session } from "./types";

type AuthMode = "login" | "signup" | "verify" | "forgot" | "reset" | "invite";

/**
 * The paths an emailed link lands on, and the screen each one opens.
 *
 * Defined as a map rather than a chain of comparisons because two things now
 * depend on agreeing about it: which form `initialMode()` selects, and
 * `Root`'s decision to show that form even when this browser is already
 * signed in as somebody else. `initialMode` used to be a bare chain, which is
 * why `/verify-email?token=…` and `/reset-password?token=…` once opened the
 * plain sign-in form and silently dropped the token the user had just
 * clicked.
 */
const AUTH_LINK_MODES: Record<string, AuthMode> = {
  "/accept-invitation": "invite",
  "/reset-password": "reset",
  "/verify-email": "verify",
};

function normalisePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** True when the path is one of the flows only an emailed link opens. */
export function isAuthLinkPath(pathname: string): boolean {
  return normalisePath(pathname) in AUTH_LINK_MODES;
}

function initialMode(): AuthMode {
  return AUTH_LINK_MODES[normalisePath(window.location.pathname)] ?? "login";
}

export function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyEmail, setCompanyEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [token, setToken] = useState(
    new URLSearchParams(window.location.search).get("token") ?? "",
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function switchMode(next: AuthMode) {
    setMode(next);
    setError("");
    setMessage("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "verify") {
        await api("/auth/verify-email", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
        switchMode("login");
        setMessage("Email verified. You can now sign in.");
        return;
      }
      if (mode === "forgot") {
        const result = await api<{ message: string }>("/auth/forgot-password", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        setMessage(result.message);
        return;
      }
      if (mode === "reset") {
        await api("/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ token, password }),
        });
        setMessage("Password reset. You can now sign in.");
        switchMode("login");
        return;
      }
      if (mode === "invite") {
        const session = await api<Session>("/invitations/accept", {
          method: "POST",
          body: JSON.stringify({ token, name, password }),
        });
        onLogin(session);
        return;
      }
      if (mode === "signup") {
        const result = await api<{ emailDelivered?: boolean }>(
          "/auth/register",
          {
            method: "POST",
            body: JSON.stringify({
              name,
              email,
              password,
              companyName,
              companyEmail,
              phone: phone || undefined,
            }),
          },
        );
        switchMode("verify");
        setMessage(
          result.emailDelivered === false
            ? "Your account was created, but the verification email could not be sent. Use “Resend verification email” once sending is configured."
            : "Check your email to verify your account before signing in.",
        );
        return;
      }
      const session = await api<Session>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onLogin(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to continue");
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "login"
      ? "Enter your workspace."
      : mode === "signup"
        ? "Create your company workspace."
        : mode === "verify"
          ? "Verify your email address."
          : mode === "forgot"
            ? "Recover your account."
            : mode === "invite"
              ? "Join your Northline workspace."
              : "Choose a new password.";

  return (
    <main className="landing-shell">
      <nav className="landing-nav">
        <div className="brand">NORTHLINE</div>
        <span className="muted">
          Construction operations, without the spreadsheet chaos.
        </span>
        <a href="#pricing">Pricing</a>
      </nav>
      <section className="landing-hero">
        <div className="hero-copy">
          <p className="kicker">The operational layer for contractors</p>
          <h1>
            Construction management,
            <br />
            without the spreadsheet chaos.
          </h1>
          <p className="hero-subtitle">
            Manage projects, workers, materials, expenses, and site issues in
            one clear workspace built for small and medium-sized construction
            companies.
          </p>
          <div className="hero-actions">
            <button onClick={() => switchMode("signup")}>Start free</button>
            <a className="secondary" href={`mailto:${CONTACT_EMAIL}`}>
              Book a demo
            </a>
          </div>
          <div className="trust-row">
            <span>Projects</span>
            <span>Workforce</span>
            <span>Materials</span>
            <span>Safety</span>
          </div>
        </div>
        <section className="login-card auth-card">
          <p className="kicker">
            {mode === "login"
              ? "Welcome back"
              : mode === "signup"
                ? "14-day free trial"
                : "Account security"}
          </p>
          <h2>{title}</h2>
          <form onSubmit={submit}>
            {/* The workspace and role come from the invitation itself, so
                the company fields must stay signup-only: they are required,
                and the server ignores them for invitees — which is what
                blocked acceptance before. The *name* field, though, has to
                render here as well as at signup: `invitationAcceptSchema`
                requires `name` (min 2), and invite mode used to collect only
                a password, so acceptance failed validation every time. */}
            {(mode === "signup" || mode === "invite") && (
              <label>
                Your name
                <input
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            )}
            {mode === "signup" && (
              <>
                <label>
                  Company name
                  <input
                    required
                    value={companyName}
                    onChange={(event) => setCompanyName(event.target.value)}
                  />
                </label>
                <label>
                  Company email
                  <input
                    required
                    type="email"
                    value={companyEmail}
                    onChange={(event) => setCompanyEmail(event.target.value)}
                  />
                </label>
                <label>
                  Phone <span className="muted">optional</span>
                  <input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </label>
              </>
            )}
            {/* In `verify` mode the field is present only to address the
                resend button, and it must not be required: the emailed link
                arrives with a token but no address. */}
            {mode !== "reset" && mode !== "invite" && (
              <label>
                Email
                <input
                  required={mode !== "verify"}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            )}
            {(mode === "verify" || mode === "reset") && (
              <label>
                Verification or reset token
                <input
                  required
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
            )}
            {(mode === "login" ||
              mode === "signup" ||
              mode === "reset" ||
              mode === "invite") && (
              <label>
                Password
                <input
                  required
                  minLength={12}
                  maxLength={128}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            )}
            {message && <p className="muted">{message}</p>}
            {error && <p className="error">{error}</p>}
            {/* Statement rather than a consent checkbox: capturing and
                storing consent would need a field the API does not have, so
                a checkbox here would be theatre. Whether counsel wants an
                affirmative tick is tracked under PRODUCTION_PLAN #10. */}
            {mode === "signup" && (
              <p className="muted legal-consent">
                By creating a workspace you agree to the{" "}
                <a href="/terms">Terms of Service</a> and the{" "}
                <a href="/privacy">Privacy Policy</a>.
              </p>
            )}
            <button disabled={busy}>
              {busy
                ? "Please wait…"
                : mode === "login"
                  ? "Enter workspace"
                  : mode === "signup"
                    ? "Create workspace"
                    : mode === "invite"
                      ? "Join workspace"
                      : mode === "verify"
                        ? "Verify email"
                        : mode === "forgot"
                          ? "Send recovery email"
                          : "Reset password"}
            </button>
          </form>
          {mode === "login" && (
            <>
              <button
                className="link-button"
                onClick={() => switchMode("signup")}
              >
                New to Northline? Start free
              </button>
              <button
                className="link-button"
                onClick={() => switchMode("forgot")}
              >
                Forgot your password?
              </button>
              <button
                className="link-button"
                onClick={() => switchMode("verify")}
              >
                Verify or resend your email
              </button>
              {/* Seeding the demo tenant is now opt-in
                  (`SEED_DEMO_USERS=1`), so a published password on the
                  sign-in card is a credential that either does not exist or
                  should never ship. Development builds only. */}
              {import.meta.env.DEV && (
                <small>Demo admin: admin@construction.local / Admin123!</small>
              )}
            </>
          )}
          {mode === "verify" && (
            <button
              // `type="button"` is load-bearing: the default inside a form is
              // `submit`, which fired the verify request alongside the
              // resend and overwrote its message with a token validation
              // error.
              type="button"
              className="link-button"
              disabled={busy || !email.trim()}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await api<{ message: string }>(
                    "/auth/resend-verification",
                    {
                      method: "POST",
                      body: JSON.stringify({ email }),
                    },
                  );
                  setMessage(result.message);
                } catch (err) {
                  setError(
                    err instanceof Error
                      ? err.message
                      : "Unable to resend verification",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Resend verification email
            </button>
          )}
          {mode !== "login" && (
            <button className="link-button" onClick={() => switchMode("login")}>
              Back to sign in
            </button>
          )}
        </section>
      </section>
      <section className="landing-grid">
        <article>
          <strong>One operational view</strong>
          <p>
            Replace fragmented spreadsheets, WhatsApp threads, and delayed
            reporting with one source of truth.
          </p>
        </article>
        <article>
          <strong>Built for the site</strong>
          <p>
            Track attendance, material movement, expenses, and safety issues
            while the work is happening.
          </p>
        </article>
        <article id="pricing">
          <strong>Start small</strong>
          <p>
            Free for one project. Upgrade when your team is ready—plans and
            limits are configurable.
          </p>
        </article>
      </section>
      {/* Reachable from signup as required by PRODUCTION_PLAN #10: all four
          documents are real paths, so they work whether or not the visitor
          has an account. */}
      <footer className="landing-footer muted">
        <a href="/terms">Terms of Service</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/support">Support</a>
        <a href="/refunds">Refunds &amp; cancellation</a>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </footer>
    </main>
  );
}
