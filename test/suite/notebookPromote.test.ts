// #210: promote a notebook cell to a test case, and a notebook to a suite,
// against the real pinned toolchain. A handler cell is run, its response is
// offered as assertions (all ticked here), the case is added to the unit's
// existing suite without disturbing it, and the pinned `bynk test` runs the
// result and passes. The same for a notebook written to a new suite. Runs in the
// extension host, where runTest.ts has put the pinned toolchain
// (`npm run fetch:toolchain` → .bynk-test-bin) on PATH; it fails, rather than
// skips, if `bynk` is not there, so CI cannot pass unchecked.

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const CONTROLLER_ID = "bynk-notebook-controller";

const TODOS = `context todos

type Title = String where NonEmpty
type Todo = { title: Title, done: Bool }
type UserId = opaque String

actor User { auth = Bearer(secret = "TODOS_JWT_SECRET"), identity = UserId }

capability Mailer {
  fn send(to: String) -> Effect[Bool]
}

service api from http {
  on POST("/todos") (body: Todo) -> Effect[HttpResult[Todo]] by u: User given Mailer {
    let sent <- Mailer.send("bob")
    if sent { Created(body) } else { BadRequest("no mail") }
  }
}
`;
const TODOS_SUITE = `suite todos as unit {
  stub Mailer.send(_) returns true

  case "noop" {
    expect 1 == 1
  }
}
`;
const PLAIN = `context plain

capability Notifier {
  fn ping(to: String) -> Effect[Bool]
}

service api from http {
  on POST("/ping/:who") (who: String) -> Effect[HttpResult[String]] by v: Visitor given Notifier {
    let ok <- Notifier.ping(who)
    if ok { Ok(who) } else { Conflict("busy") }
  }
}
`;
const TODO_CALL = 'let r <- api.POST("/todos", Todo { title: "a", done: false }) by User(UserId.unsafe("bob"))';

function findBynk(): string | undefined {
  const exe = process.platform === "win32" ? "bynk.exe" : "bynk";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

describe("Promote a notebook cell to a test case (#210)", () => {
  let dir: string;
  const win = vscode.window as unknown as Record<string, unknown>;
  const saved = { pick: win.showQuickPick, input: win.showInputBox, info: win.showInformationMessage, error: win.showErrorMessage };
  let summary = "";
  const refusals: string[] = [];

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".np-")));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "np"\n\n[paths]\ninclude = ["src", "tests"]\n');
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "todos.bynk"), TODOS);
    fs.writeFileSync(path.join(dir, "src", "plain.bynk"), PLAIN);
    fs.writeFileSync(path.join(dir, "tests", "todos.bynk"), TODOS_SUITE);
    const notebook = (unit: string, cells: unknown[]): void => fs.writeFileSync(path.join(dir, `${unit}.bynknb`), JSON.stringify({ version: 1, unit, cells }, null, 2));
    notebook("todos", [
      { kind: "markdown", source: ["# Todos"] },
      { kind: "markdown", source: ["## Creating a todo", "", "A created todo is answered with `Created`, and the owner is mailed (stubbed here)."] },
      { kind: "code", source: ["// @handler", "stub Mailer.send(_) returns true", TODO_CALL] },
    ]);
    notebook("plain", [
      { kind: "markdown", source: ["# Pinging"] },
      { kind: "markdown", source: ["## A reachable address", "", "The handler answers with the name it was given."] },
      { kind: "code", source: ["// @handler", "stub Notifier.ping(_) returns true", 'api.POST("/ping/:who", "ann") by Visitor'] },
      { kind: "markdown", source: ["## An unreachable one"] },
      { kind: "code", source: ["// @handler", "stub Notifier.ping(_) returns false", 'let r <- api.POST("/ping/:who", "bob") by Visitor'] },
    ]);
  });

  beforeEach(() => {
    summary = "";
    refusals.length = 0;
    // Tick every assertion offered, keep every suggested name, write what is offered.
    win.showQuickPick = async (items: readonly unknown[], opts?: { canPickMany?: boolean }) => (opts?.canPickMany ? items : (items as unknown[])[0]);
    win.showInputBox = async (o: vscode.InputBoxOptions) => o.value;
    win.showInformationMessage = async (_m: string, opts?: { detail?: string }) => {
      summary = opts?.detail ?? "";
      return "Write";
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

  const run = async (nbPath: string, cellIndexes: number[]): Promise<vscode.NotebookDocument> => {
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(nbPath));
    await vscode.window.showNotebookDocument(doc);
    await vscode.commands.executeCommand("notebook.selectKernel", { id: CONTROLLER_ID, extension: EXT_ID });
    await vscode.commands.executeCommand("notebook.execute");
    const cells = doc.getCells();
    await waitFor(() => cellIndexes.every((i) => cells[i].outputs.length > 0), (v): v is true => v === true, "the cells' outputs", 150_000);
    return doc;
  };

  it("adds a handler cell to the unit's suite, keeping its narrative, and `bynk test` passes", async function () {
    this.timeout(300_000);
    const bynk = findBynk();
    assert.ok(bynk, "`bynk` is not on PATH (npm run fetch:toolchain)");
    const doc = await run(path.join(dir, "todos.bynknb"), [2]);
    const cell = doc.cellAt(2);
    assert.strictEqual(cell.executionSummary?.success, true, JSON.stringify(cell.outputs.map((o) => o.items.map((i) => new TextDecoder().decode(i.data)))));

    const target = await waitFor(
      () => vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.notebook.promoteCell", { cell }),
      (t) => t !== undefined,
      `the case to be written${refusals.length > 0 ? ` (${refusals.join("; ")})` : ""}`,
      120_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}${refusals.length > 0 ? `; promote said: ${refusals[refusals.length - 1]}` : ""}`);
    });
    assert.strictEqual(target.fsPath, path.join(dir, "tests", "todos.bynk"));
    const text = fs.readFileSync(target.fsPath, "utf8");

    // The suite's own lines are untouched, and the case is added before its closing brace.
    assert.ok(text.startsWith(TODOS_SUITE.slice(0, TODOS_SUITE.lastIndexOf("}"))), text);
    assert.ok(text.trimEnd().endsWith("}"), text);
    // The narrative is the doc comment; the heading above it is the name.
    assert.ok(text.includes("--- A created todo is answered with `Created`"), text);
    assert.ok(text.includes('case "Creating a todo" {'), text);
    // The cell's stub and call are written bound, without the directive; the output became the ticked checks.
    assert.ok(!text.includes("@handler"), text);
    assert.ok(text.includes("stub Mailer.send(_) returns true"), text);
    assert.ok(text.includes(`${TODO_CALL}`), text);
    assert.ok(text.includes("expect r is Created(_)"), text);
    assert.ok(text.includes("expect payload.done == false"), text);
    assert.ok(text.includes('expect payload.title == "a"'), text);
    assert.match(summary, /Creating a todo: 3 assertions/);

    // The pinned toolchain accepts it and runs it: the existing case and the new one pass.
    const check = spawnSync(bynk, ["check", dir], { encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    const result = spawnSync(bynk, ["test", dir, "--no-install"], { encoding: "utf8", timeout: 250_000 });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /✓ noop/);
    assert.match(result.stdout, /✓ Creating a todo/);
    assert.match(result.stdout, /2 passed, 0 failed/);
  });

  it("writes a whole notebook as a new suite, a case per cell, and `bynk test` passes", async function () {
    this.timeout(300_000);
    const bynk = findBynk();
    assert.ok(bynk, "`bynk` is not on PATH (npm run fetch:toolchain)");
    await run(path.join(dir, "plain.bynknb"), [2, 4]);
    const doc = vscode.workspace.notebookDocuments.find((d) => d.uri.fsPath === path.join(dir, "plain.bynknb"));
    assert.ok(doc);

    const target = await waitFor(
      () => vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.notebook.promoteNotebook", { notebook: doc }),
      (t) => t !== undefined,
      "the suite to be written",
      120_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}${refusals.length > 0 ? `; promote said: ${refusals[refusals.length - 1]}` : ""}`);
    });
    assert.strictEqual(target.fsPath, path.join(dir, "tests", "plain.bynk"));
    const text = fs.readFileSync(target.fsPath, "utf8");
    assert.ok(text.includes("--- Pinging\nsuite plain {"), text);
    assert.ok(text.includes('case "A reachable address" {'), text);
    assert.ok(text.includes('case "An unreachable one" {'), text);
    assert.ok(text.includes("--- The handler answers with the name it was given."), text);
    assert.ok(text.includes('let response <- api.POST("/ping/:who", "ann") by Visitor'), text);
    assert.ok(text.includes("expect response is Ok(_)") && text.includes("expect r is Conflict(_)"), text);
    assert.ok(text.includes('expect payload == "ann"') && text.includes('expect payload == "busy"'), text);

    const check = spawnSync(bynk, ["check", dir], { encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    const result = spawnSync(bynk, ["test", dir, "--no-install"], { encoding: "utf8", timeout: 250_000 });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /✓ A reachable address/);
    assert.match(result.stdout, /✓ An unreachable one/);
    assert.match(result.stdout, /(\d+) passed, 0 failed/);
  });

  it("writes nothing when the generated case doesn't check", async function () {
    this.timeout(300_000);
    const before = fs.readFileSync(path.join(dir, "tests", "todos.bynk"), "utf8");
    const doc = vscode.workspace.notebookDocuments.find((d) => d.uri.fsPath === path.join(dir, "todos.bynknb"));
    assert.ok(doc);
    // A stub for a capability the unit doesn't consume doesn't check (`bynk.stub.not_a_seam`).
    const cell = doc.cellAt(2);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), ["// @handler", "stub Nope.send(_) returns true", TODO_CALL].join("\n"));
    await vscode.workspace.applyEdit(edit);
    // An edited cell counts as not run, so nothing is offered: the stub is the problem.
    const written = await vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.notebook.promoteCell", { cell });
    assert.strictEqual(written, undefined);
    assert.strictEqual(fs.readFileSync(path.join(dir, "tests", "todos.bynk"), "utf8"), before);
    assert.ok(refusals.some((m) => /doesn't check, so nothing was written/.test(m)), refusals.join("; "));
  });
});
