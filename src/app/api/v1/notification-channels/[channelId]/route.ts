import { withApiHandler, json, parseJsonBody } from "@/lib/http";
import { UpdateChannelSchema } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { channelView } from "@/lib/notifications/channels";
import { recordAudit } from "@/lib/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { channelId: string };

async function findChannel(organizationId: string, channelId: string) {
  const channel = await prisma.notificationChannel.findFirst({ where: { id: channelId, organizationId } });
  if (!channel) throw Errors.notFound("Notification channel", channelId);
  return channel;
}

export const GET = withApiHandler<Params>({ scopes: ["org:admin"] }, async ({ auth, params }) => {
  const channel = await findChannel(auth.organizationId, params.channelId);
  const stats = await prisma.notificationDelivery.groupBy({
    by: ["status"],
    where: { channelId: channel.id, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    _count: { _all: true },
  });
  return json({
    data: {
      ...channelView(channel),
      last7Days: Object.fromEntries(stats.map((s) => [s.status, s._count._all])),
    },
  });
});

export const PATCH = withApiHandler<Params>({ scopes: ["org:admin"] }, async ({ req, auth, params, requestId }) => {
  const input = await parseJsonBody(req, UpdateChannelSchema, 8_000);
  const existing = await findChannel(auth.organizationId, params.channelId);
  const channel = await prisma.notificationChannel.update({ where: { id: existing.id }, data: input });
  await recordAudit({
    organizationId: auth.organizationId,
    actorType: "API_KEY",
    actorId: auth.apiKeyId,
    action: "notification_channel.updated",
    targetType: "notification_channel",
    targetId: channel.id,
    before: { name: existing.name, minSeverity: existing.minSeverity, alertTypes: existing.alertTypes, isEnabled: existing.isEnabled },
    after: { name: channel.name, minSeverity: channel.minSeverity, alertTypes: channel.alertTypes, isEnabled: channel.isEnabled },
    requestId,
  });
  return json({ data: channelView(channel) });
});

export const DELETE = withApiHandler<Params>({ scopes: ["org:admin"] }, async ({ auth, params, requestId }) => {
  const existing = await findChannel(auth.organizationId, params.channelId);
  await prisma.notificationChannel.delete({ where: { id: existing.id } });
  await recordAudit({
    organizationId: auth.organizationId,
    actorType: "API_KEY",
    actorId: auth.apiKeyId,
    action: "notification_channel.deleted",
    targetType: "notification_channel",
    targetId: existing.id,
    before: { type: existing.type, name: existing.name, target: existing.targetHint },
    requestId,
  });
  return new Response(null, { status: 204 });
});
