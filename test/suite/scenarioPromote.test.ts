// #158: a promoted scenario compiles with the REAL pinned `bynk`, and the suite
// it writes runs. The scenario fixture covers a status, a typed body field, a
// capture between steps, a redirect's Location, an actor, a body-less answer and
// an error message. Runs in the extension host, where runTest.ts has put the
// pinned toolchain (`npm run fetch:toolchain` → .bynk-test-bin) on PATH. It
// fails, rather than skips, if `bynk` is not there, so CI cannot pass unchecked.

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/promote");

function findBynk(): string | undefined {
  const exe = process.platform === "win32" ? "bynk.exe" : "bynk";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

describe("Promote a scenario against the real toolchain (#158)", () => {
  let dir: string;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".pr-")));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(dir, "src", "shop.bynk")));
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a suite that `bynk check` accepts and `bynk test` passes", async function () {
    this.timeout(240_000);
    const bynk = findBynk();
    assert.ok(bynk, "`bynk` is not on PATH (npm run fetch:toolchain)");

    // The language server must have the project's routes before it can resolve them.
    const scenario = vscode.Uri.file(path.join(dir, "scenarios", "shop.bynk-http"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(scenario));
    await waitFor(
      () => vscode.languages.getDiagnostics(scenario),
      (d) => d.every((x) => !/No handler serves/.test(x.message)),
      "the scenario to resolve against the project's routes",
      90_000,
    ).catch(() => undefined);

    const pick = vscode.window.showQuickPick;
    const input = vscode.window.showInputBox;
    const info = vscode.window.showInformationMessage;
    let summary = "";
    (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: readonly string[]) => items[0];
    // The identity the promote prompt offers is the one the actor's type needs.
    (vscode.window as { showInputBox: unknown }).showInputBox = async (o: vscode.InputBoxOptions) => o.value;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (_m: string, opts?: { detail?: string }) => {
      summary = opts?.detail ?? "";
      return "Write suite";
    };
    let target: vscode.Uri | undefined;
    try {
      target = await waitFor(
        async () => vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.scenario.promote", scenario.toString()),
        (t) => t !== undefined,
        "the promoted suite to be written",
        120_000,
      );
    } finally {
      (vscode.window as { showQuickPick: unknown }).showQuickPick = pick;
      (vscode.window as { showInputBox: unknown }).showInputBox = input;
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = info;
    }
    assert.ok(target);
    assert.strictEqual(target.fsPath, path.join(dir, "tests", "shop.bynk"));
    const text = fs.readFileSync(target.fsPath, "utf8");

    // What was expressed, and what was listed.
    assert.ok(text.includes("suite shop as system {"), text);
    assert.ok(text.includes("let Created(v_create) <- api.POST("), text);
    assert.ok(text.includes('api.GET("/items/:id", v_create.id)'), text);
    assert.ok(text.includes("let Found(v_go) <- "), text);
    assert.ok(text.includes('expect v_go == "/items/a"'), text);
    assert.ok(text.includes("let HttpResult.NoContent <- "), text);
    assert.ok(text.includes("let Conflict(v_clash) <- "), text);
    assert.ok(text.includes('by User(UserId.of("ada")?)'), text);
    assert.ok(/Not expressed \(1 of \d+ expectations/.test(text) && text.includes("content-type"), text);
    assert.ok(!/SHOP_TOKEN|Bearer/.test(text), text);
    assert.match(summary, /1 thing could not be expressed/);

    // The real compiler accepts it, and the suite runs.
    const check = spawnSync(bynk, ["check", dir], { encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    const run = spawnSync(bynk, ["test", dir, "--no-install"], { encoding: "utf8", timeout: 200_000 });
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /1 passed, 0 failed/);
  });
});
