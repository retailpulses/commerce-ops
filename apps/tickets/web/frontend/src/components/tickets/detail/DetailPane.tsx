import { useState, useCallback, useEffect } from "react";
import type {
  TicketDetail,
  IssueType,
  ProductSearchResult,
} from "@/api/types";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import {
  useTicketDetail,
  useUpdateTicket,
  useLinkProduct,
  useUnlinkProduct,
  useAddNote,
  useUpdateNote,
  useIssueTypes,
  useStatuses,
  useAttachments,
  useUploadAttachment,
  useDeleteAttachment,
  useRecordResolution,
  useOrderContext,
} from "@/hooks/useTickets";
import { useThread } from "@/hooks/useCopywriting";

import { DetailToolbar } from "./DetailToolbar";
import { DetailGrid } from "./DetailGrid";
import { EventsTab } from "./EventsTab";
import { MessagesTab } from "./MessagesTab";
import { NotesTab } from "./NotesTab";
import { ProductsTab } from "./ProductsTab";
import { DescriptionTab } from "./DescriptionTab";
import { AttachmentsTab } from "./AttachmentsTab";
import { ResolutionTab } from "./ResolutionTab";
import { ShareTicketModal } from "./ShareTicketModal";
import { GenerateFormLinkModal } from "./GenerateFormLinkModal";
import { Composer } from "@/components/composer/Composer";
import { OrderContextCard } from "./OrderContextCard";

interface DetailPaneProps {
  ticketId: string | null;
  onBack?: () => void;
}

const TABS = [
  { key: "events", label: "Events" },
  { key: "messages", label: "Messages" },
  { key: "notes", label: "Notes" },
  { key: "products", label: "Products" },
  { key: "attachments", label: "Evidence" },
  { key: "resolution", label: "Resolution" },
  { key: "description", label: "Description" },
];

export function DetailPane({ ticketId, onBack }: DetailPaneProps) {
  const [activeTab, setActiveTab] = useState("events");
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [formLinkModalOpen, setFormLinkModalOpen] = useState(false);
  const [ticketSharesEnabled, setTicketSharesEnabled] = useState(false);
  const [rakutenOutboundEnabled, setRakutenOutboundEnabled] = useState(false);
  const [amazonOutboundEnabled, setAmazonOutboundEnabled] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    fetch("/tickets/api/ticketing/health", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((health: {
        ticket_shares_enabled?: unknown;
        rakuten_rmesse_outbound_enabled?: unknown;
        amazon_mail_outbound_enabled?: unknown;
      } | null) => {
        setTicketSharesEnabled(health?.ticket_shares_enabled === true);
        setRakutenOutboundEnabled(health?.rakuten_rmesse_outbound_enabled === true);
        setAmazonOutboundEnabled(health?.amazon_mail_outbound_enabled === true);
      })
      .catch(() => {
        setTicketSharesEnabled(false);
        setRakutenOutboundEnabled(false);
        setAmazonOutboundEnabled(false);
      });
    return () => controller.abort();
  }, []);

  // Queries
  const { data: detailData, isLoading: ticketLoading, error: ticketError } =
    useTicketDetail(ticketId);
  const { data: issueTypesData } = useIssueTypes();
  const { data: statusesData } = useStatuses();
  const { data: threadData } = useThread(ticketId);
  const { data: attachmentData, isLoading: attachmentsLoading } = useAttachments(ticketId);

  // Mutations
  const updateMutation = useUpdateTicket();
  const linkMutation = useLinkProduct();
  const unlinkMutation = useUnlinkProduct();
  const addNoteMutation = useAddNote();
  const updateNoteMutation = useUpdateNote();
  const uploadAttachmentMutation = useUploadAttachment();
  const deleteAttachmentMutation = useDeleteAttachment();
  const resolutionMutation = useRecordResolution();

  // Derived data
  const ticket: TicketDetail | undefined = detailData?.ticket;
  const events = detailData?.events ?? [];
  const issueTypes: IssueType[] = issueTypesData?.issue_types ?? [];
  const statuses = statusesData?.statuses ?? [];
  const threadMessages = threadData?.messages ?? [];
  const attachments = attachmentData?.attachments ?? [];
  const orderContext = useOrderContext(ticketId, Boolean(ticket?.external_order_id));

  // Field change handler
  const handleFieldChange = useCallback(
    (field: string, value: unknown) => {
      if (!ticket) return;
      updateMutation.mutate(
        { id: ticket.id, input: { [field]: value } as Record<string, unknown> },
        { onError: () => toast("Failed to update field", "error") },
      );
    },
    [ticket, updateMutation, toast],
  );

  // Issue types change handler
  const handleIssueTypesChange = useCallback(
    (types: string[]) => {
      if (!ticket) return;
      updateMutation.mutate(
        { id: ticket.id, input: { issue_types: types } },
        {
          onSuccess: () => toast("Issue types updated", "success"),
          onError: () => toast("Failed to update issue types", "error"),
        },
      );
    },
    [ticket, updateMutation, toast],
  );

  // Link product handler
  const handleLinkProduct = useCallback(
    async (product: ProductSearchResult) => {
      if (!ticket) return;
      try {
        await linkMutation.mutateAsync({
          ticketId: ticket.id,
          product,
        });
        toast("Product linked", "success");
      } catch {
        toast("Failed to link product", "error");
        throw new Error("Link failed"); // re-throw so modal stays open
      }
    },
    [ticket, linkMutation, toast],
  );

  // Unlink product handler
  const handleUnlinkProduct = useCallback(
    async (productId: string) => {
      if (!ticket) return;
      await unlinkMutation.mutateAsync({
        ticketId: ticket.id,
        productId,
      });
      toast("Product unlinked", "success");
    },
    [ticket, unlinkMutation, toast],
  );

  // Add note handler
  const handleAddNote = useCallback(
    async (body: string) => {
      if (!ticket) return;
      await addNoteMutation.mutateAsync({
        ticketId: ticket.id,
        body,
      });
      toast("Note added", "success");
    },
    [ticket, addNoteMutation, toast],
  );

  const handleUpdateNote = useCallback(async (noteId: string, body: string) => {
    if (!ticket) return;
    await updateNoteMutation.mutateAsync({ ticketId: ticket.id, noteId, body });
    toast("Note updated", "success");
  }, [ticket, updateNoteMutation, toast]);

  // Description change handler
  const handleDescriptionChange = useCallback(
    async (description: string) => {
      if (!ticket) return;
      await updateMutation.mutateAsync({
        id: ticket.id,
        input: { description },
      });
      toast("Description updated", "success");
    },
    [ticket, updateMutation, toast],
  );

  const handleUploadAttachment = useCallback(async (file: File) => {
    if (!ticket) return;
    await uploadAttachmentMutation.mutateAsync({ ticketId: ticket.id, file });
    toast("Evidence uploaded", "success");
  }, [ticket, uploadAttachmentMutation, toast]);

  const handleDeleteAttachment = useCallback(async (attachmentId: string) => {
    if (!ticket) return;
    await deleteAttachmentMutation.mutateAsync({ ticketId: ticket.id, attachmentId });
    toast("Evidence removed", "success");
  }, [ticket, deleteAttachmentMutation, toast]);

  const handleRecordResolution = useCallback(async (input: import("@/api/types").CreateResolutionInput) => {
    if (!ticket) return;
    await resolutionMutation.mutateAsync({ ticketId: ticket.id, input });
    toast(input.close_ticket ? "Outcome recorded and ticket closed" : "Outcome recorded", "success");
  }, [ticket, resolutionMutation, toast]);

  // ── Empty state ──
  if (!ticketId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState message="Select a ticket to view details" />
      </div>
    );
  }

  // ── Loading state ──
  if (ticketLoading) {
    return (
      <div className="flex-1 flex flex-col gap-4 p-4">
        <Skeleton height="2rem" width="60%" />
        <Skeleton height="1rem" width="80%" />
        <Skeleton height="1rem" width="40%" />
        <div className="grid grid-cols-2 gap-4 mt-4">
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
          <Skeleton height="2.5rem" />
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (ticketError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-danger text-center font-medium">
          Failed to load ticket details
        </p>
        <p className="text-xs text-text-muted text-center max-w-sm break-all">
          {ticketError instanceof Error ? ticketError.message : String(ticketError)}
        </p>
        <p className="text-xs text-text-muted/60 text-center">
          Ticket ID: {ticketId}
        </p>
      </div>
    );
  }

  // ── Empty state (no error, but no ticket data) ──
  if (!ticket) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState message="No ticket data available." />
      </div>
    );
  }

  // ── Loaded state ──
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <DetailToolbar
        ticket={ticket}
        onBack={onBack}
        onShare={ticketSharesEnabled ? () => setShareModalOpen(true) : undefined}
        onGenerateFormLink={
          ticket.platform === "mercari" ? () => setFormLinkModalOpen(true) : undefined
        }
      />
      {ticketSharesEnabled && (
        <ShareTicketModal
          open={shareModalOpen}
          ticket={ticket}
          attachments={attachments}
          attachmentsLoading={attachmentsLoading}
          onClose={() => setShareModalOpen(false)}
        />
      )}
      <GenerateFormLinkModal
        open={formLinkModalOpen}
        ticket={ticket}
        onClose={() => setFormLinkModalOpen(false)}
      />
      <DetailGrid
        ticket={ticket}
        issueTypes={issueTypes}
        statuses={statuses}
        onFieldChange={handleFieldChange}
        onIssueTypesChange={handleIssueTypesChange}
      />
      {ticket.external_order_id && (
        <OrderContextCard
          order={orderContext.data?.order}
          isLoading={orderContext.isLoading}
          unavailable={orderContext.isError}
        />
      )}
      <Tabs
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <div
        className={`flex-1 min-h-0 ${
          activeTab === "messages" ? "overflow-hidden" : "overflow-y-auto"
        }`}
      >
        {activeTab === "events" && <EventsTab events={events} />}
        {activeTab === "messages" && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <MessagesTab
                threadMessages={threadMessages}
                ticketMessages={ticket.messages ?? []}
                isMercari={["mercari", "rakuten"].includes(
                  ticket.platform.trim().toLowerCase(),
                )}
              />
            </div>
            <Composer
              ticketId={ticket.id}
              ticketPlatform={ticket.platform}
              rakutenOutboundEnabled={rakutenOutboundEnabled}
              amazonOutboundEnabled={amazonOutboundEnabled}
            />
          </div>
        )}
        {activeTab === "notes" && (
          <NotesTab
            notes={ticket.notes ?? []}
            onAddNote={handleAddNote}
            onUpdateNote={handleUpdateNote}
          />
        )}
        {activeTab === "products" && (
          <ProductsTab
            products={ticket.products ?? []}
            onLinkProduct={handleLinkProduct}
            onUnlinkProduct={handleUnlinkProduct}
          />
        )}
        {activeTab === "description" && (
          <DescriptionTab
            ticket={ticket}
            issueTypes={issueTypes}
            onDescriptionChange={handleDescriptionChange}
            onIssueTypesChange={handleIssueTypesChange}
            customerSubmissions={ticket.customer_submissions}
          />
        )}
        {activeTab === "attachments" && (
          <AttachmentsTab
            attachments={attachments}
            isLoading={attachmentsLoading}
            onUpload={handleUploadAttachment}
            onDelete={handleDeleteAttachment}
          />
        )}
        {activeTab === "resolution" && (
          <ResolutionTab
            actions={ticket.resolution_actions ?? []}
            isSaving={resolutionMutation.isPending}
            onRecord={handleRecordResolution}
          />
        )}
        {/* Mutation loading indicator */}
        {(updateMutation.isPending ||
          linkMutation.isPending ||
          unlinkMutation.isPending ||
          addNoteMutation.isPending) && (
          <div className="flex items-center justify-center gap-2 px-4 py-2 border-t border-border">
            <Spinner className="size-3.5" />
            <span className="text-xs text-text-muted">Saving...</span>
          </div>
        )}
      </div>
    </div>
  );
}
