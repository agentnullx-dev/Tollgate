import type { ActorType, NotificationChannel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/errors";
import type { CreateChannelInput } from "@/lib/schemas";
import { recordAudit } from "@/lib/services/audit";
import { sealChannelTarget } from "./channels";

const MAX_CHANNELS = 50;

/** Validate, encrypt and store a notification channel. Shared by the API-key and console routes. */
export async function createNotificationChannel(input: {
  organizationId: string;
  channel: CreateChannelInput;
  actor: { type: ActorType; id: string };
  requestId: string;
}): Promise<NotificationChannel> {
  const { organizationId, channel: c, actor, requestId } = input;
  const count = await prisma.notificationChannel.count({ where: { organizationId } });
  if (count >= MAX_CHANNELS) throw Errors.conflict(`Organizations can have at most ${MAX_CHANNELS} notification channels.`);

  let sealed;
  try {
    sealed =
      c.type === "EMAIL"
        ? sealChannelTarget(organizationId, "EMAIL", c.recipients)
        : sealChannelTarget(organizationId, c.type, c.webhookUrl, c.type === "WEBHOOK" ? c.signingSecret ?? null : null);
  } catch (err) {
    throw Errors.badRequest(err instanceof Error ? err.message : "Invalid destination.");
  }

  const channel = await prisma.notificationChannel.create({
    data: { organizationId, type: c.type, name: c.name, minSeverity: c.minSeverity, alertTypes: c.alertTypes, ...sealed },
  });
  await recordAudit({
    organizationId,
    actorType: actor.type,
    actorId: actor.id,
    action: "notification_channel.created",
    targetType: "notification_channel",
    targetId: channel.id,
    after: { type: channel.type, name: channel.name, target: channel.targetHint, hasSigningSecret: channel.secretCiphertext !== null },
    requestId,
  });
  return channel;
}
