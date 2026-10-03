import { withApiHandler, json } from "@/lib/http";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { buildTestContext } from "@/lib/notifications/context";
import { resolveChannel } from "@/lib/notifications/channels";
import { dispatchToChannel } from "@/lib/notifications/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send a test notification synchronously and report the provider's answer,
 * so misconfigured webhooks are caught at setup time rather than mid-incident.
 */
export const POST = withApiHandler<{ channelId: string }>({ scopes: ["org:admin"] }, async ({ auth, params, requestId }) => {
  const channel = await prisma.notificationChannel.findFirst({
    where: { id: params.channelId, organizationId: auth.organizationId },
    include: { organization: { select: { name: true } } },
  });
  if (!channel) throw Errors.notFound("Notification channel", params.channelId);

  const started = performance.now();
  const result = await dispatchToChannel(resolveChannel(channel), buildTestContext(channel.organization.name, env().APP_BASE_URL), `test-${requestId}`);
  return json(
    {
      data: {
        delivered: result.ok,
        statusCode: result.statusCode ?? null,
        retryable: result.retryable,
        error: result.error ?? null,
        latencyMs: Math.round(performance.now() - started),
      },
    },
    { status: result.ok ? 200 : 502 },
  );
});
