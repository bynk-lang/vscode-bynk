// The one place the extension spawns and stops a long-lived child (#42): the dev
// server, the debugged CLI and the test runs all go through here, so detaching,
// killing a whole process tree and draining the child's output are decided once.
// The platform decisions are in `procCore.ts`.

import { spawn, ChildProcess, SpawnOptions } from "node:child_process";

import { killPlan, spawnPlatformOptions } from "./procCore";

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
 *  A start failure arrives as the child's `error`. */
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
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer | string) => opts.output?.append(String(chunk)));
  }
  return child;
}

/** Stop `child` and everything it started: SIGTERM to its process group (`bynk
 *  dev` traps it and tears down wrangler and workerd), or `taskkill /T /F` on
 *  Windows. A no-op for a child that has already ended. */
export function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
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
