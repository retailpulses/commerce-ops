export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function sanitizeFilename(name: string): string {
  const sanitized = name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[._]+/, "")
    .substring(0, 255);

  return sanitized || "download";
}

export function sanitizeUnicodeFilename(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^[._\s]+/, "")
    .trim();
  return Array.from(normalized || "download").slice(0, 180).join("");
}

export function contentDisposition(
  disposition: "inline" | "attachment",
  name: string,
): string {
  const unicodeName = sanitizeUnicodeFilename(name);
  const asciiFallback = sanitizeFilename(unicodeName).replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(unicodeName)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
