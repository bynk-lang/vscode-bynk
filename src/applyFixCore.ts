// The `applyFix` command takes its arguments from a chat button but is also a
// registered command, so anything can call it. This checks the shape before it
// reaches `new vscode.Range`, which throws on a negative or non-integer line.
// Pure of `vscode`, so it unit-tests directly.

import type { FixProposal } from "./chatCore";

export type FixArgs = { ok: true; uri: string; fix: FixProposal } | { ok: false; message: string };

function line(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

export function validateFixArgs(uri: unknown, fix: unknown): FixArgs {
  const bad = (message: string): FixArgs => ({ ok: false, message });
  if (typeof uri !== "string" || uri === "") return bad("The fix has no file to apply to.");
  if (typeof fix !== "object" || fix === null) return bad("The fix proposal is malformed.");
  const f = fix as Record<string, unknown>;
  if (!line(f.startLine) || !line(f.endLine)) return bad("The fix proposal's line numbers are invalid.");
  if (f.endLine < f.startLine) return bad("The fix proposal's line range is backwards.");
  if (typeof f.replacement !== "string" || typeof f.original !== "string") {
    return bad("The fix proposal is missing its text.");
  }
  if (typeof f.path !== "string") return bad("The fix proposal has no path.");
  return {
    ok: true,
    uri,
    fix: { path: f.path, startLine: f.startLine, endLine: f.endLine, replacement: f.replacement, original: f.original },
  };
}
