// #61: the project root of the active `.bynk` file is cached, and a project
// directory deleted outside VS Code left the cache pointing at it, so launching
// `bynk` there failed with `spawn bynk ENOENT` and the user was told `bynk` was
// not installed. The debug command must not blame the toolchain for a deleted
// project.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { present, waitFor } from "./util";

describe("Bynk debug after the project directory is deleted (#61)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let dir: string | undefined;
  const messages: string[] = [];
  const real = {
    error: vscode.window.showErrorMessage,
    warning: vscode.window.showWarningMessage,
  };

  before(async () => {
    fake = await useFakeBynk();
  });
  after(async () => {
    (vscode.window as any).showErrorMessage = real.error;
    (vscode.window as any).showWarningMessage = real.warning;
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    await fake.restore();
  });

  it("does not tell the user bynk is missing", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    // Outside the workspace folder, so no watcher sees the delete and the stale
    // cache entry is certain; a loose file still walks up to its project.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bynk-gone-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "gone"\n');
    const file = path.join(dir, "src", "main.bynk");
    fs.writeFileSync(file, "module gone\n");

    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    // Let the extension resolve (and cache) the file's project root.
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath, present, "the editor to open");
    await new Promise((r) => setTimeout(r, 500));
    // The debug provider hands VS Code a node attach; catch it so none happens.
    const attached: vscode.DebugConfiguration[] = [];
    const catcher = vscode.debug.registerDebugConfigurationProvider("node", {
      resolveDebugConfiguration: (_folder, config) => (attached.push(config), undefined),
    });

    // Deleted behind VS Code's back: no file event reaches the cache.
    fs.rmSync(dir, { recursive: true, force: true });

    const stub = (...args: unknown[]) => {
      messages.push(String(args[0]));
      return Promise.resolve(undefined);
    };
    (vscode.window as any).showErrorMessage = stub;
    (vscode.window as any).showWarningMessage = stub;

    try {
      await vscode.commands.executeCommand("bynk.debugTests");
      // Either it ran in the fixture project (attach, then the child exits) or it
      // said what was wrong; wait for the whole outcome before restoring stubs.
      await waitFor(
        () => (messages.length > 0 || attached.length > 0 ? true : undefined),
        present,
        "a launch or a message",
        30_000,
      );
      const launch = fake.read().find((e) => e.argv?.[0] === "test");
      if (launch) {
        await waitFor(
          () => fake.read().some((e) => e.pid === launch.pid && e.exit !== undefined),
          (v) => v === true,
          "the launched child to exit",
          30_000,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      catcher.dispose();
    }
    assert.ok(
      !messages.some((m) => /could not run|not found|Install the Bynk toolchain/i.test(m)),
      `told bynk is missing: ${messages.join(" | ")}`,
    );
    assert.ok(
      !fake.read().some((e) => e.cwd === dir),
      "launched in the deleted directory",
    );
  });
});
