// #2471: compile the project to a scratch directory through the CLI and read
// back the modules that come from one `.bynk` file.
//
// `bynk compile --sources-stdin` takes the project's unsaved buffers as JSON on
// stdin, so what is compiled is what is on screen, and writes each module with
// its source map under `--output`. Nothing outside that directory changes (a
// preview build neither reads nor writes `bynk.schema.lock`). The per-module
// runtime (`__bynk_runtime/…`, ADR 0615) is written too but belongs to no
// source file, so its maps never name one and it is not read.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type * as vscode from "vscode";

import { runBynk } from "./cli";
import type { EmittedFile } from "./emittedMap";
import { readModules } from "./emittedModules";

export type BuildResult =
  | { ok: true; files: EmittedFile[] }
  | { ok: false; message: string };

/**
 * Compile the project at `root` once, with `buffers` (absolute path -> text)
 * layered over disk, and return the modules generated from each of
 * `sourcePaths`. A failed compile (diagnostics, no compiler) is `{ ok: false }`
 * with the reason, for every source.
 */
export async function buildProjectModules(
  root: string,
  sourcePaths: readonly string[],
  buffers: Record<string, string>,
  token?: vscode.CancellationToken,
): Promise<Map<string, BuildResult>> {
  const results = new Map<string, BuildResult>();
  const fail = (message: string): Map<string, BuildResult> => {
    for (const p of sourcePaths) results.set(p, { ok: false, message });
    return results;
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-emitted-"));
  try {
    const result = await runBynk(
      ["compile", root, "--output", scratch, "--sources-stdin"],
      root,
      token,
      JSON.stringify(buffers),
    );
    if (token?.isCancellationRequested) return fail("cancelled");
    if (result.code !== 0) {
      const reason = (result.stderr || result.stdout).trim().split("\n")[0];
      return fail(reason || `bynk compile exited with ${result.code}`);
    }
    for (const p of sourcePaths) results.set(p, { ok: true, files: readModules(scratch, p) });
    return results;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** {@link buildProjectModules} for the one source `sourcePath`. */
export async function buildModules(
  root: string,
  sourcePath: string,
  buffers: Record<string, string>,
  token?: vscode.CancellationToken,
): Promise<BuildResult> {
  return (await buildProjectModules(root, [sourcePath], buffers, token)).get(sourcePath)!;
}
