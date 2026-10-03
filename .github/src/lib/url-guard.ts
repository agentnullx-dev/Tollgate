import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** Host patterns accepted per channel type (exact host or "*.suffix"). */
export const CHANNEL_HOST_ALLOWLIST: Record<"SLACK" | "TEAMS", string[]> = {
  SLACK: ["hooks.slack.com", "hooks.slack-gov.com"],
  TEAMS: ["*.webhook.office.com", "*.logic.azure.com", "*.powerplatform.com", "*.environment.api.powerplatform.com"],
};

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === pattern;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE_V4.some(([base, bits]) => inCidr(ip, base, bits));
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("ff")) return true; // multicast
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

/** Static checks done when a channel is created (no DNS). */
export function validateDestinationUrl(raw: string, channelType: "SLACK" | "TEAMS" | "WEBHOOK", allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Destination is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new UnsafeUrlError("Destination must use https.");
  }
  if (url.username || url.password) throw new UnsafeUrlError("Credentials in the URL are not allowed.");
  const host = url.hostname.toLowerCase();
  if (channelType !== "WEBHOOK") {
    const allowed = CHANNEL_HOST_ALLOWLIST[channelType];
    if (!allowed.some((p) => hostMatches(host, p))) {
      throw new UnsafeUrlError(`${channelType === "SLACK" ? "Slack" : "Teams"} webhooks must point at ${allowed.join(", ")}.`);
    }
  }
  if (!allowPrivate && isIP(host) && isPrivateAddress(host)) {
    throw new UnsafeUrlError("Destination resolves to a private or reserved address.");
  }
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))) {
    throw new UnsafeUrlError("Destination host is not publicly routable.");
  }
  return url;
}

/**
 * Send-time check: resolve DNS and refuse private targets, defeating DNS
 * rebinding between channel creation and delivery.
 */
export async function assertPublicDestination(url: URL, allowPrivate = false): Promise<void> {
  if (allowPrivate) return;
  const host = url.hostname;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new UnsafeUrlError(`Could not resolve ${host}.`);
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new UnsafeUrlError(`${host} resolves to a private address (${a.address}).`);
  }
}
