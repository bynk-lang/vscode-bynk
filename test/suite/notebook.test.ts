// #151: Bynk notebooks end to end, against the real pinned toolchain (`bynk
// eval` needs `tsc` or `tsx`, as `bynk test` does). A notebook opens as cells; a
// cell runs only when it is run; a later cell sees an earlier one's `let`s; a
// problem in a cell is a diagnostic on it.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const CONTROLLER_ID = "bynk-notebook-controller";

const MONEY = `commons shop.money

type Percent = Int where InRange(0, 100)

fn discount(cents: Int, off: Percent) -> Int {
  cents - cents * off / 100
}
`;

const NOTEBOOK = {
  version: 1,
  unit: "shop.money",
  cells: [
    { kind: "markdown", source: ["# Discounts"] },
    { kind: "code", source: ["let base = 2000", "base"] },
    { kind: "code", source: ["discount(base, 25)"] },
    { kind: "code", source: ["Percent.of(150)"] },
    { kind: "code", source: ["let x: Int = \"no\"", "x"] },
    { kind: "code", source: ["// @refined Percent", "50", "150  // too big", "-1", "\"x\"", "100"] },
  ],
};

describe("Bynk notebooks (#151)", () => {
  let dir: string;
  let uri: vscode.Uri;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".nb-")));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "nb"\n\n[paths]\ninclude = ["src"]\n');
    fs.mkdirSync(path.join(dir, "src", "shop"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "shop", "money.bynk"), MONEY);
    fs.writeFileSync(path.join(dir, "tour.bynknb"), JSON.stringify(NOTEBOOK, null, 2));
    uri = vscode.Uri.file(path.join(dir, "tour.bynknb"));
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const text = (cell: vscode.NotebookCell): string[] => cell.outputs.flatMap((o) => o.items.filter((i) => i.mime === "text/plain").map((i) => new TextDecoder().decode(i.data)));

  it("opens a .bynknb as markdown and Bynk cells, and runs nothing on open", async function () {
    this.timeout(60_000);
    const doc = await vscode.workspace.openNotebookDocument(uri);
    assert.strictEqual(doc.notebookType, "bynk-notebook");
    assert.deepStrictEqual(doc.getCells().map((c) => [c.kind, c.document.languageId]), [
      [vscode.NotebookCellKind.Markup, "markdown"],
      [vscode.NotebookCellKind.Code, "bynk"],
      [vscode.NotebookCellKind.Code, "bynk"],
      [vscode.NotebookCellKind.Code, "bynk"],
      [vscode.NotebookCellKind.Code, "bynk"],
      [vscode.NotebookCellKind.Code, "bynk"],
    ]);
    assert.strictEqual(doc.metadata.unit, "shop.money");
    assert.ok(doc.getCells().every((c) => c.outputs.length === 0));
  });

  it("runs the cells with bynk eval, carrying lets forward and showing problems on the cell", async function () {
    this.timeout(180_000);
    const doc = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(doc);
    await vscode.commands.executeCommand("notebook.selectKernel", { id: CONTROLLER_ID, extension: EXT_ID });
    await vscode.commands.executeCommand("notebook.execute");
    const cells = doc.getCells();
    await waitFor(() => cells.slice(1).every((c) => c.outputs.length > 0), (v): v is true => v === true, "every code cell's output", 150_000);

    assert.deepStrictEqual(text(cells[1]), ["2000\n: Int"]);
    // The second cell uses `base`, bound in the first.
    assert.ok(text(cells[2])[0].startsWith("1500\n: Int"), JSON.stringify(text(cells[2])));
    assert.ok(text(cells[2]).some((t) => /Used the `let`s of cell 2/.test(t)), JSON.stringify(text(cells[2])));
    // A refused construction is a value, shown as Bynk writes it.
    assert.ok(text(cells[3])[0].startsWith('Err({ field: "Percent"'), JSON.stringify(text(cells[3])));
    // A cell that does not check gets a diagnostic on its own line, and no value.
    const ds = await waitFor(
      () => vscode.languages.getDiagnostics(cells[4].document.uri),
      (d) => d.length > 0,
      "the cell's diagnostics",
      30_000,
    );
    assert.strictEqual(ds[0].range.start.line, 0);
    assert.strictEqual(ds[0].source, "bynk eval");
    assert.match(ds[0].message, /annotation declares `Int`/);
    // A refined-type cell: one table, every candidate through the real constructor;
    // the candidate that doesn't check is set aside with a diagnostic on its line.
    const table = text(cells[5])[0];
    assert.ok(table.startsWith("Percent: 2 of 5 accepted"), table);
    assert.match(table, /^50\s+accepted$/m);
    assert.match(table, /^150\s+refused\s+must be in range \[0, 100\]$/m);
    assert.match(table, /^-1\s+refused\s+must be in range \[0, 100\]$/m);
    assert.match(table, /^"x"\s+does not check\s+.*expects a `Int` argument/m);
    assert.match(table, /^100\s+accepted$/m);
    const refinedDiagnostics = vscode.languages.getDiagnostics(cells[5].document.uri);
    assert.deepStrictEqual(refinedDiagnostics.map((d) => d.range.start.line), [4]);
    // Nothing from the notebook's last run is saved with it.
    await vscode.commands.executeCommand("workbench.action.files.save");
    assert.ok(!fs.readFileSync(uri.fsPath, "utf8").includes("2000\\n: Int"));
  });
});
