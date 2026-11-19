// #213: Insert Handler Call… for a cron and a queue handler, against the real
// pinned toolchain. The call is inserted into an empty cell from the picker,
// the cell is run (a schedule's `Result` is shown; a `QueueResult`, which
// `bynk eval` cannot report, says there is no value to show), the notebook is
// promoted to the unit's suite with the offered check ticked, and the pinned
// `bynk test` passes. Runs in the extension host, where runTest.ts has put the
// pinned toolchain (`npm run fetch:toolchain` → .bynk-test-bin) on PATH; it
// fails, rather than skips, if `bynk` is not there.

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const CONTROLLER_ID = "bynk-notebook-controller";

const JOBS = `context jobs

type EmailJob = { to: String, subject: String }

service sweeper from cron {
  on schedule("*/5 * * * *") () -> Effect[Result[(), String]] {
    Ok(())
  }
  on schedule("0 * * * *") (at: Int) -> Effect[Result[(), String]] {
    Err("bad hour")
  }
}

service outbox from queue("outbound-email") {
  on message(message: EmailJob) -> Effect[QueueResult] {
    Ack
  }
}
`;
const JOBS_SUITE = `suite jobs as unit {
  case "noop" {
    expect 1 == 1
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

const textOf = (cell: vscode.NotebookCell): string => cell.outputs.flatMap((o) => o.items.filter((i) => i.mime === "text/plain").map((i) => new TextDecoder().decode(i.data))).join("\n");

describe("Insert Handler Call for a cron and a queue handler (#213)", () => {
  let dir: string;
  const win = vscode.window as unknown as Record<string, unknown>;
  const saved = { pick: win.showQuickPick, input: win.showInputBox, info: win.showInformationMessage, error: win.showErrorMessage };
  const refusals: string[] = [];
  const offered: string[][] = [];

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".nk-")));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "nk"\n\n[paths]\ninclude = ["src", "tests"]\n');
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "jobs.bynk"), JOBS);
    fs.writeFileSync(path.join(dir, "tests", "jobs.bynk"), JOBS_SUITE);
    fs.writeFileSync(
      path.join(dir, "jobs.bynknb"),
      JSON.stringify({
        version: 1,
        unit: "jobs",
        cells: [
          { kind: "markdown", source: ["# Jobs"] },
          { kind: "markdown", source: ["## The hourly sweep", "", "It is given the scheduled time."] },
          { kind: "code", source: [""] },
          { kind: "markdown", source: ["## Sending an email job"] },
          { kind: "code", source: [""] },
        ],
      }),
    );
  });

  beforeEach(() => {
    refusals.length = 0;
    offered.length = 0;
    // Pick the handler named in `wanted`; tick every check offered except the
    // `Retry` one (a queue verdict is the user's to choose, and only one is true).
    win.showQuickPick = async (items: readonly (string | { label: string; kind?: number })[], opts?: { canPickMany?: boolean }) => {
      const real = items.filter((i) => typeof i === "string" || i.kind !== vscode.QuickPickItemKind.Separator);
      offered.push(real.map((i) => (typeof i === "string" ? i : i.label)));
      if (opts?.canPickMany) return real.filter((i) => typeof i !== "string" && !/Retry/.test(i.label));
      return real.find((i) => typeof i !== "string" && i.label.includes(wanted)) ?? real[0];
    };
    win.showInputBox = async (o: vscode.InputBoxOptions) => o.value;
    win.showInformationMessage = async () => "Write";
    win.showErrorMessage = async (m: string) => {
      refusals.push(m);
      return undefined;
    };
  });
  let wanted = "";

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

  async function insert(doc: vscode.NotebookDocument, index: number, handler: string): Promise<void> {
    wanted = handler;
    const editor = vscode.window.activeNotebookEditor;
    assert.ok(editor, "the notebook is shown");
    editor.selections = [new vscode.NotebookRange(index, index + 1)];
    // The language server answers once it has analysed the project: ask until the cell has its call.
    await waitFor(
      async () => {
        await vscode.commands.executeCommand("bynk.notebook.insertHandlerCall");
        return doc.cellAt(index).document.getText();
      },
      (t) => t.trim() !== "",
      "the call to be inserted",
      90_000,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}; wanted ${handler}; the picker offered ${JSON.stringify(offered[offered.length - 1])}; refusals: ${JSON.stringify([...new Set(refusals)])}`);
    });
  }

  it("inserts a cron and a queue call, runs them, promotes them, and `bynk test` passes", async function () {
    this.timeout(400_000);
    const bynk = findBynk();
    assert.ok(bynk, "`bynk` is not on PATH (npm run fetch:toolchain)");
    const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(path.join(dir, "jobs.bynknb")));
    await vscode.window.showNotebookDocument(doc);

    await insert(doc, 2, 'sweeper.schedule("0 * * * *")');
    await insert(doc, 4, "outbox.message");

    // Every kind is listed, grouped; the schedule is the exact expression, and the handler's `at` is given a sample.
    assert.ok(offered[0].includes('sweeper.schedule("*/5 * * * *")') && offered[0].includes('sweeper.schedule("0 * * * *")') && offered[0].includes("outbox.message(…)"), JSON.stringify(offered[0]));
    assert.strictEqual(doc.cellAt(2).document.getText().includes('let response <- sweeper.schedule("0 * * * *", 1)'), true, doc.cellAt(2).document.getText());
    assert.ok(doc.cellAt(2).document.getText().startsWith("// @handler"), doc.cellAt(2).document.getText());
    assert.ok(doc.cellAt(4).document.getText().includes('let response <- outbox.message(EmailJob { to: "sample", subject: "sample" })'), doc.cellAt(4).document.getText());

    await vscode.commands.executeCommand("notebook.selectKernel", { id: CONTROLLER_ID, extension: EXT_ID });
    await vscode.commands.executeCommand("notebook.execute");
    const cells = doc.getCells();
    await waitFor(() => [2, 4].every((i) => cells[i].outputs.length > 0), (v): v is true => v === true, "the cells' outputs", 150_000);

    // A schedule's `Result[(), String]` is shown as a value; a `QueueResult` says there is none.
    assert.strictEqual(cells[2].executionSummary?.success, true, textOf(cells[2]));
    assert.match(textOf(cells[2]), /Err\("bad hour"\)\s*: Result\[\(\), String\]/);
    assert.strictEqual(cells[4].executionSummary?.success, true, textOf(cells[4]));
    assert.match(textOf(cells[4]), /The call ran\. Its value, of type `QueueResult`, has no wire shape.*no value to show/);

    const target = await waitFor(
      () => vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.notebook.promoteNotebook", { notebook: doc }),
      (t) => t !== undefined,
      `the suite to be extended${refusals.length > 0 ? ` (${refusals.join("; ")})` : ""}`,
      120_000,
    );
    assert.strictEqual(target.fsPath, path.join(dir, "tests", "jobs.bynk"));
    const text = fs.readFileSync(target.fsPath, "utf8");
    assert.ok(text.includes('case "The hourly sweep" {') && text.includes('case "Sending an email job" {'), text);
    // The offered checks follow each result's type; the queue's Ack was the one ticked.
    assert.ok(text.includes('let response <- sweeper.schedule("0 * * * *", 1)\n    expect response is Err(_)') || text.includes('let response <- sweeper.schedule("0 * * * *", 1)\n\t\texpect response is Err(_)'), text);
    assert.ok(/expect response is Ack/.test(text) && !/Retry/.test(text), text);

    const check = spawnSync(bynk, ["check", dir], { encoding: "utf8" });
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    const result = spawnSync(bynk, ["test", dir, "--no-install"], { encoding: "utf8", timeout: 250_000 });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /✓ noop/);
    assert.match(result.stdout, /✓ The hourly sweep/);
    assert.match(result.stdout, /✓ Sending an email job/);
    assert.match(result.stdout, /3 passed, 0 failed/);
  });
});
