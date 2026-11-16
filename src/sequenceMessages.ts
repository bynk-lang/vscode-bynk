// The messages the sequence-diagram page sends its host, and their checks.
// The page is untrusted, so each is shape- and size-checked before the host
// acts on it. No `vscode` import, so these are unit-tested.

import type { RevealRange } from "./webviewHost";

/** "Copy as Mermaid": put the diagram's text on the clipboard. */
export interface CopyTextMessage {
  type: "copyText";
  text: string;
}

/** Mark the source of the element under the pointer or focus; `range: null`
 *  clears the mark. */
export interface HighlightMessage {
  type: "highlight";
  uri: string;
  range: RevealRange | null;
}

/** "Save as SVG/PNG": the page made the file, the host asks where to put it.
 *  `data` is the SVG text, or the PNG's bytes as base64. */
export interface SaveFileMessage {
  type: "saveFile";
  format: "svg" | "png";
  name: string;
  data: string;
}

/** Something the page could not do, to show the user. */
export interface PageErrorMessage {
  type: "error";
  message: string;
}

const MAX_COPY = 1_000_000;
/** An SVG is text; a PNG at twice size of a very large diagram can be tens of
 *  megabytes as base64. */
const MAX_SAVE = 64 * 1024 * 1024;
const MAX_NAME = 120;

function isPosition(v: unknown): boolean {
  const p = v as { line?: unknown; character?: unknown } | null | undefined;
  return Number.isInteger(p?.line) && (p?.line as number) >= 0 && Number.isInteger(p?.character) && (p?.character as number) >= 0;
}

function isRange(v: unknown): v is RevealRange {
  const r = v as { start?: unknown; end?: unknown } | null | undefined;
  return isPosition(r?.start) && isPosition(r?.end);
}

export function isCopyText(message: unknown): message is CopyTextMessage {
  const m = message as { type?: unknown; text?: unknown } | null | undefined;
  return m?.type === "copyText" && typeof m.text === "string" && m.text.length <= MAX_COPY;
}

export function isHighlight(message: unknown): message is HighlightMessage {
  const m = message as { type?: unknown; uri?: unknown; range?: unknown } | null | undefined;
  return m?.type === "highlight" && typeof m.uri === "string" && (m.range === null || isRange(m.range));
}

export function isSaveFile(message: unknown): message is SaveFileMessage {
  const m = message as { type?: unknown; format?: unknown; name?: unknown; data?: unknown } | null | undefined;
  return (
    m?.type === "saveFile" &&
    (m.format === "svg" || m.format === "png") &&
    typeof m.name === "string" &&
    m.name.length <= MAX_NAME &&
    typeof m.data === "string" &&
    m.data.length > 0 &&
    m.data.length <= MAX_SAVE &&
    (m.format === "svg" ? m.data.trimStart().startsWith("<svg") : /^[A-Za-z0-9+/]+=*$/.test(m.data))
  );
}

export function isPageError(message: unknown): message is PageErrorMessage {
  const m = message as { type?: unknown; message?: unknown } | null | undefined;
  return m?.type === "error" && typeof m.message === "string" && m.message.length <= 2000;
}

/** A safe file name stem for the save dialog: letters, digits, `.`, `_`, `-`. */
export function fileStem(name: string): string {
  return name.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "sequence";
}
