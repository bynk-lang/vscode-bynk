// The decisions behind `proc.ts`, with the platform passed in so a Linux CI run
// can check what Windows would do: how a child is spawned, what stops its whole
// tree, and whether a command can be found at all. No `vscode`, no processes.

import * as fs from "node:fs";
import * as path from "node:path";

/** What a spawn needs from the platform: its own process group off Windows (so
 *  one signal reaches `bynk` → `wrangler` → `workerd`), and on Windows neither
 *  `detached`, which opens a console window, nor a visible one. */
export function spawnPlatformOptions(platform: NodeJS.Platform): {
  detached: boolean;
  windowsHide: boolean;
} {
  return { detached: platform !== "win32", windowsHide: true };
}

/** How to stop the tree rooted at `pid`: signal its process group, or on Windows
 *  (no groups, no SIGTERM) run `taskkill /T /F`, which ends the tree. */
export type KillPlan =
  | { kind: "group"; pid: number; signal: NodeJS.Signals }
  | { kind: "taskkill"; command: string; args: string[] };

export function killPlan(
  platform: NodeJS.Platform,
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  env: NodeJS.ProcessEnv = process.env,
): KillPlan {
  if (platform === "win32") {
    // By full path: a bare name would be found through the child's PATH, which a
    // workspace could point at its own `taskkill`.
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    return {
      kind: "taskkill",
      command: path.win32.join(root, "System32", "taskkill.exe"),
      args: ["/T", "/F", "/PID", String(pid)],
    };
  }
  return { kind: "group", pid, signal };
}

/** Whether `command` names an executable: a path is checked as it is, a bare
 *  name is looked up on `PATH` (with `PATHEXT` on Windows). `exists` is injected
 *  so a test needs no files. */
export function findExecutable(
  command: string,
  opts: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    exists?: (file: string) => boolean;
    /** What a relative path is relative to (the task's folder). */
    cwd?: string;
    /** What a leading `~` stands for. */
    home?: string;
  },
): string | undefined {
  const exists = opts.exists ?? isExecutableFile(opts.platform);
  const win = opts.platform === "win32";
  const sep = win ? path.win32 : path.posix;
  const exts = win
    ? ["", ...(opts.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  if (opts.home && (command === "~" || /^~[\\/]/.test(command))) {
    command = sep.join(opts.home, command.slice(1));
  }
  const hasDir = /[\\/]/.test(command);
  const candidates =
    sep.isAbsolute(command) || hasDir
      ? [opts.cwd && !sep.isAbsolute(command) ? sep.join(opts.cwd, command) : command]
      : (opts.env[win ? "Path" : "PATH"] ?? opts.env.PATH ?? "")
          .split(win ? ";" : ":")
          .filter(Boolean)
          .map((dir) => sep.join(dir, command));
  for (const base of candidates) {
    for (const ext of exts) {
      if (exists(base + ext)) return base + ext;
    }
  }
  return undefined;
}

function isExecutableFile(platform: NodeJS.Platform): (file: string) => boolean {
  return (file) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}
