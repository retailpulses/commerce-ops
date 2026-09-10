import type { CopywritingRepository } from "../repositories/ticketRepository";
import { SendError } from "./sendError";
import type { PlatformSendAdapter, PlatformSendCommand, PlatformSendResult } from "./platformSendRouter";
import { reviewedLastSeenAt } from "./platformSendRouter";
import { RakutenRmesseSendService } from "./rakutenRmesseSendService";

export class RakutenRmesseSendAdapter implements PlatformSendAdapter {
  readonly platform = "rakuten" as const;

  constructor(
    private readonly repository: CopywritingRepository,
    private readonly config: { enabled: boolean; relayUrl?: string; relaySecret?: string },
  ) {}

  preflight(ticket: PlatformSendCommand["ticket"]): void {
    if (ticket.platform !== this.platform) throw new SendError("Ticket platform does not match the send route", "PLATFORM_MISMATCH", 409);
    if (!this.config.enabled) throw new SendError("Rakuten R-Messe outbound send is disabled", "RAKUTEN_SEND_DISABLED", 503);
    if (!this.config.relayUrl || !this.config.relaySecret) {
      throw new SendError("Rakuten R-Messe relay is not configured", "RAKUTEN_RELAY_NOT_CONFIGURED", 503);
    }
  }

  async send(command: PlatformSendCommand): Promise<PlatformSendResult> {
    this.preflight(command.ticket);
    const result = await new RakutenRmesseSendService(this.repository, {
      relayUrl: this.config.relayUrl!,
      relaySecret: this.config.relaySecret!,
    }).send({
      ticket: command.ticket,
      message: command.message,
      clientOperationId: command.clientOperationId,
      replyIntent: command.replyIntent,
      lastSeenMessageAt: reviewedLastSeenAt(command.reviewed),
      sentBy: command.sentBy,
    });
    return { platform: this.platform, ...result };
  }
}
