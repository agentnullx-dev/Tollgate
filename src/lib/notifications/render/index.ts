import type { NotificationContext, RenderedNotification, ResolvedChannel } from "../types";
import { renderSlack } from "./slack";
import { renderTeams } from "./teams";
import { renderEmail } from "./email";
import { renderWebhook } from "./webhook";

export function renderForChannel(channel: ResolvedChannel, ctx: NotificationContext, deliveryId: string): RenderedNotification {
  switch (channel.type) {
    case "SLACK":
      return renderSlack(ctx);
    case "TEAMS":
      return renderTeams(ctx);
    case "EMAIL":
      return renderEmail(ctx, channel.name);
    case "WEBHOOK":
      return renderWebhook(ctx, deliveryId, channel.secret);
    default: {
      const exhaustive: never = channel.type;
      throw new Error(`Unsupported channel type ${String(exhaustive)}`);
    }
  }
}

export { renderSlack, renderTeams, renderEmail, renderWebhook };
