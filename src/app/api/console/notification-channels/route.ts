import { json, parseJsonBody } from "@/lib/http";
import { CreateChannelSchema } from "@/lib/schemas";
import { prisma } from "@/lib/prisma";
import { withSessionHandler } from "@/lib/session";
import { channelView } from "@/lib/notifications/channels";
import { createNotificationChannel } from "@/lib/notifications/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every member can see where alerts go; destinations are shown masked. */
export const GET = withSessionHandler({ permission: "dashboard:read" }, async ({ session }) => {
  const channels = await prisma.notificationChannel.findMany({ where: { organizationId: session.organizationId }, orderBy: { createdAt: "asc" } });
  return json({ data: channels.map(channelView) });
});

/** Entering webhook URLs and signing secrets is an admin action (secrets:write). */
export const POST = withSessionHandler({ permission: "secrets:write" }, async ({ req, session, requestId }) => {
  const input = await parseJsonBody(req, CreateChannelSchema, 16_000);
  const channel = await createNotificationChannel({
    organizationId: session.organizationId,
    channel: input,
    actor: { type: "USER", id: session.userId },
    requestId,
  });
  return json({ data: channelView(channel) }, { status: 201 });
});
