import { useState, useEffect, useCallback, useRef } from "react";
import {
  useCopywrite,
  useSendReply,
  useSaveDraft,
  useLoadDraft,
  useThread,
  useInspectAmazonSend,
  useResolveAmazonSend,
} from "@/hooks/useCopywriting";
import { ApiError } from "@/api/client";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { SendConfirmModal } from "./SendConfirmModal";

/* ------------------------------------------------------------------ */
/*  Chevron icon (inline SVG)                                          */
/* ------------------------------------------------------------------ */

function ChevronUp({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ComposerProps {
  ticketId: string;
  ticketPlatform: string;
  rakutenOutboundEnabled?: boolean;
  amazonOutboundEnabled?: boolean;
}

interface CachedDraft {
  draftBody: string;
  resolutionGuide: string;
  replyIntent: "terminal" | "holding";
}

/* ------------------------------------------------------------------ */
/*  Module-level draft cache — survives Composer unmount/mount cycles  */
/*  (e.g. when switching between Mercari and non-Mercari tickets)      */
/* ------------------------------------------------------------------ */

const draftCache = new Map<string, CachedDraft>();

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Composer({
  ticketId,
  ticketPlatform,
  rakutenOutboundEnabled = false,
  amazonOutboundEnabled = false,
}: ComposerProps) {
  const { toast } = useToast();

  /* ------------------------------------------------------------------ */
  /*  Mutations                                                         */
  /* ------------------------------------------------------------------ */

  const copywriteMutation = useCopywrite();
  const sendReplyMutation = useSendReply();
  const saveDraftMutation = useSaveDraft();
  const resolveAmazonSendMutation = useResolveAmazonSend();

  /* ------------------------------------------------------------------ */
  /*  Queries                                                           */
  /* ------------------------------------------------------------------ */

  const { data: draftData } = useLoadDraft(ticketId);
  const { data: threadData } = useThread(ticketId);

  /* ------------------------------------------------------------------ */
  /*  Local state                                                       */
  /* ------------------------------------------------------------------ */

  const [draftBody, setDraftBody] = useState("");
  const [resolutionGuide, setResolutionGuide] = useState("");
  const [showSendModal, setShowSendModal] = useState(false);
  const [replyIntent, setReplyIntent] = useState<"terminal" | "holding">("holding");
  const [threadLastSeenAt, setThreadLastSeenAt] = useState<string | null>(null);
  const [reviewedCustomerMessageId, setReviewedCustomerMessageId] = useState<string | null>(null);
  const [reviewedCustomerRevision, setReviewedCustomerRevision] = useState<string | null>(null);
  const [reviewedThreadRevision, setReviewedThreadRevision] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [recoveryOperationId, setRecoveryOperationId] = useState<string | null>(null);
  const recoveryInspection = useInspectAmazonSend(ticketId, recoveryOperationId);
  const recoveryData = recoveryInspection.data;
  const recoveryIsLoading = recoveryInspection.isLoading;
  const recoveryIsError = recoveryInspection.isError;
  const refetchRecovery = recoveryInspection.refetch;

  // Refs
  const stateRef = useRef({ draftBody, resolutionGuide, replyIntent });
  stateRef.current = { draftBody, resolutionGuide, replyIntent };
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);

  const getSendOperationId = useCallback((signature: string): string => {
    const storageKey = `ticket-send-operation:${ticketId}`;
    try {
      const existing = JSON.parse(sessionStorage.getItem(storageKey) || "null") as {
        signature?: string;
        id?: string;
      } | null;
      if (existing?.signature === signature && existing.id) return existing.id;
      const id = crypto.randomUUID();
      sessionStorage.setItem(storageKey, JSON.stringify({ signature, id }));
      return id;
    } catch {
      return crypto.randomUUID();
    }
  }, [ticketId]);

  const clearSendOperationId = useCallback(() => {
    try { sessionStorage.removeItem(`ticket-send-operation:${ticketId}`); } catch { /* unavailable */ }
  }, [ticketId]);

  /* ------------------------------------------------------------------ */
  /*  On ticketId change: save old state to cache, init new from cache  */
  /*  or from already-loaded draftData.                                  */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    const cached = draftCache.get(ticketId);

    if (cached) {
      // Restore unsaved edits from module cache
      setDraftBody(cached.draftBody);
      setResolutionGuide(cached.resolutionGuide);
      setReplyIntent(cached.replyIntent);
    } else if (draftData?.draft) {
      // First visit — seed from API-saved draft (may be in React Query cache)
      setDraftBody(draftData.draft.body);
      setResolutionGuide(draftData.draft.resolution_guide ?? "");
      setReplyIntent("holding");
    } else {
      // Fresh — no cache, no saved draft
      setDraftBody("");
      setResolutionGuide("");
      setReplyIntent("holding");
    }

    setThreadLastSeenAt(null);
    setReviewedCustomerMessageId(null);
    setReviewedThreadRevision(null);
    setShowSendModal(false);
    try {
      const saved = JSON.parse(sessionStorage.getItem(`ticket-send-operation:${ticketId}`) || "null") as { id?: string } | null;
      setRecoveryOperationId(ticketPlatform.trim().toLowerCase() === "amazon" && saved?.id ? saved.id : null);
    } catch {
      setRecoveryOperationId(null);
    }

    // On unmount (or ticketId change), persist current state to module cache
    return () => {
      draftCache.set(ticketId, stateRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  /* ------------------------------------------------------------------ */
  /*  When saved draft loads from API later (async), seed local state   */
  /*  only if there's no unsaved cache entry for this ticket.            */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (draftData?.draft && !draftCache.has(ticketId)) {
      setDraftBody(draftData.draft.body);
      setResolutionGuide(draftData.draft.resolution_guide ?? "");
      setReplyIntent("holding");
    }
  }, [draftData, ticketId]);

  /* ------------------------------------------------------------------ */
  /*  Set thread last-seen timestamp when thread loads                  */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (threadData?.messages) {
      setThreadLastSeenAt(threadData.latest_buyer_message_at);
      setReviewedCustomerMessageId(threadData.latest_buyer_message_id);
      setReviewedCustomerRevision(threadData.latest_customer_revision);
      setReviewedThreadRevision(threadData.latest_thread_revision);
    }
  }, [threadData]);

  /* ------------------------------------------------------------------ */
  /*  Derived values                                                    */
  /* ------------------------------------------------------------------ */

  const messageCount = threadData?.messages?.length ?? 0;
  const hasFetchError = !!threadData?.fetch_error;
  const charCount = draftBody.length;
  const normalizedPlatform = ticketPlatform.trim().toLowerCase();
  const canSend = normalizedPlatform === "mercari" ||
    (normalizedPlatform === "rakuten" && rakutenOutboundEnabled) ||
    (normalizedPlatform === "amazon" && amazonOutboundEnabled && !!reviewedCustomerMessageId && !!reviewedCustomerRevision && !!reviewedThreadRevision &&
      !!threadLastSeenAt && !!threadData?.reply_context);
  const sendDisabledReason = normalizedPlatform === "rakuten" && !rakutenOutboundEnabled
    ? "Rakuten R-Messe sending is currently disabled"
    : normalizedPlatform === "amazon" && !amazonOutboundEnabled
      ? "Amazon Zoho sending is currently disabled"
      : normalizedPlatform === "amazon" && (!reviewedCustomerMessageId || !reviewedCustomerRevision || !reviewedThreadRevision || !threadLastSeenAt)
        ? "Refresh the authenticated Amazon customer message before sending"
        : normalizedPlatform === "amazon" && !threadData?.reply_context
          ? "Amazon reply target could not be resolved server-side"
        : "API send is not supported for this platform";
  const charCountColor =
    charCount >= 500
      ? "text-danger"
      : charCount >= 400
        ? "text-yellow-600"
        : "text-text-muted";

  /* ------------------------------------------------------------------ */
  /*  Auto-focus draft textarea when composer expands                   */
  /* ------------------------------------------------------------------ */

  useEffect(() => {
    if (isExpanded && draftTextareaRef.current) {
      // Small delay so the browser has laid out the expanded panel
      const timer = setTimeout(() => {
        draftTextareaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isExpanded]);

  /* ------------------------------------------------------------------ */
  /*  Handlers                                                          */
  /* ------------------------------------------------------------------ */

  const handleExpand = useCallback(() => {
    setIsExpanded(true);
  }, []);

  const handleCollapse = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const handleCopywrite = useCallback(async () => {
    try {
      const result = await copywriteMutation.mutateAsync({
        ticketId,
        guide: resolutionGuide || undefined,
      });
      setDraftBody(result.reply);
      toast("AI reply generated", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate reply";
      toast(message, "error");
    }
  }, [copywriteMutation, ticketId, resolutionGuide, toast]);

  const handleSaveDraft = useCallback(async () => {
    try {
      await saveDraftMutation.mutateAsync({
        ticketId,
        body: draftBody,
        guide: resolutionGuide || undefined,
      });
      toast("Draft saved", "success");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save draft";
      toast(message, "error");
    }
  }, [saveDraftMutation, ticketId, draftBody, resolutionGuide, toast]);

  const handleSend = useCallback(async () => {
    if (!canSend) {
      toast(sendDisabledReason, "info");
      return;
    }
    let operationId = "";
    try {
      const operationSignature = JSON.stringify([ticketId, draftBody, replyIntent]);
      operationId = getSendOperationId(operationSignature);
      const result = await sendReplyMutation.mutateAsync({
        ticketId,
        message: draftBody,
        intent: replyIntent,
        clientOperationId: operationId,
        lastSeenAt: threadLastSeenAt ?? undefined,
        reviewedCustomerMessageId: reviewedCustomerMessageId ?? undefined,
        reviewedCustomerRevision: reviewedCustomerRevision ?? undefined,
        reviewedThreadRevision: reviewedThreadRevision ?? undefined,
      });

      if (result.warning) {
        toast(`Warning: ${result.warning}`, "info");
      }

      if (result.success) {
        clearSendOperationId();
        setDraftBody("");
        setResolutionGuide("");
        setShowSendModal(false);
        toast("Reply sent!", "success");
      } else if (result.error) {
        toast(result.error.message, "error");
      } else {
        toast("Failed to send reply", "error");
      }
    } catch (err) {
      if (err instanceof ApiError && (err.code === "DELIVERY_UNCONFIRMED" || err.code === "SEND_IN_PROGRESS")) {
        setRecoveryOperationId(operationId);
      }
      const message =
        err instanceof Error ? err.message : "Failed to send reply";
      toast(message, "error");
    }
  }, [canSend, sendDisabledReason, sendReplyMutation, ticketId, draftBody, replyIntent, threadLastSeenAt, reviewedCustomerMessageId, reviewedCustomerRevision, reviewedThreadRevision, toast, getSendOperationId, clearSendOperationId]);

  const resolveAmazonSend = useCallback(async (
    resolution: "confirmed_sent" | "confirmed_not_sent",
    platformMessageId?: string,
  ) => {
    const activeOperationId = recoveryData?.clientOperationId || recoveryOperationId;
    if (!activeOperationId) return;
    try {
      const result = await resolveAmazonSendMutation.mutateAsync({
        ticketId, clientOperationId: activeOperationId, resolution, platformMessageId,
      });
      if (result.resolution === "settlement_pending") {
        await refetchRecovery();
        toast(
          `No Sent match recorded. The provider settlement lease remains locked${result.eligibleAfter ? ` until at least ${new Date(result.eligibleAfter).toLocaleString()}` : ""}.`,
          "info",
        );
        return;
      }
      clearSendOperationId();
      setRecoveryOperationId(null);
      setShowSendModal(false);
      if (resolution === "confirmed_sent") {
        setDraftBody("");
        setResolutionGuide("");
        toast("Sent reply confirmed", "success");
      } else {
        toast("No provider send confirmed. Review the latest thread before trying again.", "info");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to resolve send", "error");
    }
  }, [recoveryOperationId, recoveryData?.clientOperationId, refetchRecovery, resolveAmazonSendMutation, ticketId, clearSendOperationId, toast]);

  /* ------------------------------------------------------------------ */
  /*  Keyboard shortcut: Ctrl/Cmd + Enter in draft editor               */
  /* ------------------------------------------------------------------ */

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (draftBody.trim()) {
          setShowSendModal(true);
        }
      }
    },
    [draftBody],
  );

  /* ------------------------------------------------------------------ */
  /*  Thread status badge                                               */
  /* ------------------------------------------------------------------ */

  const renderThreadStatus = () => {
    if (hasFetchError) {
      return (
        <span className="text-xs text-danger bg-danger-bg rounded px-1.5 py-0.5">
          manual only
        </span>
      );
    }
    if (messageCount > 0) {
      return (
        <span className="text-xs text-text-muted bg-gray-100 rounded px-1.5 py-0.5">
          {messageCount} msgs
        </span>
      );
    }
    return null;
  };

  /* ------------------------------------------------------------------ */
  /*  Render                                                            */
  /* ------------------------------------------------------------------ */

  return (
    <div className="border-t border-border bg-surface">
      {/* ── Collapsed: compact reply bar ── */}
      {!isExpanded ? (
        <div className="flex items-center justify-between px-4 py-2 gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-text">Reply</h3>
            {renderThreadStatus()}
            {draftBody.trim() && (
              <span className="text-xs text-text-muted bg-gray-100 rounded px-1.5 py-0.5">
                Draft ({draftBody.length} chars)
              </span>
            )}
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleExpand}
          >
            Compose Reply
          </Button>
        </div>
      ) : (
        /* ── Expanded: full composer ── */
        <div className="p-4 space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text">
              Response Composer
            </h3>
            <div className="flex items-center gap-2">
              {renderThreadStatus()}
              <button
                type="button"
                onClick={handleCollapse}
                className="text-text-muted hover:text-text cursor-pointer transition-colors"
                title="Hide composer"
              >
                <ChevronUp />
              </button>
            </div>
          </div>

          {/* Required response instructions */}
          <textarea
            value={resolutionGuide}
            onChange={(e) => setResolutionGuide(e.target.value)}
            placeholder="Required response instructions — amounts, deadlines, conditions, and proposed resolution will be preserved..."
            className="w-full rounded border border-border bg-white p-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-accent/50"
            rows={2}
          />

          {/* Copywrite button */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopywrite}
              loading={copywriteMutation.isPending}
              disabled={copywriteMutation.isPending}
            >
              Copywrite (OpenAI)
            </Button>
          </div>

          {/* Draft editor textarea */}
          <textarea
            ref={draftTextareaRef}
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            placeholder="Draft reply message..."
            className="w-full rounded border border-border bg-white p-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-accent/50"
            style={{ minHeight: "100px" }}
            rows={5}
          />

          {/* Bottom bar: char count + actions */}
          {recoveryOperationId && (
            <div className="rounded border border-yellow-300 bg-yellow-50 p-3 text-xs space-y-2">
              <p className="font-semibold text-yellow-900">Amazon send requires reconciliation</p>
              {recoveryIsLoading ? (
                <p className="text-text-muted">Checking the authoritative Zoho Sent folder…</p>
              ) : recoveryIsError ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-danger">Could not inspect the active send lease.</p>
                  <Button size="sm" variant="outline" onClick={() => refetchRecovery()}>Retry inspection</Button>
                </div>
              ) : recoveryData?.deliveryStatus === "sending" ? (
                <div className="flex items-center justify-between gap-2">
                  <p>The original send worker is still active. No recovery action is allowed yet.</p>
                  <Button size="sm" variant="outline" onClick={() => refetchRecovery()}>Refresh status</Button>
                </div>
              ) : recoveryData?.candidates.length ? (
                <div className="space-y-2">
                  <p>Select the exact matching Sent record:</p>
                  {recoveryData.candidates.map((candidate) => (
                    <div key={candidate.platformMessageId} className="flex items-center justify-between gap-2">
                      <span>…{candidate.platformMessageId.slice(-6)} · {new Date(candidate.sentAt).toLocaleString()}</span>
                      <Button size="sm" variant="outline" disabled={resolveAmazonSendMutation.isPending}
                        onClick={() => resolveAmazonSend("confirmed_sent", candidate.platformMessageId)}>
                        Confirm sent
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <p>
                    No matching Sent record was found in the fresh readback.
                    {recoveryData?.providerMutationStartedAt && (
                      <> The lease remains locked until the settlement checks complete.</>
                    )}
                  </p>
                  <Button size="sm" variant="outline" disabled={resolveAmazonSendMutation.isPending}
                    onClick={() => resolveAmazonSend("confirmed_not_sent")}>
                    {recoveryData?.providerMutationStartedAt ? "Record zero-match check" : "Confirm not sent"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            {/* Character count */}
            <span className={`text-xs ${charCountColor}`}>
              {charCount} / 500
            </span>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-text-muted select-none">
                <input
                  type="checkbox"
                  checked={replyIntent === "terminal"}
                  onChange={(e) =>
                    setReplyIntent(e.target.checked ? "terminal" : "holding")
                  }
                  className="accent-accent"
                />
                Final reply (clear Needs Reply)
              </label>

              <Button
                variant="secondary"
                size="sm"
                onClick={handleSaveDraft}
                loading={saveDraftMutation.isPending}
                disabled={!draftBody.trim()}
              >
                Save Draft
              </Button>

              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowSendModal(true)}
                disabled={!canSend || !draftBody.trim()}
                title={!canSend ? sendDisabledReason : ""}
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Send confirmation modal */}
      <SendConfirmModal
        open={showSendModal}
        onClose={() => setShowSendModal(false)}
        message={draftBody}
        intent={replyIntent}
        onIntentChange={setReplyIntent}
        onConfirm={handleSend}
        isLoading={sendReplyMutation.isPending}
        platform={ticketPlatform}
        replyContext={threadData?.reply_context ?? null}
      />
    </div>
  );
}
