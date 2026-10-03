import { withApiHandler, json, parseJsonBody } from "@/lib/http";
import { CreateChannelSchema } from "@/lib/schemas";
import { prisma } from "@/lib/prisma";
import { channelView } from "@/lib/notifications/channels";
import { createNotificationChannel } from "@/lib/notifications/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiHandler({ scopes: ["org:admin"] }, async ({ auth }) => {
  const channels = await prisma.notificationChannel.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: "asc" },
  });
  return json({ data: channels.map(channelView) });
});

/** Create a Slack, Teams, email or signed-webhook channel. Destinations are encrypted at rest. */
export const POST = withApiHandler({ scopes: ["org:admin"] }, async ({ req, auth, requestId }) => {
  const input = await parseJsonBody(req, CreateChannelSchema, 16_000);
  const channel = await createNotificationChannel({
    organizationId: auth.organizationId,
    channel: input,
    actor: { type: "API_KEY", id: auth.apiKeyId },
    requestId,
  });
  return json({ data: channelView(channel) }, { status: 201 });
});
