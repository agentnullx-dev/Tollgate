import nodemailer, { type Transporter } from "nodemailer";
import { env } from "@/lib/env";
import { assertPublicDestination, UnsafeUrlError, validateDestinationUrl } from "@/lib/url-guard";
import { parseRetryAfter } from "./backoff";
import type { DeliveryResult, EmailMessageSpec, HttpRequestSpec, ResolvedChannel } from "./types";

const USER_AGENT = "Tollgate-Notifier/1.0 (+https://tollgate.dev)";

/** HTTP status codes that are worth retrying. Everything else 4xx is permanent. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : "";
    return `${err.name}: ${err.message}${causeMsg}`;
  }
  return String(err);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

async function readSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

export async function sendHttp(channel: ResolvedChannel, spec: HttpRequestSpec): Promise<DeliveryResult> {
  const e = env();
  let url: URL;
  try {
    url = validateDestinationUrl(channel.target, channel.type === "EMAIL" ? "WEBHOOK" : channel.type, e.NOTIFY_ALLOW_PRIVATE_WEBHOOKS);
    await assertPublicDestination(url, e.NOTIFY_ALLOW_PRIVATE_WEBHOOKS);
  } catch (err) {
    if (err instanceof UnsafeUrlError) return { ok: false, retryable: false, error: err.message };
    // DNS failures are usually transient.
    return { ok: false, retryable: true, error: errorText(err) };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "user-agent": USER_AGENT, ...spec.headers },
      body: spec.body,
      // Never follow redirects: a redirect could point at an internal address.
      redirect: "manual",
      signal: AbortSignal.timeout(e.NOTIFY_HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, retryable: true, error: isTimeout(err) ? `Timed out after ${e.NOTIFY_HTTP_TIMEOUT_MS} ms` : errorText(err) };
  }

  if (res.status >= 300 && res.status < 400) {
    return { ok: false, retryable: false, statusCode: res.status, error: `Destination redirected (${res.status}); redirects are not followed.` };
  }

  const snippet = await readSnippet(res);

  if (res.ok) {
    // Slack answers 200 "ok"; anything else in a 200 is still a success for Teams/webhooks.
    return { ok: true, retryable: false, statusCode: res.status, providerMessageId: res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? undefined };
  }

  const retryable = isRetryableStatus(res.status);
  return {
    ok: false,
    retryable,
    statusCode: res.status,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    error: `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface EmailTransport {
  readonly name: string;
  send(to: string[], message: EmailMessageSpec, idempotencyKey: string): Promise<DeliveryResult>;
}

const globalForMail = globalThis as unknown as { __tollgateSmtp?: Transporter };

/** Pool and timeout defaults, applied as URL query parameters (nodemailer only reads transport options from the URL). */
const SMTP_URL_DEFAULTS: Record<string, string> = {
  pool: "true",
  maxConnections: "4",
  connectionTimeout: "10000",
  greetingTimeout: "10000",
  socketTimeout: "20000",
};

function smtpTransporter(url: string): Transporter {
  if (!globalForMail.__tollgateSmtp) {
    const parsed = new URL(url);
    // Settings already present in SMTP_URL take precedence.
    for (const [key, value] of Object.entries(SMTP_URL_DEFAULTS)) {
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    }
    globalForMail.__tollgateSmtp = nodemailer.createTransport(parsed.toString());
  }
  return globalForMail.__tollgateSmtp;
}

/** SMTP reply codes: 4xx are transient, 5xx permanent. Connection errors are transient. */
function classifySmtpError(err: unknown): DeliveryResult {
  const e = err as { responseCode?: number; code?: string; message?: string };
  if (typeof e.responseCode === "number") {
    return {
      ok: false,
      retryable: e.responseCode >= 400 && e.responseCode < 500,
      statusCode: e.responseCode,
      error: `SMTP ${e.responseCode}: ${e.message ?? "rejected"}`,
    };
  }
  return { ok: false, retryable: true, error: `SMTP ${e.code ?? "error"}: ${e.message ?? String(err)}` };
}

export class SmtpEmailTransport implements EmailTransport {
  readonly name = "smtp";
  constructor(private readonly url: string, private readonly from: string) {}

  async send(to: string[], message: EmailMessageSpec, idempotencyKey: string): Promise<DeliveryResult> {
    try {
      const info = await smtpTransporter(this.url).sendMail({
        from: this.from,
        to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: {
          "X-Tollgate-Delivery": idempotencyKey,
          "Auto-Submitted": "auto-generated",
          "X-Auto-Response-Suppress": "All",
        },
      });
      const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
      if (rejected > 0 && rejected === to.length) {
        return { ok: false, retryable: false, error: "All recipients were rejected by the SMTP server." };
      }
      return { ok: true, retryable: false, providerMessageId: info.messageId };
    } catch (err) {
      return classifySmtpError(err);
    }
  }
}

export class ResendEmailTransport implements EmailTransport {
  readonly name = "resend";
  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(to: string[], message: EmailMessageSpec, idempotencyKey: string): Promise<DeliveryResult> {
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          // Resend de-duplicates sends that reuse a key, which makes our retries safe.
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: { "Auto-Submitted": "auto-generated" },
        }),
        signal: AbortSignal.timeout(env().NOTIFY_HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, retryable: true, error: isTimeout(err) ? "Email API timed out" : errorText(err) };
    }
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, retryable: false, statusCode: res.status, providerMessageId: data.id };
    }
    return {
      ok: false,
      retryable: isRetryableStatus(res.status),
      statusCode: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      error: `Email API ${res.status}: ${await readSnippet(res)}`,
    };
  }
}

let cachedEmailTransport: EmailTransport | null | undefined;

export function emailTransport(): EmailTransport | null {
  if (cachedEmailTransport !== undefined) return cachedEmailTransport;
  const e = env();
  if (e.RESEND_API_KEY) cachedEmailTransport = new ResendEmailTransport(e.RESEND_API_KEY, e.EMAIL_FROM);
  else if (e.SMTP_URL) cachedEmailTransport = new SmtpEmailTransport(e.SMTP_URL, e.EMAIL_FROM);
  else cachedEmailTransport = null;
  return cachedEmailTransport;
}

const EMAIL_PATTERN = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

export function parseRecipients(target: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(target);
  } catch {
    throw new Error("Email channel target is not a JSON array.");
  }
  if (!Array.isArray(parsed)) throw new Error("Email channel target is not a JSON array.");
  const recipients = parsed.filter((v): v is string => typeof v === "string" && EMAIL_PATTERN.test(v));
  if (recipients.length === 0) throw new Error("Email channel has no valid recipients.");
  return recipients;
}

export async function sendEmail(channel: ResolvedChannel, spec: EmailMessageSpec, idempotencyKey: string): Promise<DeliveryResult> {
  const transport = emailTransport();
  if (!transport) {
    return { ok: false, retryable: false, error: "No email transport configured. Set SMTP_URL or RESEND_API_KEY." };
  }
  let recipients: string[];
  try {
    recipients = parseRecipients(channel.target);
  } catch (err) {
    return { ok: false, retryable: false, error: errorText(err) };
  }
  return transport.send(recipients, spec, idempotencyKey);
}
