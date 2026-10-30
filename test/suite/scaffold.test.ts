// #44: "Bynk: New Context" and "Bynk: New Project" in the fixture workspace, with
// the input box stubbed the way dependencies.test.ts does it. The fixture already
// has a `bynk.toml`, so New Project can only be checked on its refusal.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { present, waitFor } from "./util";

describe("Bynk scaffolding (#44)", () => {
  const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
  const win = vscode.window as unknown as Record<string, unknown>;
  const real = { showInputBox: win.showInputBox, showErrorMessage: win.showErrorMessage };
  let answer: string | undefined;
  let options: vscode.InputBoxOptions | undefined;
  let errors: string[];
  const created: string[] = [];

  beforeEach(() => {
    errors = [];
    options = undefined;
    win.showInputBox = async (o: vscode.InputBoxOptions) => ((options = o), answer);
    win.showErrorMessage = async (m: string) => (errors.push(m), undefined);
  });

  afterEach(async () => {
    Object.assign(win, real);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const f of created.splice(0)) fs.rmSync(f, { force: true });
  });

  it("newContext writes a context skeleton and opens it", async () => {
    const file = path.join(workspace, "src", "scaffoldprobe.bynk");
    created.push(file);
    answer = "scaffold.scaffoldprobe";
    await vscode.commands.executeCommand("bynk.newContext");

    assert.strictEqual(fs.readFileSync(file, "utf8"), "context scaffold.scaffoldprobe\n\n");
    const editor = await waitFor(
      () => vscode.window.activeTextEditor,
      (e) => e?.document.uri.fsPath === file,
      "the new file to open",
    );
    assert.strictEqual(editor?.document.languageId, "bynk");

    const validate = options!.validateInput!;
    assert.ok(validate("Not A Name"), "an invalid name is refused");
    assert.strictEqual(validate("scaffold.ok"), undefined);
  });

  it("newContext refuses to overwrite a file", async () => {
    const file = path.join(workspace, "src", "scaffoldprobe.bynk");
    created.push(file);
    fs.writeFileSync(file, "context mine\n");
    answer = "other.scaffoldprobe";
    await vscode.commands.executeCommand("bynk.newContext");
    assert.strictEqual(fs.readFileSync(file, "utf8"), "context mine\n");
    await waitFor(() => errors[0], present, "the refusal");
    assert.match(errors[0], /already exists/);
  });

  it("newContext writes nothing when the input is dismissed", async () => {
    const before = fs.readdirSync(path.join(workspace, "src"));
    answer = undefined;
    await vscode.commands.executeCommand("bynk.newContext");
    assert.deepStrictEqual(fs.readdirSync(path.join(workspace, "src")), before);
  });

  it("newProject refuses a folder that already has a bynk.toml", async () => {
    const toml = path.join(workspace, "bynk.toml");
    const tomlBefore = fs.readFileSync(toml);
    const listing = () => [...fs.readdirSync(workspace), ...fs.readdirSync(path.join(workspace, "src"))].sort();
    const before = listing();
    answer = "scaffold-probe";
    await vscode.commands.executeCommand("bynk.newProject");

    assert.ok(Buffer.from(fs.readFileSync(toml)).equals(tomlBefore), "bynk.toml is untouched");
    assert.deepStrictEqual(listing(), before, "no file was created");
    await waitFor(() => errors[0], present, "the refusal");
    assert.match(errors[0], /already has a bynk\.toml/);

    const validate = options!.validateInput!;
    assert.ok(validate("My App"), "an invalid name is refused");
    assert.strictEqual(validate("my-app"), undefined);
  });
});
