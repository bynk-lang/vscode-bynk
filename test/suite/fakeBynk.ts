// Helpers for tests that drive the extension's CLI commands against the
// stand-in `bynk` in test/fixtures/fake-bynk (#2094). The extension host and the
// tests share one process, so setting `BYNK_FAKE_LOG` here reaches every `bynk`
// child the extension spawns.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export const FAKE_BYNK = path.resolve(__dirname, "../../../test/fixtures/fake-bynk/bynk");

export interface FakeLogEntry {
  argv?: string[];
  cwd?: string;
  signal?: string;
  /** The `bynk` process that wrote the entry. */
  pid?: number;
  /** A child the stand-in started and left running, for a test to find gone. */
  grandchild?: number;
  /** Its exit code, written as it exits. */
  exit?: number;
}

/** Point `bynk.bynkPath` at the stand-in and log its invocations; returns an
 *  undo function and a reader for the log. */
export async function useFakeBynk(): Promise<{
  read: () => FakeLogEntry[];
  restore: () => Promise<void>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-fake-"));
  const log = path.join(dir, "log.jsonl");
  const config = vscode.workspace.getConfiguration("bynk");
  const previous = config.inspect<string>("bynkPath")?.globalValue;
  fs.chmodSync(FAKE_BYNK, 0o755);
  await config.update("bynkPath", FAKE_BYNK, vscode.ConfigurationTarget.Global);
  process.env.BYNK_FAKE_LOG = log;
  return {
    read: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as FakeLogEntry)
        : [],
    restore: async () => {
      delete process.env.BYNK_FAKE_LOG;
      await vscode.workspace
        .getConfiguration("bynk")
        .update("bynkPath", previous, vscode.ConfigurationTarget.Global);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Whether `pid` is still running. A zombie that nothing has reaped yet is gone. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true; // no /proc (macOS): signal 0 answered
  }
}
