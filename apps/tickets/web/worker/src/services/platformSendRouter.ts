import type { TicketDetail, TicketMessage } from "../repositories/ticketRepository";
import { SendError } from "./sendError";

export type SendPlatform = "mercari" | "rakuten" | "amazon";

export interface PlatformSendCommand {
  ticket: TicketDetail;
  message: string;
  clientOperationId: string;
  replyIntent: "terminal" | "holding";
  reviewed: unknown;
  sentBy: string | null;
}

export interface PlatformSendResult {
  platform: SendPlatform;
  platformMessageId: string;
  sentAt: string;
  ticketMessage: TicketMessage;
  replayed: boolean;
  warning?: string;
  warningCode?: string;
}

export interface PlatformSendAdapter {
  readonly platform: SendPlatform;
  preflight(ticket: TicketDetail): void | Promise<void>;
  send(command: PlatformSendCommand): Promise<PlatformSendResult>;
}

export class PlatformSendRouter {
  private readonly adapters: Map<SendPlatform, PlatformSendAdapter>;

  constructor(adapters: PlatformSendAdapter[]) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.platform)) throw new Error(`Duplicate send adapter: ${adapter.platform}`);
      this.adapters.set(adapter.platform, adapter);
    }
  }

  async send(command: PlatformSendCommand): Promise<PlatformSendResult> {
    const platform = command.ticket.platform as SendPlatform;
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new SendError(`API send is not supported for ${command.ticket.platform}`, "PLATFORM_SEND_UNSUPPORTED", 400);
    }
    const result = await adapter.send(command);
    if (result.platform !== adapter.platform) {
      throw new SendError("Platform adapter returned a mismatched result", "PLATFORM_RESULT_MISMATCH", 500);
    }
    return result;
  }

  async preflight(ticket: TicketDetail): Promise<void> {
    const adapter = this.adapters.get(ticket.platform as SendPlatform);
    if (!adapter) throw new SendError(`API send is not supported for ${ticket.platform}`, "PLATFORM_SEND_UNSUPPORTED", 400);
    await adapter.preflight(ticket);
  }
}

export function reviewedLastSeenAt(reviewed: unknown): string | undefined {
  if (!reviewed || typeof reviewed !== "object") return undefined;
  const value = (reviewed as Record<string, unknown>).lastSeenMessageAt;
  return typeof value === "string" ? value : undefined;
}
