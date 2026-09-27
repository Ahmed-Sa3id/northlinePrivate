import { randomUUID } from "node:crypto";
import { logger } from "./_core/logger";
import { emailSends } from "./_core/metrics";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** Product flow that produced the message — a closed set, used only as a
 *  bounded metric label so "which mail stopped arriving" is answerable. */
export type EmailFlow = "verification" | "password-reset" | "invitation";

export type EmailDelivery = {
  delivered: boolean;
  /** `resend`      — the provider accepted the message.
   *  `development` — no credentials configured, so nothing was attempted.
   *  `failed`      — the provider rejected it (see the error log record). */
  mode: "resend" | "development" | "failed";
};

const EMAIL_TIMEOUT_MS = 10_000;
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

export function publicAppUrl() {
  const configured = process.env.APP_URL?.trim();
  if (!configured) return "http://localhost:3000";
  const url = new URL(configured);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production")
    throw new Error("APP_URL must use HTTPS in production");
  return url.toString().replace(/\/$/, "");
}

/**
 * A failure worth repeating: the request never reached the provider, or the
 * provider is asking us to slow down. Everything else Resend answers with a
 * 4xx for — an invalid key, an unverified sending domain, a malformed
 * payload — will fail identically on the next attempt, so retrying only
 * delays the error and doubles the traffic against the provider.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Resend answers with `{ name, message }`, e.g.
 * `validation_error: The example.com domain is not verified.` — exactly the
 * detail an operator needs, and nothing resembling a credential. The body is
 * read for the log/error only; it is never shown to the API caller.
 */
async function readProviderMessage(response: Response): Promise<string> {
  const fallback = `HTTP ${response.status}`;
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return fallback;
    const { name, message } = body as { name?: unknown; message?: unknown };
    const parts = [name, message].filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    );
    return parts.length > 0 ? parts.join(": ") : fallback;
  } catch {
    return fallback;
  }
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

async function sendOnce(message: EmailMessage) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
    });
  } catch (error) {
    // Network failure or timeout. Nothing was accepted, so a retry cannot
    // duplicate a message.
    throw new EmailSendError(
      error instanceof Error ? error.message : "Email provider unreachable",
      null,
      true,
    );
  }
  if (!response.ok) {
    const detail = await readProviderMessage(response);
    throw new EmailSendError(
      `Email provider rejected request (${response.status}): ${detail}`,
      response.status,
      isRetryableStatus(response.status),
    );
  }
}

/**
 * Sends through Resend, or reports the failure by throwing.
 *
 * The API key and sender are read from the environment on every call and the
 * key is only ever placed in the `Authorization` header — it is never logged
 * (the logger additionally scrubs `re_…` shaped values), never put in the
 * request body, and never returned to a caller.
 */
export async function sendTransactionalEmail(
  message: EmailMessage,
): Promise<EmailDelivery> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (process.env.NODE_ENV === "production" && (!apiKey || !from)) {
    throw new Error("Transactional email is not configured for production");
  }
  if (!apiKey || !from) {
    logger.info("transactional email suppressed in development", {
      id: randomUUID(),
      to: message.to,
      subject: message.subject,
    });
    return { delivered: false, mode: "development" };
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await sendOnce(message);
      return { delivered: true, mode: "resend" };
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof EmailSendError ? error.retryable : true;
      logger.warn("transactional email attempt failed", {
        attempt,
        retryable,
        to: message.to,
        subject: message.subject,
        err: error,
      });
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Transactional email delivery failed");
}

/**
 * Sends the message and reports the outcome, but never throws.
 *
 * Every caller does its database work first: the account row, the invitation
 * row and the hashed token are already committed by the time the email goes
 * out. Failing the request there would hand the client a 500 for an account
 * that *does* exist — and a retry would then hit `EMAIL_ALREADY_EXISTS`,
 * while `/auth/resend-verification` would fail the same way, leaving no way
 * forward. So the failure is recorded instead of propagated:
 *
 *   - an `error`-level log record carrying the request id, and
 *   - `northline_email_sends_total{flow,result="failed"}`.
 *
 * Both are meant to be alerted on, which is how a rejected sender becomes a
 * page rather than a silently unverifiable sign-up.
 */
export async function deliverTransactionalEmail(
  message: EmailMessage,
  flow: EmailFlow,
): Promise<EmailDelivery> {
  try {
    const outcome = await sendTransactionalEmail(message);
    emailSends.inc({
      flow,
      result: outcome.delivered ? "delivered" : "suppressed",
    });
    return outcome;
  } catch (error) {
    emailSends.inc({ flow, result: "failed" });
    logger.error("transactional email delivery failed", {
      flow,
      to: message.to,
      subject: message.subject,
      err: error,
    });
    return { delivered: false, mode: "failed" };
  }
}

export function renderActionEmail(input: {
  title: string;
  intro: string;
  actionUrl: string;
  actionLabel: string;
}) {
  const title = escapeHtml(input.title);
  const intro = escapeHtml(input.intro);
  const actionUrl = escapeHtml(input.actionUrl);
  const actionLabel = escapeHtml(input.actionLabel);
  return {
    text: `${input.title}\n\n${input.intro}\n\n${input.actionLabel}: ${input.actionUrl}\n\nIf you did not request this, you can safely ignore this email.`,
    html: `<h2>${title}</h2><p>${intro}</p><p><a href="${actionUrl}">${actionLabel}</a></p><p>If you did not request this, you can safely ignore this email.</p>`,
  };
}
