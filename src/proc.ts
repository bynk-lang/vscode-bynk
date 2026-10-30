// The one place the extension spawns and stops a long-lived child (#42): the dev
// server, the debugged CLI and the test runs all go through here, so detaching,
// killing a whole process tree and draining the child's output are decided once.
// The platform decisions are in `procCore.ts`.

import * as fs from "node:fs";
import { spawn, ChildProcess, SpawnOptions } from "node:child_process";

import { classifySpawnError, killPlan, MISSING_CWD, missingCwdMessage, spawnPlatformOptions } from "./procCore";

/** Where a child's output goes when nobody reads it otherwise. */
export interface OutputSink {
  append(text: string): void;
}

export interface SpawnTreeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** `"pipe"` to write to the child's stdin; the default ignores it. */
  stdin?: "ignore" | "pipe";
  /** Receives everything the child writes. Without it the output is discarded,
   *  but still read. */
  output?: OutputSink;
}

/** Spawn `command` so that `killTree` reaches everything it starts, with stdout
 *  and stderr piped and *drained for the child's whole life*: a pipe nobody
 *  reads fills (about 64 KB) and blocks the child on its next write. Callers may
 *  add their own `data` listeners; this one only makes sure data keeps flowing.
 *  A start failure arrives as the child's `error`;
 *  one caused by a deleted `cwd` has code `BYNK_MISSING_CWD`, not `ENOENT`. */
export function spawnTree(
  command: string,
  args: string[],
  opts: SpawnTreeOptions = {},
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  const options: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdin ?? "ignore", "pipe", "pipe"],
    ...spawnPlatformOptions(platform),
  };
  const child = spawn(command, args, options);
  // Registered first, so every later `error` listener sees the corrected error:
  // `ENOENT` for a deleted cwd is not "command not found" (#61).
  child.once("error", (err) => {
    if (classifySpawnError(err, opts.cwd, fs.existsSync) === "missing-cwd") {
      Object.assign(err, { code: MISSING_CWD, message: missingCwdMessage(opts.cwd!) });
    }
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer | string) => opts.output?.append(String(chunk)));
  }
  return child;
}

/** Stop `child` and everything it started: SIGTERM to its process group (`bynk
 *  dev` traps it and tears down wrangler and workerd), or `taskkill /T /F` on
 *  Windows. Off Windows it also reaches a group whose leader has already exited;
 *  on Windows it is a no-op for an ended child. */
export function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
): void {
  if (child.pid === undefined) return;
  // On POSIX the group outlives its leader: `bynk` may be gone while wrangler or
  // workerd are not, and ESRCH (nothing left) is fine. Windows has no group to
  // signal once the root process is gone.
  if (platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
  const plan = killPlan(platform, child.pid, signal);
  try {
    if (plan.kind === "taskkill") {
      spawn(plan.command, plan.args, { stdio: "ignore", windowsHide: true })
        // taskkill missing or failing: end at least the child itself.
        .on("error", () => child.kill())
        .on("exit", (code) => {
          if (code !== 0) child.kill();
        });
    } else {
      process.kill(-plan.pid, plan.signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
