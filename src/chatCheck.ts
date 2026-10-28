// #2516: the checks behind `@bynk /fix` and `/learn`. A candidate edit or a
// lesson's example is compiled with `bynk compile --sources-stdin` (the only
// command that takes text that is not on disk), into a scratch directory that is
// removed afterwards. Nothing in the project changes, and a preview build
// neither reads nor writes `bynk.schema.lock` (see emittedBuild.ts).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import type { CheckOutcome } from "./chatCore";
import { BynkNotFoundError, runBynk } from "./cli";
import { parseRichDiagnostics } from "./richDiagnostics";

/** Compile the project at `root` with `buffers` (absolute path -> text) over disk. */
async function compileWith(
  root: string,
  buffers: Record<string, string>,
  token: vscode.CancellationToken,
): Promise<CheckOutcome> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-chat-check-"));
  try {
    const run = await runBynk(
      ["compile", root, "--output", scratch, "--sources-stdin"],
      root,
      token,
      JSON.stringify(buffers),
    );
    if (token.isCancellationRequested) return { kind: "unavailable", reason: "the check was cancelled" };
    if (run.code === 0) return { kind: "ok" };
    const errors = parseRichDiagnostics(`${run.stdout}\n${run.stderr}`).filter((d) => d.severity === "error");
    if (errors.length > 0) return { kind: "errors", errors };
    // A failure with no diagnostic is the compiler not running, not a verdict.
    const reason = (run.stderr || run.stdout).trim().split("\n")[0];
    return { kind: "unavailable", reason: reason || `bynk compile exited with ${run.code}` };
  } catch (e) {
    return {
      kind: "unavailable",
      reason: e instanceof BynkNotFoundError ? "the Bynk toolchain is not installed" : String(e instanceof Error ? e.message : e),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The unsaved `.bynk` buffers under `root`, except `skip`: absolute path -> text. */
function dirtyBuffers(root: string, skip: string): Record<string, string> {
  const buffers: Record<string, string> = {};
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId !== "bynk" || !doc.isDirty || doc.uri.scheme !== "file") continue;
    if (doc.uri.fsPath === skip || !doc.uri.fsPath.startsWith(root)) continue;
    buffers[doc.uri.fsPath] = doc.getText();
  }
  return buffers;
}

/** Check the active file's project with `text` as that file's contents. */
export async function checkInProject(
  fileUri: vscode.Uri,
  text: string,
  token: vscode.CancellationToken,
  projectRoot: (file: vscode.Uri) => Promise<vscode.Uri | undefined>,
): Promise<CheckOutcome> {
  const root = await projectRoot(fileUri);
  if (!root) return { kind: "unavailable", reason: "the file is not in a Bynk project (no bynk.toml)" };
  return compileWith(root.fsPath, { ...dirtyBuffers(root.fsPath, fileUri.fsPath), [fileUri.fsPath]: text }, token);
}

/** Check `source` as the only unit of a throwaway project. */
export async function checkScratch(source: string, token: vscode.CancellationToken): Promise<CheckOutcome> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-chat-scratch-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "bynk.toml"), '[project]\nname = "chat-check"\n\n[paths]\ninclude = ["src"]\n');
    const file = path.join(root, "src", "example.bynk");
    fs.writeFileSync(file, "");
    return await compileWith(root, { [file]: source }, token);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
