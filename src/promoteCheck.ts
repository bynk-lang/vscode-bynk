// #158: check a generated test suite with the real compiler before it is offered.
//
// `bynk compile --sources-stdin` takes unsaved buffers but does not type-check
// a `suite` (a bad suite compiles with exit 0), and `bynk check` reads only the
// disk. So the suite is checked in a scratch copy of the project: the project's
// files, its unsaved `.bynk` buffers laid over them, and the suite at its path.
// Nothing in the project itself changes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type * as vscode from "vscode";

import type { CheckOutcome } from "./chatCore";
import { BynkNotFoundError, runBynk } from "./cli";
import { dirtyBuffers } from "./dirtyBuffers";
import { compileVerdict } from "./richDiagnostics";

/** What is not copied: dependencies, build output and history. */
const SKIP = new Set(["node_modules", ".git", "out", ".bynk", "target", "dist", ".wrangler", ".bynk-test-bin"]);

/** `bynk check` of the project at `root` with `text` written at `relative` (a
 *  path under the root) in a scratch copy. */
export function checkSuiteInCopy(root: string, relative: string, text: string, token: vscode.CancellationToken): Promise<CheckOutcome> {
  return checkSuitesInCopy(root, [{ relative, text }], token);
}

/** The same with several files written into the one copy: all must check
 *  together before any is written (#210). */
export async function checkSuitesInCopy(
  root: string,
  files: readonly { relative: string; text: string }[],
  token: vscode.CancellationToken,
): Promise<CheckOutcome> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-promote-check-"));
  try {
    fs.cpSync(root, scratch, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
    for (const [file, content] of Object.entries(dirtyBuffers(root))) {
      const dest = path.join(scratch, path.relative(root, file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    for (const f of files) {
      const target = path.join(scratch, f.relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.text);
    }
    const run = await runBynk(["check", scratch], scratch, token);
    if (token.isCancellationRequested) return { kind: "unavailable", reason: "the check was cancelled" };
    const verdict = compileVerdict(run.code, run.stdout.split(scratch).join(root), run.stderr.split(scratch).join(root));
    return verdict;
  } catch (e) {
    return {
      kind: "unavailable",
      reason: e instanceof BynkNotFoundError ? "the Bynk toolchain is not installed" : String(e instanceof Error ? e.message : e),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
