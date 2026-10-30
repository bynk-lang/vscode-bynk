// #44: the toolchain, deploy and tail commands, against the stand-in `bynk`
// (test/fixtures/fake-bynk). The stand-in answers a dry run with the pinned plan
// and refuses a real deploy, so nothing here reaches Cloudflare or the network.

import * as assert from "assert";
import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const win = vscode.window as unknown as Record<string, unknown>;

const tabOpen = (label: string): boolean =>
  vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === label));

describe("Bynk toolchain, deploy and tail commands (#44)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let seen = 0;
  const runs = (cmd: string) => fake.read().slice(seen).filter((e) => e.argv?.[0] === cmd);

  before(async () => {
    fake = await useFakeBynk();
  });
  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await fake.restore();
  });
  beforeEach(() => {
    seen = fake.read().length;
  });

  it("bynk.installToolchain installs nothing when a bynk is already configured", async () => {
    const real = { showInformationMessage: win.showInformationMessage };
    const told: string[] = [];
    win.showInformationMessage = async (m: string) => (told.push(m), undefined);
    try {
      await vscode.commands.executeCommand("bynk.installToolchain");
    } finally {
      Object.assign(win, real);
    }
    assert.strictEqual(told.length, 1);
    assert.match(told[0], /nothing to install/);
  });

  it("bynk.deploy previews with --dry-run, opens the plan, and never runs a deploy", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(30_000);
    // The plan view's title names the plan's own environment (the pinned plan's).
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(() => tabOpen("Bynk Deploy Plan: staging"), (open) => !open, "an earlier plan view to close");
    await vscode.commands.executeCommand("bynk.deploy", { environment: "staging", context: "" });
    await waitFor(() => tabOpen("Bynk Deploy Plan: staging"), truthy, "the plan view");
    const deploys = runs("deploy");
    assert.strictEqual(deploys.length, 1);
    assert.deepStrictEqual(deploys[0].argv, ["deploy", "--dry-run", "--format", "json", "--env", "staging"]);
  });

  it("bynk.deploy refuses an environment name that is not one", async function () {
    if (process.platform === "win32") this.skip();
    const real = { showErrorMessage: win.showErrorMessage };
    const errors: string[] = [];
    win.showErrorMessage = async (m: string) => (errors.push(m), undefined);
    try {
      await vscode.commands.executeCommand("bynk.deploy", { environment: "--prune" });
    } finally {
      Object.assign(win, real);
    }
    assert.match(errors[0] ?? "", /is not an environment name/);
    assert.strictEqual(runs("deploy").length, 0, "nothing was run");
  });

  it("bynk.tailLogs probes the driver, then tails the environment's Worker in a terminal", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    await vscode.commands.executeCommand("bynk.tailLogs", { environment: "staging", context: "billing" });
    await waitFor(
      () => vscode.window.terminals.some((t) => t.name === "Bynk Tail (staging)"),
      truthy,
      "the tail terminal",
      20_000,
    );
    const tails = await waitFor(
      () => runs("tail").map((e) => e.argv!),
      (l) => l.length >= 2,
      "the probe and the tail",
      30_000,
    );
    assert.deepStrictEqual(tails[0], ["tail", "--help"]);
    assert.deepStrictEqual(tails[1], ["tail", "--env", "staging", "--context", "billing"]);
    vscode.window.terminals.filter((t) => t.name === "Bynk Tail (staging)").forEach((t) => t.dispose());
  });
});
