import type { TicketDetail } from "../repositories/ticketRepository";
import { MessageSendService, SendError } from "./messageSendService";
import type { PlatformSendAdapter, PlatformSendCommand, PlatformSendResult } from "./platformSendRouter";
import { reviewedLastSeenAt } from "./platformSendRouter";

export class MercariSendAdapter implements PlatformSendAdapter {
  readonly platform = "mercari" as const;

  constructor(
    private readonly service: MessageSendService,
    private readonly resolveProvider: (ticket: TicketDetail) => Promise<{ token: string; transactionId: string }>,
    private readonly enabled: boolean,
  ) {}

  preflight(ticket: TicketDetail): void {
    if (ticket.platform !== this.platform) throw new SendError("Ticket platform does not match the send route", "PLATFORM_MISMATCH", 409);
    if (!this.enabled) throw new SendError("Mercari outbound send is disabled", "MERCARI_SEND_DISABLED", 503);
  }

  async send(command: PlatformSendCommand): Promise<PlatformSendResult> {
    this.preflight(command.ticket);
    const provider = await this.resolveProvider(command.ticket);
    const result = await this.service.sendReply({
      ticket: command.ticket,
      mercariToken: provider.token,
      transactionId: provider.transactionId,
      message: command.message,
      clientOperationId: command.clientOperationId,
      replyIntent: command.replyIntent,
      lastSeenMessageAt: reviewedLastSeenAt(command.reviewed),
      sentBy: command.sentBy,
    });
    return {
      platform: this.platform,
      platformMessageId: result.platformMessageId,
      sentAt: result.sentAt,
      ticketMessage: result.ticketMessage,
      replayed: result.replayed,
      warning: result.warning,
      warningCode: result.warningCode,
    };
  }
}
