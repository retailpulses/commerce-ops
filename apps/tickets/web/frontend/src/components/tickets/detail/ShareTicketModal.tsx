import { useEffect, useState } from "react";
import type { Ticket, TicketAttachment, TicketShare } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import {
  useCreateTicketShare,
  useRevokeTicketShare,
  useRotateTicketShare,
  useTicketShares,
} from "@/hooks/useTickets";

interface ShareTicketModalProps {
  open: boolean;
  ticket: Ticket;
  attachments: TicketAttachment[];
  attachmentsLoading: boolean;
  onClose: () => void;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function formatJst(value: string | number | Date | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : jstFormatter.format(date);
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function operationId(): string {
  return crypto.randomUUID();
}

function AttachmentPreview({
  attachment,
  selected,
  onChange,
}: {
  attachment: TicketAttachment;
  selected: boolean;
  onChange: (selected: boolean) => void;
}) {
  const isVideo = attachment.mime_type?.startsWith("video/") ?? false;
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-2.5 hover:bg-gray-50">
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-accent"
      />
      <div className="size-14 shrink-0 overflow-hidden rounded bg-gray-100">
        {attachment.signed_url && isVideo ? (
          <video src={attachment.signed_url} className="size-full object-cover" muted preload="metadata" />
        ) : attachment.signed_url ? (
          <img
            src={attachment.signed_url}
            alt={attachment.filename ?? "Evidence preview"}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-xs text-text-muted">
            {isVideo ? "Video" : "Image"}
          </div>
        )}
      </div>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">
          {attachment.filename ?? "Unnamed evidence"}
        </span>
        <span className="block text-xs text-text-muted">
          {attachment.mime_type ?? attachment.media_type} · {formatSize(attachment.size_bytes)}
        </span>
      </span>
    </label>
  );
}

function ActiveShare({
  share,
  attachments,
  revoking,
  onCopy,
  onRevoke,
  onRotate,
}: {
  share: TicketShare;
  attachments: TicketAttachment[];
  revoking: boolean;
  onCopy: () => void;
  onRevoke: () => void;
  onRotate: () => void;
}) {
  const selectedNames = attachments
    .filter((attachment) => share.attachment_ids.includes(attachment.id))
    .map((attachment) => attachment.filename ?? attachment.id);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-success/30 bg-success-bg p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-green-800">Active seller link</span>
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
            Active
          </span>
        </div>
        <p className="mt-1 text-xs text-green-800">Expires {formatJst(share.expires_at)}</p>
      </div>

      <div>
        <label htmlFor="active-share-url" className="mb-1 block text-xs font-medium text-text-muted">
          Share URL
        </label>
        <div className="flex gap-2">
          <input
            id="active-share-url"
            readOnly
            value={share.url}
            className="min-w-0 flex-1 rounded-md border border-border bg-gray-50 px-3 py-2 font-mono text-xs text-text"
          />
          <Button onClick={onCopy}>Copy</Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border p-3 text-xs">
        <div><dt className="text-text-muted">Created</dt><dd className="font-medium text-text">{formatJst(share.created_at)}</dd></div>
        <div><dt className="text-text-muted">PII reviewed</dt><dd className="font-medium text-text">{formatJst(share.pii_reviewed_at)}</dd></div>
        <div><dt className="text-text-muted">Views</dt><dd className="font-medium text-text">{share.access_count}</dd></div>
        <div><dt className="text-text-muted">Last viewed</dt><dd className="font-medium text-text">{formatJst(share.last_accessed_at)}</dd></div>
      </dl>

      <div className="rounded-md border border-border p-3 text-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Shared description</p>
        <p className="mt-1 whitespace-pre-wrap text-text">{share.seller_description}</p>
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Shared evidence</p>
        <p className="mt-1 text-text">
          {selectedNames.length ? selectedNames.join(", ") : "No evidence files"}
        </p>
      </div>

      <p className="text-xs text-text-muted">
        Shared content cannot be edited in place. Rotate the link to change it; the current URL will stop working immediately.
      </p>
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Button variant="danger" loading={revoking} onClick={onRevoke}>Revoke now</Button>
        <Button variant="outline" disabled={revoking} onClick={onRotate}>Prepare replacement</Button>
      </div>
    </div>
  );
}

export function ShareTicketModal({
  open,
  ticket,
  attachments,
  attachmentsLoading,
  onClose,
}: ShareTicketModalProps) {
  const { toast } = useToast();
  const sharesQuery = useTicketShares(ticket.id, open);
  const createMutation = useCreateTicketShare();
  const rotateMutation = useRotateTicketShare();
  const revokeMutation = useRevokeTicketShare();
  const [rotating, setRotating] = useState(false);
  const [sellerDescription, setSellerDescription] = useState("");
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>([]);
  const [piiConfirmed, setPiiConfirmed] = useState(false);
  const [resultShare, setResultShare] = useState<TicketShare | null>(null);
  const [expectedExpiry, setExpectedExpiry] = useState(() => Date.now() + SEVEN_DAYS_MS);

  const queryActiveShare = sharesQuery.data?.active_share ?? null;
  const activeShare = resultShare ?? queryActiveShare;
  const editing = rotating || (!activeShare && !sharesQuery.isLoading);
  useEffect(() => {
    if (open) {
      setExpectedExpiry(Date.now() + SEVEN_DAYS_MS);
      // Seed seller description from ticket description as a fallback default.
      // Operators must still review and edit; the PII confirmation checkbox
      // is the safety gate before the link can be created.
      if (!activeShare && !rotating) {
        setSellerDescription(ticket.description ?? "");
        if (attachments.length > 0) {
          setSelectedAttachmentIds(attachments.map((a) => a.id));
        }
      }
    } else {
      setRotating(false);
      setSellerDescription("");
      setSelectedAttachmentIds([]);
      setPiiConfirmed(false);
      setResultShare(null);
    }
  }, [open]);

  const beginRotation = () => {
    if (!activeShare) return;
    setSellerDescription(activeShare.seller_description);
    setSelectedAttachmentIds(activeShare.attachment_ids);
    setPiiConfirmed(false);
    setExpectedExpiry(Date.now() + SEVEN_DAYS_MS);
    setRotating(true);
  };

  const toggleAttachment = (attachmentId: string, selected: boolean) => {
    setSelectedAttachmentIds((current) =>
      selected ? [...new Set([...current, attachmentId])] : current.filter((id) => id !== attachmentId),
    );
  };

  const submit = async () => {
    const description = sellerDescription.trim();
    if (!description || !piiConfirmed) return;
    const input = {
      client_operation_id: operationId(),
      seller_description: description,
      attachment_ids: selectedAttachmentIds,
      pii_confirmed: true as const,
    };
    try {
      const response = rotating
        ? await rotateMutation.mutateAsync({ ticketId: ticket.id, input })
        : await createMutation.mutateAsync({ ticketId: ticket.id, input });
      setResultShare(response.share);
      setRotating(false);
      setPiiConfirmed(false);
      toast(rotating ? "Seller link rotated" : "Seller link created", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not create seller link", "error");
    }
  };

  const copy = async () => {
    if (!activeShare) return;
    try {
      await navigator.clipboard.writeText(activeShare.url);
      toast("Seller link copied", "success");
    } catch {
      toast("Copy failed. Select and copy the URL manually.", "error");
    }
  };

  const revoke = async () => {
    if (!activeShare || !window.confirm("Revoke this seller link immediately? It cannot be restored.")) return;
    try {
      await revokeMutation.mutateAsync({ ticketId: ticket.id, shareId: activeShare.id });
      setResultShare(null);
      await sharesQuery.refetch();
      toast("Seller link revoked", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not revoke seller link", "error");
    }
  };

  const saving = createMutation.isPending || rotateMutation.isPending;

  return (
    <Modal open={open} onClose={saving ? () => undefined : onClose} title={`Share ticket #${ticket.ticket_number}`}>
      {sharesQuery.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : sharesQuery.error ? (
        <div className="rounded-md border border-danger/20 bg-danger-bg p-3 text-sm text-danger">
          Could not load share status. {sharesQuery.error instanceof Error ? sharesQuery.error.message : ""}
        </div>
      ) : activeShare && !rotating ? (
        <ActiveShare
          share={activeShare}
          attachments={attachments}
          revoking={revokeMutation.isPending}
          onCopy={copy}
          onRevoke={revoke}
          onRotate={beginRotation}
        />
      ) : editing ? (
        <div className="flex flex-col gap-4">
          {rotating && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
              Creating this replacement immediately revokes the existing URL.
            </div>
          )}

          <div>
            <label htmlFor="seller-description" className="mb-1 block text-sm font-medium text-text">
              Description for the seller
            </label>
            <textarea
              id="seller-description"
              rows={5}
              value={sellerDescription}
              onChange={(event) => setSellerDescription(event.target.value)}
              placeholder="Write a seller-facing summary. Do not paste the raw customer description."
              maxLength={5000}
              className="w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm text-text focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p className="mt-1 text-right text-xs text-text-muted">{sellerDescription.length}/5000</p>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-text">Evidence to share</legend>
            {attachmentsLoading ? (
              <div className="flex justify-center py-5"><Spinner /></div>
            ) : attachments.length ? (
              <div className="flex max-h-52 flex-col gap-2 overflow-y-auto">
                {attachments.map((attachment) => (
                  <AttachmentPreview
                    key={attachment.id}
                    attachment={attachment}
                    selected={selectedAttachmentIds.includes(attachment.id)}
                    onChange={(selected) => toggleAttachment(attachment.id, selected)}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-border p-3 text-xs text-text-muted">
                No evidence will be shared because this ticket has no attachments.
              </p>
            )}
          </fieldset>

          <div className="rounded-md border border-border bg-gray-50 p-3 text-xs text-text">
            <p className="font-semibold">Included</p>
            <p>Ticket/order summary, linked product information, the description above, and {selectedAttachmentIds.length} selected evidence file(s).</p>
            <p className="mt-2 font-semibold">Always excluded</p>
            <p>Buyer name/contact/address, raw ticket description, messages, notes, events, resolution actions, admin URLs, and internal cost/fulfillment pricing.</p>
          </div>

          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
            <p className="font-semibold">Valid for exactly 7 days (168 hours)</p>
            <p>Expected expiry: {formatJst(expectedExpiry)}. The final server-calculated JST expiry is shown after creation.</p>
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm text-text">
            <input
              type="checkbox"
              checked={piiConfirmed}
              onChange={(event) => setPiiConfirmed(event.target.checked)}
              className="mt-0.5 size-4 accent-accent"
            />
            <span>
              I reviewed the seller description and every selected file and confirm they contain no unnecessary buyer name, contact details, address, shipping label, screenshot, or other PII.
            </span>
          </label>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            {rotating && <Button variant="ghost" disabled={saving} onClick={() => setRotating(false)}>Cancel replacement</Button>}
            <Button
              variant={rotating ? "danger" : "primary"}
              loading={saving}
              disabled={!sellerDescription.trim() || !piiConfirmed || attachmentsLoading}
              onClick={submit}
            >
              {rotating ? "Revoke and create replacement" : "Create seller link"}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
