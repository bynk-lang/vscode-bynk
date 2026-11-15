// #132 integration test: a project with `[build.client]` is checked with
// `bynk client --check`, and a project without it is not. Runs against the
// stand-in `bynk` (test/fixtures/fake-bynk), which answers as v0.614.0 does.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const WORKSPACE = path.resolve(__dirname, "../../../test/fixtures/workspace");
const MANIFEST = path.join(WORKSPACE, "bynk.toml");

describe("stale generated client (#132)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let original: string;

  before(async () => {
    original = fs.readFileSync(MANIFEST, "utf8");
    fake = await useFakeBynk();
  });

  after(async () => {
    fs.writeFileSync(MANIFEST, original);
    delete process.env.BYNK_FAKE_CLIENT;
    await vscode.commands.executeCommand("notifications.clearAll");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await fake.restore();
  });

  const checks = () => fake.read().filter((e) => e.argv?.[0] === "client");

  it("does not run for a project without [build.client]", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(30_000);
    await vscode.commands.executeCommand("bynk.checkClient");
    // The command answers with a message once it has checked.
    await new Promise((r) => setTimeout(r, 1000));
    await vscode.commands.executeCommand("notifications.clearAll");
    assert.deepStrictEqual(checks(), []);
  });

  it("runs `bynk client --check` for a project that has it", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(30_000);
    process.env.BYNK_FAKE_CLIENT = "stale";
    fs.writeFileSync(MANIFEST, `${original}\n[build.client]\nout = "web/api.ts"\n`);
    const doc = await vscode.workspace.openTextDocument(path.join(WORKSPACE, "src", "text.bynk"));
    await vscode.window.showTextDocument(doc);
    // The command answers once it has checked; the warning it raises is not waited for.
    const summary = await vscode.commands.executeCommand("bynk.checkClient");
    await waitFor(() => checks().length > 0, truthy, `a \`bynk client --check\` run (${JSON.stringify(summary)})`);
    assert.deepStrictEqual(checks()[0].argv, ["client", "--check"]);
    assert.strictEqual(checks()[0].cwd && fs.realpathSync(checks()[0].cwd!), fs.realpathSync(WORKSPACE));
  });
});
