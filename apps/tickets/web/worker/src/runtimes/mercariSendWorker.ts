import { getSupabaseClient } from "../repositories/supabase";
import { SupabaseCopywritingRepository } from "../repositories/supabaseCopywritingRepository";
import { SupabaseTicketRepository } from "../repositories/supabaseTicketRepository";
import { SHOP_TOKENS, normalizeShopName } from "../config/shops";
import { MessageSendService } from "../services/messageSendService";
import { SendError } from "../services/sendError";
import { MercariSendAdapter } from "../services/mercariSendAdapter";
import type { Env } from "../types";
import { createProviderWorker } from "./providerWorker";

function transactionId(orderId: string): string {
  const trimmed = orderId.trim();
  const match = trimmed.match(/order_transaction\/([^/?]+)/);
  if (match) return match[1];
  if (/^\d+$/.test(trimmed)) return `m${trimmed}`;
  if (trimmed) return trimmed;
  throw new SendError("Mercari transaction identity is invalid", "INVALID_ORDER_ID", 400);
}

export default createProviderWorker("mercari", (env: Env) => {
  const supabase = getSupabaseClient(env);
  const ticketRepo = new SupabaseTicketRepository(supabase);
  const service = new MessageSendService(ticketRepo, new SupabaseCopywritingRepository(supabase));
  return new MercariSendAdapter(service, async (ticket) => {
    if (!ticket.account_id) throw new SendError("Mercari account is missing", "NO_ACCOUNT", 400);
    const { data: account } = await supabase.from("platform_accounts").select("shop_code, display_name, platform").eq("id", ticket.account_id).single();
    if (!account || account.platform !== "mercari") throw new SendError("Mercari account mismatch", "NOT_MERCARI", 409);
    const shopCode = String(account.shop_code || account.display_name || "");
    const canonical = normalizeShopName(shopCode);
    const key = canonical ? SHOP_TOKENS[canonical] : undefined;
    const token = key ? env[key] as string | undefined : undefined;
    if (!token) throw new SendError("Mercari credential is unavailable", "TOKEN_NOT_SET", 503);
    return { token, transactionId: transactionId(ticket.external_order_id || "") };
  }, env.MERCARI_OUTBOUND_ENABLED === "true");
});
