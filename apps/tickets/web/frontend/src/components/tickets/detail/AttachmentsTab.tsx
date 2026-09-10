import { useRef, useState } from "react";
import type { TicketAttachment } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { fmtDate } from "@/lib/utils";

interface AttachmentsTabProps {
  attachments: TicketAttachment[];
  isLoading: boolean;
  onUpload: (file: File) => Promise<void>;
  onDelete: (attachmentId: string) => Promise<void>;
}

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const ALLOWED_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
];
const ALLOWED_EXTENSIONS = ALLOWED_TYPES.join(",");

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isVideoType(mimeType: string | null | undefined): boolean {
  return mimeType?.startsWith("video/") ?? false;
}

function isImageType(mimeType: string | null | undefined): boolean {
  return mimeType?.startsWith("image/") ?? false;
}

export function AttachmentsTab({
  attachments,
  isLoading,
  onUpload,
  onDelete,
}: AttachmentsTabProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input to allow re-uploading the same file
    if (fileInputRef.current) fileInputRef.current.value = "";

    if (file.size > MAX_FILE_SIZE) {
      setUploadError(
        `File too large: ${(file.size / (1024 * 1024)).toFixed(1)}MB (max 100MB)`,
      );
      return;
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      setUploadError(`Unsupported file type: ${file.type}`);
      return;
    }

    setUploadError(null);
    setUploading(true);
    try {
      await onUpload(file);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : "Upload failed",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (attachmentId: string) => {
    if (!window.confirm("Permanently remove this evidence file? This cannot be undone.")) return;
    setDeletingId(attachmentId);
    try {
      await onDelete(attachmentId);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col">
      {/* Error state */}
      {uploadError && (
        <div className="px-4 py-2.5 bg-danger-bg border-b border-danger/20 text-xs text-danger flex items-center justify-between">
          <span>{uploadError}</span>
          <button
            className="text-danger font-medium hover:underline"
            onClick={() => setUploadError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && attachments.length === 0 && !uploading && (
        <p className="text-sm text-text-muted text-center py-8">
          No attachments yet.
        </p>
      )}

      {/* Attachment grid */}
      {!isLoading && attachments.length > 0 && (
        <div className="flex flex-col divide-y divide-border">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              {/* Thumbnail */}
              {isVideoType(a.mime_type) ? (
                <div className="size-14 rounded-md bg-gray-800 flex items-center justify-center shrink-0 overflow-hidden">
                  {a.signed_url ? (
                    <video
                      src={a.signed_url}
                      className="size-full object-cover"
                      preload="metadata"
                      muted
                    />
                  ) : (
                    <svg
                      className="size-6 text-gray-400"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </div>
              ) : isImageType(a.mime_type) ? (
                <div className="size-14 rounded-md bg-gray-100 flex items-center justify-center shrink-0 overflow-hidden">
                  {a.signed_url ? (
                    <img
                      src={a.signed_url}
                      alt={a.filename ?? "Attachment"}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <svg
                      className="size-6 text-gray-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"
                      />
                    </svg>
                  )}
                </div>
              ) : (
                <div className="size-14 rounded-md bg-gray-100 flex items-center justify-center shrink-0">
                  <svg
                    className="size-7 text-gray-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    aria-label="File attachment"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5A3.375 3.375 0 0010.125 2.25H8.25m5.25 0H6.375A1.875 1.875 0 004.5 4.125v15.75a1.875 1.875 0 001.875 1.875h11.25a1.875 1.875 0 001.875-1.875V5.625a3.375 3.375 0 00-3.375-3.375H13.5z"
                    />
                  </svg>
                </div>
              )}

              {/* Info */}
              <div className="min-w-0 flex-1">
                {a.filename && (
                  <a
                    href={a.signed_url ?? a.reference_url ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`text-sm font-medium block truncate ${
                      a.signed_url || a.reference_url
                        ? "text-accent hover:underline"
                        : "text-text"
                    }`}
                  >
                    {a.filename}
                  </a>
                )}
                <div className="flex items-center gap-2 mt-0.5 text-xs text-text-muted">
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${
                      isVideoType(a.mime_type)
                        ? "bg-purple-100 text-purple-700"
                        : isImageType(a.mime_type)
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-700"
                    }`}
                  >
                    {a.media_type}
                  </span>
                  <span>{formatSize(a.size_bytes)}</span>
                  {a.mime_type && (
                    <span className="font-mono text-xs text-text-muted/60">
                      {a.mime_type}
                    </span>
                  )}
                  <span className="text-text-muted/50">
                    {fmtDate(a.created_at)}
                  </span>
                </div>
              </div>

              {/* Delete button */}
              <Button
                variant="danger"
                size="sm"
                loading={deletingId === a.id}
                disabled={deletingId !== null}
                onClick={() => handleDelete(a.id)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Upload area */}
      <div className="px-4 py-3 border-t border-border flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_EXTENSIONS}
          className="hidden"
          onChange={handleFileSelect}
        />
        <Button
          variant="secondary"
          size="sm"
          loading={uploading}
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? "Uploading..." : "+ Upload Attachment"}
        </Button>
        <span className="text-xs text-text-muted">
          Images & video, max 100 MB
        </span>
      </div>
    </div>
  );
}
