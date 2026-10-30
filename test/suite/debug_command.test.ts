// #44: `bynk.debugTests` end to end against the stand-in `bynk`, whose
// `test --inspect` child (BYNK_FAKE_CHATTY) writes 512 KB to stdout and stderr and
// only exits once the extension has drained them (#30). proc.test.ts covers the
// helper; this goes through the command and the debug configuration provider.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { present, truthy, waitFor } from "./util";

describe("Bynk debug command (#44)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  before(async () => {
    fake = await useFakeBynk();
  });
  after(async () => {
    delete process.env.BYNK_FAKE_CHATTY;
    await fake.restore();
  });

  it("bynk.debugTests does not hang on a debuggee that fills its pipes", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(90_000);
    process.env.BYNK_FAKE_CHATTY = "1";
    // The provider roots the run at the active `.bynk` file's project (#55). An
    // earlier test leaves one open from a directory it has since deleted, so start
    // from no editor: the run then falls back to the fixture project.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(() => vscode.window.activeTextEditor, (e) => e === undefined, "the editors to close", 10_000);
    // The provider hands VS Code a `node` attach to the fake's inspector port,
    // where nothing listens; catch it so no attach is attempted.
    const attached: vscode.DebugConfiguration[] = [];
    const catcher = vscode.debug.registerDebugConfigurationProvider("node", {
      resolveDebugConfiguration: (_folder, config) => (attached.push(config), undefined),
    });
    try {
      await vscode.commands.executeCommand("bynk.debugTests");
      const launch = await waitFor(
        () => fake.read().find((e) => e.argv?.[0] === "test" && e.argv.includes("--inspect")),
        present,
        "the --inspect launch",
        20_000,
      );
      assert.deepStrictEqual(launch.argv!.slice(0, 3), ["test", ".", "--inspect"]);
      assert.strictEqual(
        launch.cwd && fs.realpathSync(launch.cwd),
        fs.realpathSync(path.resolve(__dirname, "../../../test/fixtures/workspace")),
        "rooted at the fixture project",
      );
      // The port parsed from the ready line, while output is still being written.
      await waitFor(() => attached.find((c) => c.port === 9229), present, "the attach to the parsed port", 20_000);
      await waitFor(
        () => fake.read().some((e) => e.pid === launch.pid && e.exit === 0),
        truthy,
        "the chatty child to finish: its output must be drained",
        30_000,
      );
    } finally {
      catcher.dispose();
      await vscode.debug.stopDebugging();
    }
  });
});
