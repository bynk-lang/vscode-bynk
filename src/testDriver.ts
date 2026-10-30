// The `bynk test` process: its arguments, the one-document run and the ndjson
// stream. Split out of `testing.ts`.

import type * as vscode from "vscode";

import { killTree, spawnTree } from "./proc";
import { bynkPath } from "./tasks";
import { BynkNotFoundError, bynkEnv } from "./cli";
import { EventReader, RunAssembler, rejectsNdjson, type DriverSupport } from "./testStream";
import type { JsonSuite, TestRun } from "./testPlan";
import { testArgs, type TestRunOptions } from "./testArgs";

/** The most `bynk test --format json` output taken from one run. */
const MAX_OUTPUT = 64 * 1024 * 1024;

/** Run `bynk test . --format json` at `root` and parse its document. With
 *  `{ noRun: true }` it adds `--no-run` — a pure discovery compile that lists
 *  suites/cases without running them. A non-zero exit is normal (test failures),
 *  so we parse stdout regardless and only reject when there is no parseable
 *  document at all. Goes through `bynk` rather than shelling `bynkc` directly
 *  (#486): the driver resolves its compiler as `BYNK_BYNKC` → PATH →
 *  sibling-of-`bynk`, so a driver-first install works here too; `bynk.compilerPath`
 *  is forwarded as `BYNK_BYNKC` to keep pinning an exact `bynkc` when set. */
export function runBynkcTest(
  root: vscode.Uri,
  token?: vscode.CancellationToken,
  opts?: TestRunOptions,
): Promise<TestRun> {
  const args = testArgs(root.fsPath, opts, "json");
  return new Promise((resolve, reject) => {
    const child = spawnTree(bynkPath(), args, { cwd: root.fsPath, env: bynkEnv() });
    let stdout = "";
    let stderr = "";
    let capped = false;
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      if (capped) return;
      stdout += d;
      // The cap `execFile`'s maxBuffer gave: a runaway run must not fill memory.
      if (stdout.length > MAX_OUTPUT && !capped) {
        capped = true;
        killTree(child);
        reject(new Error("`bynk test` wrote more than 64 MB of output"));
      }
    });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    // Kill the whole tree: the driver may not forward SIGTERM to the runner.
    const cancel = token?.onCancellationRequested(() => killTree(child));
    child.once("error", (err) => {
      cancel?.dispose();
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new BynkNotFoundError(bynkPath(), err) : err);
    });
    child.once("close", () => {
      cancel?.dispose();
      const text = stdout.trim();
      if (!text) {
        reject(new Error(stderr.trim() || "no output from `bynk test`"));
        return;
      }
      try {
        resolve(JSON.parse(text) as TestRun);
      } catch (e) {
        reject(new Error(`could not parse \`bynk test\` output: ${String(e)}`));
      }
    });
  });
}

/** Run `bynk test . --format ndjson` and apply each case through `onSuite` (as its
 *  suite holding that one case) as the driver reports it, so the Testing view fills in
 *  while the run is going. Resolves
 *  with the whole run's document (also assembled from the events) and whether the
 *  suites were streamed: a driver that rejects `ndjson` is run again as `json`, and
 *  its suites are for the caller to apply. A process that wrote no events is
 *  rejected, as `runBynkcTest` rejects one with no document. */
export function runBynkcTestStream(
  root: vscode.Uri,
  token: vscode.CancellationToken,
  opts: TestRunOptions,
  onSuite: (suite: JsonSuite, soFar: TestRun) => void,
  driverSupport: DriverSupport,
): Promise<{ doc: TestRun; streamed: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawnTree(bynkPath(), testArgs(root.fsPath, opts, "ndjson"), {
      cwd: root.fsPath,
      env: bynkEnv(),
    });
    const reader = new EventReader();
    const assembler = new RunAssembler();
    let stderr = "";
    const handle = (events: ReturnType<EventReader["push"]>) => {
      for (const event of events) {
        const done = assembler.apply(event);
        if (done) onSuite(done, assembler.doc);
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => handle(reader.push(chunk)));
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new BynkNotFoundError(bynkPath(), err) : err);
    });
    child.on("close", () => {
      handle(reader.end());
      // A stopped run is the user's doing, not a runner that died: reject, as the
      // one-document run does when its process is killed, so the caller sees the
      // cancellation instead of a crash report assembled from a cut-off stream.
      if (token.isCancellationRequested) {
        reject(new Error("the run was cancelled"));
        return;
      }
      if (!assembler.hasEvents) {
        if (rejectsNdjson(stderr)) {
          driverSupport.ndjson = false;
          runBynkcTest(root, token, opts).then((doc) => resolve({ doc, streamed: false }), reject);
        } else {
          reject(new Error(stderr.trim() || "no output from `bynk test`"));
        }
        return;
      }
      resolve({ doc: assembler.finish(stderr), streamed: true });
    });
    const cancel = token.onCancellationRequested(() => killTree(child));
    child.on("close", () => cancel.dispose());
  });
}
