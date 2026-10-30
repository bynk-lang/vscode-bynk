// The shared `bynk` CLI runner (#2094): one place that spawns the driver with
// the extension's settings applied, so every editor command that drives the CLI
// (`bynk dev`, and the deploy, doctor and coverage commands built on it) resolves
// `bynk` and `BYNK_BYNKC` the same way, finds the project the same way, and
// stops a process tree the same way.
//
// Two shapes: `runBynk` for a one-shot command whose output is read once it
// exits (a `--format json` document, `--format short` diagnostics), and
// `spawnBynk` for a long-running one whose output is streamed (`bynk dev`).

import { ChildProcess } from "node:child_process";
import * as vscode from "vscode";

import { contextNames } from "./devEvents";
import { killTree, OutputSink, spawnTree } from "./proc";
import { MISSING_CWD } from "./procCore";
import { activeProjectRoot } from "./projectRoots";
import { bynkPath, compilerOverride } from "./tasks";

/** The contexts the project's `.bynk` sources declare, sorted: what a
 *  `--context` picker offers. */
export async function projectContexts(root: vscode.Uri): Promise<string[]> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, "**/*.bynk"),
    "**/{node_modules,.bynk}/**",
  );
  const names = new Set<string>();
  for (const file of files) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
      for (const n of contextNames(text)) names.add(n);
    } catch {
      /* unreadable: skip */
    }
  }
  return [...names].sort();
}

/** The environment a `bynk` child runs with: the extension host's, plus
 *  `BYNK_BYNKC` when `bynk.compilerPath` pins a compiler. */
export function bynkEnv(): NodeJS.ProcessEnv {
  const override = compilerOverride();
  return override ? { ...process.env, BYNK_BYNKC: override } : { ...process.env };
}

/** A finished one-shot `bynk` run. `code` is `null` when it died of a signal. */
export interface BynkResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Thrown when `bynk` itself could not be started (not on PATH, a bad
 *  `bynk.bynkPath`): the failure the Doctor cannot diagnose, because it runs
 *  through `bynk` too. */
export class BynkNotFoundError extends Error {
  constructor(readonly command: string, cause: unknown) {
    super(
      `could not run \`${command}\` (${String(cause)}). Install the Bynk toolchain, ` +
        "or point the `bynk.bynkPath` setting at the `bynk` executable.",
    );
  }
}

/** Run `bynk <args>` in `cwd` to completion and collect its output. A non-zero
 *  exit resolves normally (many commands use it for "found problems"); only a
 *  failure to start rejects, with a `BynkNotFoundError`. Cancelling the token
 *  stops the process tree. */
export function runBynk(
  args: string[],
  cwd: string,
  token?: vscode.CancellationToken,
  /** Text written to the child's stdin (then closed): `--sources-stdin`'s
   *  unsaved buffers. Without it stdin is ignored. */
  stdin?: string,
): Promise<BynkResult> {
  return new Promise((resolve, reject) => {
    const command = bynkPath();
    let child: ChildProcess;
    try {
      child = spawnBynk(args, cwd, { stdin: stdin === undefined ? "ignore" : "pipe" });
    } catch (e) {
      reject(new BynkNotFoundError(command, e));
      return;
    }
    if (stdin !== undefined) {
      // A child that exits before reading all of it (a bad flag) closes the
      // pipe: that is its exit code's story, not an unhandled `EPIPE`.
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const sub = token?.onCancellationRequested(() => stopTree(child));
    child.once("error", (e) => {
      sub?.dispose();
      reject((e as { code?: unknown }).code === MISSING_CWD ? e : new BynkNotFoundError(command, e));
    });
    child.once("close", (code) => {
      sub?.dispose();
      resolve({ code, stdout, stderr });
    });
  });
}

/** Spawn `bynk <args>` in `cwd` with the extension's settings applied, through
 *  the shared `spawnTree` so `stopTree` reaches everything it starts (`bynk` →
 *  `wrangler` → `workerd`) and its output is always drained. */
export function spawnBynk(
  args: string[],
  cwd: string,
  opts: { stdin?: "ignore" | "pipe"; output?: OutputSink } = {},
): ChildProcess {
  return spawnTree(bynkPath(), args, { cwd, env: bynkEnv(), ...opts });
}

/** Stop a `spawnBynk` child and its process tree. */
export const stopTree = killTree;

/** The project the user is working in (see `activeProjectRoot`). */
export const findProjectRoot = activeProjectRoot;
