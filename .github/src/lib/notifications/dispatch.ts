import { renderForChannel } from "./render";
import { sendEmail, sendHttp } from "./transports";
import type { DeliveryResult, NotificationContext, ResolvedChannel } from "./types";

/** Render and send one notification to one channel. Never throws. */
export async function dispatchToChannel(channel: ResolvedChannel, ctx: NotificationContext, deliveryId: string): Promise<DeliveryResult> {
  try {
    const rendered = renderForChannel(channel, ctx, deliveryId);
    if (rendered.kind === "email") return await sendEmail(channel, rendered, deliveryId);
    return await sendHttp(channel, rendered);
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}
