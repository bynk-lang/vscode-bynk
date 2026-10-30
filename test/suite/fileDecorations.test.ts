// #2478: the Explorer file decorations, inside the extension host: a context
// badge per file (off for a single-context project), the failing-test tint
// set by a failed case and cleared by a passing re-run, and the settings.
// Read through the `bynk._fileDecoration` test seam `fileDecorations.ts` registers.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const FIXTURES = path.resolve(__dirname, "../../../test/fixtures");

interface Decoration {
  badge?: string;
  tooltip?: string;
  failed: boolean;
  contractBreak: boolean;
  tint?: "failed" | "contractBreak";
  propagate: boolean;
}

const decoration = (file: string): Thenable<Decoration> =>
  vscode.commands.executeCommand<Decoration>("bynk._fileDecoration", vscode.Uri.file(file).toString());

describe("Bynk Explorer file decorations (#2478)", () => {
  let dir: string;
  let billing: string;

  before(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".fd-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "fd"\n\n[paths]\ninclude = ["src"]\n');
    billing = path.join(dir, "src", "billing.bynk");
    fs.writeFileSync(billing, "context billing\n");
    fs.writeFileSync(path.join(dir, "src", "money.bynk"), "commons money\n");
  });

  after(async () => {
    await vscode.workspace.getConfiguration("bynk.fileDecorations").update("contextBadge", undefined, true);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shows no badge in a single-context project, until asked for", async () => {
    await waitFor(() => decoration(billing), (d) => d.badge === undefined, "scan to settle");
    assert.strictEqual((await decoration(path.join(dir, "src", "money.bynk"))).badge, undefined);
    await vscode.workspace.getConfiguration("bynk.fileDecorations").update("contextBadge", "always", true);
    const d = await waitFor(() => decoration(billing), (x) => x.badge === "BI", "the always badge");
    assert.strictEqual(d.tooltip, "Bynk context billing");
    // Commons carry none.
    assert.strictEqual((await decoration(path.join(dir, "src", "money.bynk"))).badge, undefined);
  });

  it("badges every context once the project has a second", async () => {
    await vscode.workspace.getConfiguration("bynk.fileDecorations").update("contextBadge", "auto", true);
    fs.writeFileSync(path.join(dir, "src", "storefront.bynk"), "context storefront\n");
    // The Explorer asks about every file it shows, the new one included; so does the test.
    const storefront = path.join(dir, "src", "storefront.bynk");
    await waitFor(
      async () => (await decoration(storefront), decoration(billing)),
      (d) => d.badge === "BI",
      "the multi-context badge",
    );
    assert.strictEqual((await decoration(storefront)).badge, "ST");
    await vscode.workspace.getConfiguration("bynk.fileDecorations").update("contextBadge", "never", true);
    await waitFor(() => decoration(billing), (d) => d.badge === undefined, "the badge to switch off");
  });

  it("tints a file whose test failed and clears it when a re-run passes", async function () {
    // The stand-in `bynk` serves the run document; the extension host has its own
    // copy of the failure state, so the run has to go through the real Test Explorer path.
    this.timeout(180_000);
    const textFile = vscode.Uri.file(path.join(FIXTURES, "workspace", "src", "text.bynk"));
    const docDir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-decor-"));
    const fake = await useFakeBynk();
    try {
      const serve = (outcome: string) => {
        const doc = {
          passed: outcome === "pass" ? 1 : 0,
          failed: outcome === "pass" ? 0 : 1,
          suites: [
            {
              name: "text",
              kind: "unit",
              cases: [{ name: "tint probe", outcome, location: { path: "src/text.bynk", line: 1, col: 1 } }],
            },
          ],
        };
        const file = path.join(docDir, `doc-${outcome}.json`);
        fs.writeFileSync(file, JSON.stringify(doc));
        process.env.BYNK_FAKE_TEST_DOC = file;
      };

      serve("fail");
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(textFile));
      await vscode.commands.executeCommand("testing.refreshTests");
      await vscode.commands.executeCommand("bynk.runTestsInFile", textFile);
      await waitFor(() => decoration(textFile.fsPath), (d) => d.failed, "the failed run to tint the file", 45_000);

      // A file that both failed and breaks the contract: the failure's red wins
      // the colour, the break still shows in the badge and tooltip, and both carry
      // up to the folders.
      const server = vscode.languages.createDiagnosticCollection("bynk-both-test");
      try {
        const brk = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "not additive", vscode.DiagnosticSeverity.Error);
        brk.code = "bynk.agent.non_additive_state_change";
        server.set(textFile, [brk]);
        const both = await waitFor(() => decoration(textFile.fsPath), (d) => d.contractBreak, "the break beside the failure");
        assert.strictEqual(both.tint, "failed", "the failure's colour wins");
        assert.strictEqual(both.failed, true);
        assert.strictEqual(both.propagate, true);
        assert.ok(both.tooltip?.includes("Tests failed") && both.tooltip.includes("Contract break"), both.tooltip ?? "");
      } finally {
        server.dispose();
      }

      await vscode.workspace.getConfiguration("bynk.fileDecorations").update("failedTests", false, true);
      await waitFor(() => decoration(textFile.fsPath), (d) => !d.failed, "the setting to turn the tint off");
      await vscode.workspace.getConfiguration("bynk.fileDecorations").update("failedTests", undefined, true);
      await waitFor(() => decoration(textFile.fsPath), (d) => d.failed, "the setting to bring the tint back");

      serve("pass");
      await vscode.commands.executeCommand("testing.refreshTests");
      await vscode.commands.executeCommand("bynk.runTestsInFile", textFile);
      await waitFor(() => decoration(textFile.fsPath), (d) => !d.failed, "a passing re-run to clear the tint", 45_000);
    } finally {
      delete process.env.BYNK_FAKE_TEST_DOC;
      await fake.restore();
      fs.rmSync(docDir, { recursive: true, force: true });
    }
  });

  it("marks a file the server reports a contract break in, and clears it (#2519)", async function () {
    this.timeout(185_000);
    const config = vscode.workspace.getConfiguration("bynk.fileDecorations");
    // A stand-in for the language server: the decoration reads the editor's
    // diagnostics, whoever published them.
    const server = vscode.languages.createDiagnosticCollection("bynk-contract-break-test");
    const uri = vscode.Uri.file(billing);
    const range = new vscode.Range(0, 0, 0, 1);
    const publish = (code: vscode.Diagnostic["code"]) => {
      const d = new vscode.Diagnostic(range, "not additive", vscode.DiagnosticSeverity.Error);
      d.code = code;
      server.set(uri, [d]);
    };
    try {
      await config.update("contextBadge", "never", true);
      await waitFor(() => decoration(billing), (d) => d.badge === undefined, "the badge to switch off");

      publish("bynk.type.mismatch");
      assert.strictEqual((await decoration(billing)).contractBreak, false, "another diagnostic is not a break");

      publish("bynk.event.non_additive_schema_change");
      const marked = await waitFor(() => decoration(billing), (d) => d.contractBreak, "the break to be marked");
      assert.strictEqual(marked.badge, "!");
      assert.strictEqual(marked.tint, "contractBreak");
      // The tint carries up to the folders above the file.
      assert.strictEqual(marked.propagate, true);
      assert.ok(marked.tooltip?.includes("Show Contract Diff"), marked.tooltip ?? "");

      // A context badge keeps its slot; the break stays in the tooltip and tint.
      await config.update("contextBadge", "always", true);
      const both = await waitFor(() => decoration(billing), (d) => d.badge === "BI" && d.contractBreak, "badge and break");
      assert.ok(both.tooltip?.includes("Bynk context billing"), both.tooltip ?? "");

      await config.update("contractBreaks", false, true);
      await waitFor(() => decoration(billing), (d) => !d.contractBreak, "the setting to turn the marker off");
      await config.update("contractBreaks", undefined, true);
      await waitFor(() => decoration(billing), (d) => d.contractBreak, "the setting to bring it back");

      publish({ value: "bynk.agent.non_additive_state_change", target: vscode.Uri.parse("https://bynk-lang.org") });
      await waitFor(() => decoration(billing), (d) => d.contractBreak, "a linked code to count");

      server.delete(uri);
      await waitFor(() => decoration(billing), (d) => !d.contractBreak, "the marker to clear with the diagnostic");
    } finally {
      server.dispose();
      await config.update("contractBreaks", undefined, true);
      await config.update("contextBadge", undefined, true);
    }
  });
});
