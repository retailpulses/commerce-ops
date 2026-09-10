import { useState, useEffect } from "react";
import type { IssueType } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface IssueTypeEditorProps {
  open: boolean;
  onClose: () => void;
  issueTypes: IssueType[];
  selected: string[];
  onSave: (types: string[]) => void;
}

export function IssueTypeEditor({
  open,
  onClose,
  issueTypes,
  selected,
  onSave,
}: IssueTypeEditorProps) {
  const [localSelected, setLocalSelected] = useState<string[]>(selected);

  useEffect(() => {
    if (open) {
      setLocalSelected(selected);
    }
  }, [open, selected]);

  const toggle = (key: string) => {
    setLocalSelected((prev) =>
      prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key],
    );
  };

  const handleSave = () => {
    onSave(localSelected);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit Issue Types">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-muted">
          Select all applicable issue types for this ticket.
        </p>
        <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
          {issueTypes.map((it) => {
            const isChecked = localSelected.includes(it.key);
            return (
              <label
                key={it.key}
                className={`
                  flex items-center gap-3 rounded-md border px-3 py-2.5 cursor-pointer
                  transition-colors duration-150
                  ${isChecked
                    ? "border-accent bg-accent-bg/30"
                    : "border-border hover:bg-gray-50"
                  }
                `.trim()}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(it.key)}
                  className="size-4 rounded border-gray-300 text-accent focus:ring-accent/50"
                />
                <span className="text-sm text-text">{it.display_name}</span>
              </label>
            );
          })}
        </div>
        {issueTypes.length === 0 && (
          <p className="text-sm text-text-muted text-center py-4">
            No issue types available.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
