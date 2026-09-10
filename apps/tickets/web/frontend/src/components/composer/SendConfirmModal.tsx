import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SendConfirmModalProps {
  open: boolean;
  onClose: () => void;
  message: string;
  intent: "terminal" | "holding";
  onIntentChange: (intent: "terminal" | "holding") => void;
  onConfirm: () => void;
  isLoading: boolean;
  platform?: string;
  replyContext?: { from_address: string; to_address_masked: string; subject: string } | null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function SendConfirmModal({
  open,
  onClose,
  message,
  intent,
  onIntentChange,
  onConfirm,
  isLoading,
  platform = "Mercari",
  replyContext = null,
}: SendConfirmModalProps) {
  const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);
  return (
    <Modal open={open} onClose={onClose} title={`Confirm Send to ${platformLabel}`}>
      <div className="space-y-4">
        {/* Message preview */}
        {replyContext && (
          <div className="rounded border border-border bg-gray-50 p-3 text-sm space-y-1">
            <div><span className="text-text-muted">From:</span> {replyContext.from_address}</div>
            <div><span className="text-text-muted">To:</span> {replyContext.to_address_masked}</div>
            <div><span className="text-text-muted">Subject:</span> {replyContext.subject}</div>
          </div>
        )}
        <div>
          <p className="text-text-muted text-sm mb-1">Message preview:</p>
          <div className="max-h-[200px] overflow-y-auto rounded border border-border bg-gray-50 p-3 text-sm whitespace-pre-wrap">
            {message}
          </div>
        </div>

        {/* Reply intent */}
        <div>
          <p className="text-text-muted text-sm mb-2">Reply intent:</p>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="intent"
              checked={intent === "terminal"}
              onChange={() => onIntentChange("terminal")}
              className="accent-accent"
            />
            <span className="text-sm">Final reply (clear Needs Reply)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer mt-1">
            <input
              type="radio"
              name="intent"
              checked={intent === "holding"}
              onChange={() => onIntentChange("holding")}
              className="accent-accent"
            />
            <span className="text-sm">Holding reply (keep Needs Reply active)</span>
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={isLoading}>
            Confirm Send
          </Button>
        </div>
      </div>
    </Modal>
  );
}
