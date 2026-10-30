// #44: `bynk.openInPlayground`, `bynk.showCapabilityPath` and `bynk.runTests`.
// Each reaches a VS Code API the test cannot observe from outside (the browser,
// the references peek, the Test Explorer's run-all), so the first two replace
// that one call and record what the command asked for.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";
import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const win = vscode.window as unknown as Record<string, unknown>;

/** Replace `target[key]` for the duration of a test; throws, naming `what`, if
 *  the host does not let it be replaced, so a failure never reads as a pass. */
function replace(target: object, key: string, value: unknown, what: string): () => void {
  const t = target as Record<string, unknown>;
  const real = t[key];
  try {
    t[key] = value;
  } catch (e) {
    throw new Error(`cannot stub ${what}: ${String(e)}`);
  }
  assert.strictEqual(t[key], value, `cannot stub ${what}`);
  return () => {
    t[key] = real;
  };
}

describe("Bynk playground, capability path and run-all commands (#44)", () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-pcp-"));
  });
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("bynk.openInPlayground opens the playground link for the selection, in the browser", async () => {
    const doc = await vscode.workspace.openTextDocument({ language: "bynk", content: "fn shout(s: String) -> String {\n  s\n}\n" });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 2, 1);
    const opened: vscode.Uri[] = [];
    const undo = replace(vscode.env, "openExternal", async (u: vscode.Uri) => (opened.push(u), true), "vscode.env.openExternal");
    try {
      await vscode.commands.executeCommand("bynk.openInPlayground");
    } finally {
      undo();
    }
    assert.strictEqual(opened.length, 1);
    assert.strictEqual(opened[0].scheme, "https");
    assert.strictEqual(opened[0].authority, "playground.bynk-lang.dev");
    assert.ok(opened[0].fragment.length > 0, "the program travels in the fragment");
  });

  it("bynk.openInPlayground tells the user when no Bynk file is open", async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const told: string[] = [];
    const opened: vscode.Uri[] = [];
    const undoWin = replace(win, "showInformationMessage", async (m: string) => (told.push(m), undefined), "showInformationMessage");
    const undoEnv = replace(vscode.env, "openExternal", async (u: vscode.Uri) => (opened.push(u), true), "vscode.env.openExternal");
    try {
      await vscode.commands.executeCommand("bynk.openInPlayground");
    } finally {
      undoEnv();
      undoWin();
    }
    assert.deepStrictEqual(told, ["Open a Bynk file to share it in the playground."]);
    assert.strictEqual(opened.length, 0);
  });

  it("bynk.showCapabilityPath shows the chain in the references peek, with real Uri/Position/Location objects", async () => {
    const calls: unknown[][] = [];
    const cmds = vscode.commands as unknown as { executeCommand: (c: string, ...a: unknown[]) => Thenable<unknown> };
    const realExecute = cmds.executeCommand.bind(vscode.commands);
    const undo = replace(
      vscode.commands,
      "executeCommand",
      (c: string, ...a: unknown[]) => (c === "editor.action.showReferences" ? (calls.push(a), Promise.resolve(undefined)) : realExecute(c, ...a)),
      "vscode.commands.executeCommand",
    );
    const site = {
      uri: "file:///shop/files.bynk",
      range: { start: { line: 15, character: 4 }, end: { line: 15, character: 24 } },
    };
    try {
      await vscode.commands.executeCommand("bynk.showCapabilityPath", "file:///shop/takedown.bynk", { line: 3, character: 4 }, [site]);
      assert.strictEqual(calls.length, 1);
      const [uri, position, locations] = calls[0] as [vscode.Uri, vscode.Position, vscode.Location[]];
      assert.ok(uri instanceof vscode.Uri);
      assert.strictEqual(uri.toString(), "file:///shop/takedown.bynk");
      assert.ok(position instanceof vscode.Position);
      assert.deepStrictEqual([position.line, position.character], [3, 4]);
      assert.strictEqual(locations.length, 1);
      assert.ok(locations[0] instanceof vscode.Location);
      assert.strictEqual(locations[0].uri.toString(), site.uri);
      assert.deepStrictEqual([locations[0].range.start.line, locations[0].range.end.character], [15, 24]);

      await vscode.commands.executeCommand("bynk.showCapabilityPath", "file:///a.bynk", "3:4", [site]);
      assert.strictEqual(calls.length, 1, "malformed arguments show nothing");
    } finally {
      undo();
    }
  });

  it("bynk.runTests starts a run of every test through the Test Explorer", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    const fake = await useFakeBynk();
    try {
      await vscode.commands.executeCommand("bynk.runTests");
      await waitFor(
        () => fake.read().some((e) => e.argv?.[0] === "test" && !e.argv.includes("--no-run")),
        truthy,
        "`bynk test` to run",
        30_000,
      );
    } finally {
      await fake.restore();
    }
  });
});
