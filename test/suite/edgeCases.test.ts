// #229: Generate Edge Cases…, against the real pinned toolchain. A route with
// refined fields in its body gets a notebook: the values come from the refined
// types' predicates (`bynk/refinedTypeModel`), their outcomes from the real
// constructor, one handler cell per accepted value and one constructor check per
// refused one. The notebook is run in the controller, promoted with Promote
// Notebook to Suite, and the pinned `bynk test` runs the suite and passes. Runs
// in the extension host, where runTest.ts puts the toolchain
// (`npm run fetch:toolchain` → .bynk-test-bin) on PATH; it fails, rather than
// skips, if `bynk` is not there.

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const CONTROLLER_ID = "bynk-notebook-controller";

const SHOP = `context shop

type Percent = Int where InRange(0, 100)
type Name = String where NonEmpty && MaxLength(5)
type Discount = { name: Name, pct: Percent }

service api from http {
  on POST("/discounts") (body: Discount) -> Effect[HttpResult[Discount]] by v: Visitor {
    Created(body)
  }
}
`;

function findBynk(): string | undefined {
  const exe = process.platform === "win32" ? "bynk.exe" : "bynk";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

describe("Generate Edge Cases… (#229)", () => {
  let dir: string;
  const win = vscode.window as unknown as Record<string, unknown>;
  const saved = { pick: win.showQuickPick, input: win.showInputBox, info: win.showInformationMessage, error: win.showErrorMessage };
  const refusals: string[] = [];
  const said: string[] = [];

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".ec-")));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "ec"\n\n[paths]\ninclude = ["src", "tests"]\n');
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "shop.bynk"), SHOP);
  });

  beforeEach(() => {
    refusals.length = 0;
    said.length = 0;
    win.showQuickPick = async (items: readonly unknown[], opts?: { canPickMany?: boolean }) => (opts?.canPickMany ? items : (items as unknown[])[0]);
    win.showInputBox = async (o: vscode.InputBoxOptions) => o.value;
    win.showInformationMessage = async (m: string, opts?: { detail?: string }) => {
      said.push(m);
      return opts?.detail === undefined ? undefined : "Write";
    };
    win.showErrorMessage = async (m: string) => {
      refusals.push(m);
      return undefined;
    };
  });

  afterEach(() => {
    win.showQuickPick = saved.pick;
    win.showInputBox = saved.input;
    win.showInformationMessage = saved.info;
    win.showErrorMessage = saved.error;
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a notebook of boundary values, runs it, promotes it, and `bynk test` passes", async function () {
    this.timeout(600_000);
    const bynk = findBynk();
    assert.ok(bynk, "`bynk` is not on PATH (npm run fetch:toolchain)");

    const file = vscode.Uri.file(path.join(dir, "src", "shop.bynk"));
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    const line = doc.getText().split("\n").findIndex((l) => l.includes("on POST"));
    const position = { line, character: doc.lineAt(line).text.indexOf("POST") };

    // The server may not have analysed the project yet: ask again until it has.
    const written = await waitFor(
      () => vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.generateEdgeCases", file.toString(), position),
      (u) => u !== undefined,
      `the notebook to be written${refusals.length > 0 ? ` (${refusals[refusals.length - 1]})` : ""}`,
      240_000,
    );
    assert.strictEqual(written.fsPath, path.join(dir, "edge-cases", "edge-cases-POST-discounts.bynknb"));
    const nb = JSON.parse(fs.readFileSync(written.fsPath, "utf8")) as { unit: string; cells: { kind: string; source: string[] }[] };
    assert.strictEqual(nb.unit, "shop");
    const code = nb.cells.filter((c) => c.kind === "code").map((c) => c.source.join("\n"));

    // Both fields' edges, and what the compiler said of each: `-1` and `101` are refused, `0` and `100` accepted;
    // an empty name and six characters are refused, one and five accepted.
    for (const refused of ['Percent.of(-1)', 'Percent.of(101)', 'Name.of("")', 'Name.of("aaaaaa")']) assert.ok(code.includes(`expect ${refused} is Err(_)\n${refused}`), refused);
    const handlers = code.filter((c) => c.startsWith("// @handler"));
    assert.strictEqual(handlers.length, 4);
    assert.ok(handlers.includes('// @handler\nlet response <- api.POST("/discounts", Discount { name: "a", pct: 100 }) by Visitor\nexpect response is Created(_)'), handlers.join("\n--\n"));
    assert.ok(handlers.includes('// @handler\nlet response <- api.POST("/discounts", Discount { name: "aaaaa", pct: 0 }) by Visitor\nexpect response is Created(_)'), handlers.join("\n--\n"));
    assert.ok(said.some((m) => /8 cases for `POST \/discounts` \(4 accepted, 4 refused/.test(m)), said.join("; "));

    // The route's own refusal: the refused values sent raw, expecting the boundary's 400 (run against `bynk dev`, not here).
    const scenario = fs.readFileSync(path.join(dir, "edge-cases", "edge-cases-POST-discounts.bynk-http"), "utf8");
    assert.ok(scenario.startsWith("@context shop\n\n"), scenario);
    assert.strictEqual(scenario.split("\n? status == 400").length - 1, 4, scenario);
    assert.ok(scenario.includes('{"name":"ab","pct":101,"note":') || scenario.includes('"pct":101'), scenario);

    // Generating again numbers the files (the scenario's too) and the notebook names the scenario written.
    const again = await vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.generateEdgeCases", file.toString(), position);
    assert.strictEqual(again?.fsPath, path.join(dir, "edge-cases", "edge-cases-POST-discounts-2.bynknb"));
    assert.ok(fs.existsSync(path.join(dir, "edge-cases", "edge-cases-POST-discounts-2.bynk-http")));
    assert.ok(fs.readFileSync(again.fsPath, "utf8").includes("edge-cases-POST-discounts-2.bynk-http"));

    // Run every cell in the notebook's own controller: each passes its `expect`.
    const notebook = await vscode.workspace.openNotebookDocument(written);
    await vscode.window.showNotebookDocument(notebook);
    await vscode.commands.executeCommand("notebook.selectKernel", { id: CONTROLLER_ID, extension: EXT_ID });
    await vscode.commands.executeCommand("notebook.execute");
    const cells = notebook.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
    await waitFor(() => cells.every((c) => c.outputs.length > 0), (v): v is true => v === true, "the cells' outputs", 400_000);
    for (const c of cells) assert.strictEqual(c.executionSummary?.success, true, `${c.document.getText()}: ${JSON.stringify(c.outputs.map((o) => o.items.map((i) => new TextDecoder().decode(i.data))))}`);

    // Promote Notebook to Suite writes a case per cell, and the pinned toolchain runs them.
    const target = await waitFor(
      () => vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.notebook.promoteNotebook", { notebook }),
      (t) => t !== undefined,
      `the suite to be written${refusals.length > 0 ? ` (${refusals[refusals.length - 1]})` : ""}`,
      120_000,
    );
    assert.strictEqual(target.fsPath, path.join(dir, "tests", "shop.bynk"));
    const suite = fs.readFileSync(target.fsPath, "utf8");
    assert.ok(suite.includes('case "POST /discounts: body.pct = 101 (refused)" {'), suite);
    const check = spawnSync(bynk, ["check", dir], { encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    const result = spawnSync(bynk, ["test", dir, "--no-install"], { encoding: "utf8", timeout: 250_000 });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /✓ POST \/discounts: body\.pct = 101 \(refused\)/);
    assert.match(result.stdout, /8 passed, 0 failed/);
  });

  it("says a route with no refined value has nothing to probe, and writes nothing", async function () {
    this.timeout(300_000);
    const plain = path.join(dir, "src", "plain.bynk");
    fs.writeFileSync(plain, 'context plain\n\nservice api from http {\n  on GET("/ping") () -> Effect[HttpResult[String]] by v: Visitor {\n    Ok("pong")\n  }\n}\n');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(plain));
    await vscode.window.showTextDocument(doc);
    const position = { line: 3, character: 5 };
    await waitFor(
      async () => {
        await vscode.commands.executeCommand("bynk.generateEdgeCases", doc.uri.toString(), position);
        return said.some((m) => /takes no refined value/.test(m));
      },
      (v): v is true => v === true,
      `the message that there is nothing to probe${refusals.length > 0 ? ` (${refusals[refusals.length - 1]})` : ""}`,
      240_000,
    );
    assert.ok(!fs.existsSync(path.join(dir, "edge-cases", "edge-cases-GET-ping.bynknb")));
  });
});
