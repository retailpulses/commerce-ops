import { SendError } from "./sendError";
import type { PlatformSendAdapter, PlatformSendCommand, PlatformSendResult } from "./platformSendRouter";

export class AmazonSpApiSendAdapter implements PlatformSendAdapter {
  readonly platform = "amazon" as const;

  preflight(ticket: PlatformSendCommand["ticket"]): never {
    if (ticket.platform !== this.platform) throw new SendError("Ticket platform does not match the send route", "PLATFORM_MISMATCH", 409);
    throw new SendError(
      "No supported SP-API Messaging action is available for this generic reply. Use the approved Seller Central fallback.",
      "AMAZON_SPAPI_ACTION_UNAVAILABLE",
      503,
    );
  }

  async send(command: PlatformSendCommand): Promise<PlatformSendResult> {
    return this.preflight(command.ticket);
  }
}
