// Which files in src/webview/ are bundle entry points, found by their first line:
//
//   // @webview-entry            -> out/<file name>.js
//   // @webview-entry <name>     -> out/<name>.js
//
// Files without the marker are libraries the entries import. A file that looks
// like an entry but would be skipped is an error rather than a missing bundle at
// runtime: one that calls `acquireVsCodeApi()` with no marker, or one that
// mentions the marker anywhere but its first line (a typo, a licence header
// above it, a blank first line).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const webviewDir = path.join(fileURLToPath(new URL("..", import.meta.url)), "src", "webview");

const marker = /^\/\/ @webview-entry(?: ([A-Za-z][\w-]*))?\s*$/;
// A real call, not the word in a comment or a `declare function`.
const callsApi = /^[^/\n]*=\s*acquireVsCodeApi\(\)/m;

/** `{ entry, name }` for each entry in `dir`, in file-name order. */
export function webviewEntries(dir = webviewDir) {
  const entries = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".ts")) continue;
    // A byte-order mark would hide the marker from an exact first-line match.
    const text = readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, "");
    const m = marker.exec(text.split("\n", 1)[0]);
    if (m) {
      entries.push({ entry: `src/webview/${file}`, name: m[1] ?? file.slice(0, -3) });
    } else if (text.includes("@webview-entry")) {
      throw new Error(`${file}: \`@webview-entry\` must be exactly the file's first line (\`// @webview-entry [name]\`)`);
    } else if (callsApi.test(text)) {
      throw new Error(`${file} calls acquireVsCodeApi() but has no \`// @webview-entry\` first line, so no bundle would be built`);
    }
  }
  const dup = entries.find((e, i) => entries.findIndex((o) => o.name === e.name) !== i);
  if (dup) throw new Error(`two webview entries would write out/${dup.name}.js`);
  return entries;
}
