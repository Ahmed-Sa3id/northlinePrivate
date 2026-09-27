import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deliverTransactionalEmail,
  publicAppUrl,
  renderActionEmail,
  sendTransactionalEmail,
  type EmailMessage,
} from "./email";
import { emailSends } from "./_core/metrics";
import { resetLogging, setLogSink } from "./_core/logger";

const apiKey = "re_unit_test_key_0123456789";
const sender = "Northline <no-reply@sender.test>";

const message: EmailMessage = {
  to: "recipient@example.test",
  subject: "Verify your Northline email",
  text: "Verify: https://app.example.test/verify-email?token=abc",
  html: "<p>Verify</p>",
};

/** Everything these tests overwrite, restored so suites cannot leak state. */
const saved = {
  RESEND_API_KEY: undefined as string | undefined,
  EMAIL_FROM: undefined as string | undefined,
  APP_URL: undefined as string | undefined,
  NODE_ENV: undefined as string | undefined,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  saved.RESEND_API_KEY = process.env.RESEND_API_KEY;
  saved.EMAIL_FROM = process.env.EMAIL_FROM;
  saved.APP_URL = process.env.APP_URL;
  saved.NODE_ENV = process.env.NODE_ENV;
  process.env.RESEND_API_KEY = apiKey;
  process.env.EMAIL_FROM = sender;
  process.env.APP_URL = "https://app.example.test";
  process.env.NODE_ENV = "test";
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  emailSends.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.RESEND_API_KEY = saved.RESEND_API_KEY;
  process.env.EMAIL_FROM = saved.EMAIL_FROM;
  process.env.APP_URL = saved.APP_URL;
  process.env.NODE_ENV = saved.NODE_ENV;
  resetLogging();
});

function providerResponds(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("transactional email safety", () => {
  it("escapes action links and text in HTML templates", () => {
    const email = renderActionEmail({
      title: "Verify <Northline>",
      intro: "Use the link & continue",
      actionUrl: 'https://example.test/?x="quoted"',
      actionLabel: "Verify now",
    });
    expect(email.html).not.toContain("<Northline>");
    expect(email.html).toContain("&lt;Northline&gt;");
    expect(email.html).toContain("&quot;quoted&quot;");
  });

  it("uses the configured application URL instead of request headers", () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "https://app.northline.example/";
    expect(publicAppUrl()).toBe("https://app.northline.example");
    process.env.APP_URL = previous;
  });
});

describe("Resend transport", () => {
  it("posts to Resend with the key in the header and the configured sender", async () => {
    fetchMock.mockResolvedValue(providerResponds(200, { id: "email-id" }));

    const result = await sendTransactionalEmail(message);

    expect(result).toEqual({ delivered: true, mode: "resend" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      `Bearer ${apiKey}`,
    );

    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.from).toBe(sender);
    expect(payload.to).toEqual([message.to]);
    expect(payload.subject).toBe(message.subject);
    expect(payload.text).toBe(message.text);
    expect(payload.html).toBe(message.html);
    // The key travels as a header only — it must never be in the body.
    expect(String(init.body)).not.toContain(apiKey);
    expect(JSON.stringify(payload)).not.toContain("apiKey");
  });

  it("suppresses instead of sending when no credentials are configured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;

    const result = await sendTransactionalEmail(message);

    expect(result).toEqual({ delivered: false, mode: "development" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to run unconfigured in production rather than silently dropping mail", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;

    await expect(sendTransactionalEmail(message)).rejects.toThrow(
      "Transactional email is not configured for production",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a transient provider failure exactly once", async () => {
    fetchMock
      .mockResolvedValueOnce(providerResponds(503, { message: "busy" }))
      .mockResolvedValueOnce(providerResponds(200, { id: "email-id" }));

    const result = await sendTransactionalEmail(message);

    expect(result).toEqual({ delivered: true, mode: "resend" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a rejected sender and surfaces the provider reason", async () => {
    fetchMock.mockResolvedValue(
      providerResponds(403, {
        name: "validation_error",
        message:
          "The sender.test domain is not verified. Please, add and verify your domain.",
      }),
    );

    await expect(sendTransactionalEmail(message)).rejects.toThrow(
      /domain is not verified/,
    );
    // A permanent rejection would fail identically on the next attempt.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never writes the API key into the log", async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    fetchMock.mockResolvedValue(
      providerResponds(403, { name: "validation_error", message: "rejected" }),
    );

    await deliverTransactionalEmail(message, "verification");

    const logged = lines.join("\n");
    expect(logged).toContain("transactional email delivery failed");
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain("Bearer");
  });
});

describe("best-effort delivery", () => {
  it("reports a rejected provider instead of failing the caller", async () => {
    fetchMock.mockResolvedValue(
      providerResponds(403, {
        name: "validation_error",
        message: "The sender.test domain is not verified.",
      }),
    );

    const result = await deliverTransactionalEmail(message, "verification");

    expect(result).toEqual({ delivered: false, mode: "failed" });
    expect(emailSends.get({ flow: "verification", result: "failed" })).toBe(1);
    expect(emailSends.get({ flow: "verification", result: "delivered" })).toBe(
      0,
    );
  });

  it("counts an accepted message as delivered", async () => {
    fetchMock.mockResolvedValue(providerResponds(200, { id: "email-id" }));

    const result = await deliverTransactionalEmail(message, "invitation");

    expect(result.delivered).toBe(true);
    expect(emailSends.get({ flow: "invitation", result: "delivered" })).toBe(1);
  });

  it("counts a development suppression separately from a failure", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;

    const result = await deliverTransactionalEmail(message, "password-reset");

    expect(result).toEqual({ delivered: false, mode: "development" });
    expect(
      emailSends.get({ flow: "password-reset", result: "suppressed" }),
    ).toBe(1);
    expect(emailSends.get({ flow: "password-reset", result: "failed" })).toBe(
      0,
    );
  });
});
