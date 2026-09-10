import { useEffect, useState } from "react";
import type { Ticket, AfterSalesLink } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useGenerateAfterSalesLink } from "@/hooks/useTickets";

interface GenerateFormLinkModalProps {
  open: boolean;
  ticket: Ticket;
  onClose: () => void;
}

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatJst(value: string | number | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : jstFormatter.format(date);
}

export function GenerateFormLinkModal({
  open,
  ticket,
  onClose,
}: GenerateFormLinkModalProps) {
  const { toast } = useToast();
  const mutation = useGenerateAfterSalesLink();
  const [link, setLink] = useState<AfterSalesLink | null>(null);

  // Generate link automatically when the modal opens
  useEffect(() => {
    if (open) {
      setLink(null);
      mutation.mutate(
        { ticketId: ticket.id },
        {
          onSuccess: (data) => setLink(data),
          onError: (error) =>
            toast(
              error instanceof Error ? error.message : "Could not generate form link",
              "error",
            ),
        },
      );
    } else {
      setLink(null);
    }
    // Only run on open change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast("Form link copied", "success");
    } catch {
      toast("Copy failed. Select and copy the URL manually.", "error");
    }
  };

  const loading = mutation.isPending;

  return (
    <Modal open={open} onClose={loading ? () => undefined : onClose} title="Buyer Evidence Form Link">
      <div className="flex flex-col gap-4">
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : mutation.error ? (
          <div className="rounded-md border border-danger/20 bg-danger-bg p-3 text-sm text-danger">
            Could not generate form link.{" "}
            {mutation.error instanceof Error ? mutation.error.message : "Please try again."}
          </div>
        ) : link ? (
          <>
            <div>
              <label htmlFor="form-link-url" className="mb-1 block text-xs font-medium text-text-muted">
                Share this URL with the buyer
              </label>
              <div className="flex gap-2">
                <input
                  id="form-link-url"
                  readOnly
                  value={link.url}
                  className="min-w-0 flex-1 rounded-md border border-border bg-gray-50 px-3 py-2 font-mono text-xs text-text"
                />
                <Button onClick={copy}>Copy</Button>
              </div>
            </div>

            <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
              <p className="font-semibold">Valid for 30 days · Single-use</p>
              <p className="mt-1">
                Expires {formatJst(link.expires_at)}. Once the buyer submits, the
                link is consumed and cannot be reused.
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-border p-3 text-xs">
              <div>
                <dt className="text-text-muted">Platform</dt>
                <dd className="font-medium text-text">{link.platform}</dd>
              </div>
              <div>
                <dt className="text-text-muted">Order</dt>
                <dd className="font-medium text-text">
                  {link.external_order_id ?? "—"}
                </dd>
              </div>
            </dl>

            <p className="text-xs text-text-muted">
              The buyer will see a mobile-friendly Japanese form where they can
              describe the issue, state their desired resolution, and upload up to
              5 photos or videos (100 MB each).
            </p>

            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={copy}>
                Copy link
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
