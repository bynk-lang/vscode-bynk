// Imported by both the host (`cliCore.ts`, which pulls in `node:path`) and the
// webview bundles, so it has no imports at all.

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
