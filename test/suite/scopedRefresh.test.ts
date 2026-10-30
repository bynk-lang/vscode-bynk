// #38: a save refreshes the project it is in, not the whole workspace. Two
// projects in the fixture workspace, the stand-in `bynk` logging every
// invocation: a save in one project must not run `bynk deps` for either (the
// manifest did not change), and a manifest edit re-asks only that project.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";

describe("Scoped refresh on save (#38)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let dirs: string[] = [];
  let depsDoc: string;
  const dirA = () => dirs[0];
  const dirB = () => dirs[1];

  const depsRuns = (dir: string): number =>
    fake.read().filter((e) => e.argv?.[0] === "deps" && e.cwd !== undefined && fs.realpathSync(e.cwd) === dir).length;

  const treeState = () =>
    vscode.commands.executeCommand<{ reloads: number; visible: boolean }>("bynk._projectTreeState");

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    fake = await useFakeBynk();
    // `bynk deps` answers (an unanswered run is not cached, so it would re-run).
    depsDoc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bynk-sr-")), "deps.json");
    fs.writeFileSync(depsDoc, JSON.stringify({ dependencies: [] }));
    process.env.BYNK_FAKE_DEPS = depsDoc;
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    for (const name of ["a", "b"]) {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, `.sr-${name}-`)));
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "bynk.toml"), `[project]\nname = "sr-${name}"\n\n[paths]\ninclude = ["src"]\n`);
      fs.writeFileSync(path.join(dir, "src", "m.bynk"), `commons m\n\nfn one() -> Int {\n  1\n}\n`);
      dirs.push(dir);
    }
    await vscode.commands.executeCommand("workbench.view.extension.bynk");
    await waitFor(async () => (await treeState()).visible, truthy, "the project view to be visible", 10_000);
    await vscode.commands.executeCommand("bynk._projectTreeSnapshot", 2, true);
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    delete process.env.BYNK_FAKE_DEPS;
    if (depsDoc) fs.rmSync(path.dirname(depsDoc), { recursive: true, force: true });
    await fake?.restore();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("a save in one project runs no `bynk deps`, for it or the other", async function () {
    this.timeout(60_000);
    const beforeA = depsRuns(dirA());
    const beforeB = depsRuns(dirB());
    assert.ok(beforeA > 0 && beforeB > 0, "the first load asked each project once");
    const reloads = (await treeState()).reloads;

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dirA(), "src", "m.bynk")));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(new vscode.Position(doc.lineCount, 0), "\nfn two() -> Int {\n  2\n}\n"));
    await doc.save();
    await waitFor(async () => (await treeState()).reloads > reloads, truthy, "a reload after the save");

    assert.strictEqual(depsRuns(dirA()), beforeA, "the edited project's manifest did not change");
    assert.strictEqual(depsRuns(dirB()), beforeB, "the other project was not touched");
  });

  it("a manifest edit re-asks that project's deps only", async function () {
    this.timeout(60_000);
    const beforeA = depsRuns(dirA());
    const beforeB = depsRuns(dirB());
    const reloads = (await treeState()).reloads;
    fs.appendFileSync(path.join(dirA(), "bynk.toml"), "\n[dependencies]\n");
    await waitFor(async () => (await treeState()).reloads > reloads, truthy, "a reload after the manifest edit");
    await waitFor(() => depsRuns(dirA()) > beforeA, truthy, "deps to run for the edited project");
    assert.strictEqual(depsRuns(dirB()), beforeB, "the other project's deps are cached");
  });
});
