import type { NotificationChannel } from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { validateDestinationUrl } from "@/lib/url-guard";
import { env } from "@/lib/env";
import { parseRecipients } from "./transports";
import type { ResolvedChannel } from "./types";

function aadFor(organizationId: string, field: "target" | "secret"): string {
  return `tollgate:notification-channel:${organizationId}:${field}`;
}

export interface SealedTarget {
  targetCiphertext: string;
  targetHint: string;
  secretCiphertext: string | null;
}

/** Validate and encrypt a channel destination. Throws UnsafeUrlError / Error with a user-facing message. */
export function sealChannelTarget(
  organizationId: string,
  type: NotificationChannel["type"],
  target: string | string[],
  secret?: string | null,
): SealedTarget {
  let normalized: string;
  let hint: string;
  if (type === "EMAIL") {
    const list = Array.isArray(target) ? target : [target];
    const recipients = parseRecipients(JSON.stringify(list.map((s) => s.trim().toLowerCase())));
    normalized = JSON.stringify(Array.from(new Set(recipients)));
    const first = recipients[0] ?? "";
    hint = recipients.length === 1 ? first.replace(/^(.).*(@.*)$/, "$1***$2") : `${recipients.length} recipients`;
  } else {
    if (Array.isArray(target)) throw new Error("Webhook channels take a single URL.");
    const url = validateDestinationUrl(target, type, env().NOTIFY_ALLOW_PRIVATE_WEBHOOKS);
    normalized = url.toString();
    const tail = url.pathname.slice(-4);
    hint = `${url.host}/…${tail}`;
  }
  return {
    targetCiphertext: encryptSecret(normalized, aadFor(organizationId, "target")),
    targetHint: hint,
    secretCiphertext: secret ? encryptSecret(secret, aadFor(organizationId, "secret")) : null,
  };
}

export function resolveChannel(channel: NotificationChannel): ResolvedChannel {
  return {
    id: channel.id,
    organizationId: channel.organizationId,
    type: channel.type,
    name: channel.name,
    target: decryptSecret(channel.targetCiphertext, aadFor(channel.organizationId, "target")),
    secret: channel.secretCiphertext ? decryptSecret(channel.secretCiphertext, aadFor(channel.organizationId, "secret")) : null,
  };
}

export function channelView(channel: NotificationChannel) {
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    target: channel.targetHint,
    hasSigningSecret: channel.secretCiphertext !== null,
    minSeverity: channel.minSeverity,
    alertTypes: channel.alertTypes,
    isEnabled: channel.isEnabled,
    createdAt: channel.createdAt.toISOString(),
    updatedAt: channel.updatedAt.toISOString(),
  };
}
