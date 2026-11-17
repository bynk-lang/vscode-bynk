// #151: Bynk notebooks, the editor side. The pure part (the file, the snippet
// sent for a cell, reading the result, showing a value) is `notebookCore.ts`.
//
// A cell is run by `bynk eval`, which compiles and runs the cell's code with the
// build and runner of `bynk test`: it is the user's own code, at the trust of
// `bynk test` (ADR 0638 in bynk-lang/bynk, which rejected `bynk eval` for the
// refined-type hover, rests on a hover not running the project). So a cell runs
// only when the user runs it: never on open, on a hover or on a save.

import * as vscode from "vscode";

import { BynkNotFoundError, projectNames, runBynk } from "./cli";
import { dirtyBuffers } from "./dirtyBuffers";
import {
  NOTEBOOK_TYPE,
  analyseCell,
  buildSnippet,
  decodeEval,
  evalArgs,
  isUnitName,
  placeDiagnostics,
  renderValue,
  snippetNotes,
  unitFor,
  unitNames,
  type CellDiagnostic,
  type CellInput,
  type EvalResult,
} from "./notebookCore";
import { registerNotebookSerializer } from "./notebookSerializer";
import { activeProjectRoot, projectRootFor } from "./projectRoots";

const CONTROLLER_ID = "bynk-notebook-controller";
/** The extension kills `bynk eval` this long after its own time limit, in case
 *  the CLI itself hangs instead of reporting a timeout. */
const GRACE_MS = 15_000;

/** The units a project declares, sorted: what a cell's unit is chosen from. */
const projectUnits = (root: vscode.Uri): Promise<string[]> => projectNames(root, unitNames, true);

/** What a cell last ran as, when it ran without a problem: its source and the
 *  unit it ran in. A cell edited since, or run in another unit since (the
 *  notebook's unit was changed), counts as not run: its `let`s may no longer hold. */
type Ran = Map<string, { source: string; unit: string }>;

export function registerNotebook(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("bynk-notebook");
  const output = vscode.window.createOutputChannel("Bynk Notebook");
  const ran = new Map<string, Ran>();
  context.subscriptions.push(diagnostics, output);

  context.subscriptions.push(
    registerNotebookSerializer(),
  );

  const controller = vscode.notebooks.createNotebookController(CONTROLLER_ID, NOTEBOOK_TYPE, "Bynk");
  controller.supportedLanguages = ["bynk"];
  controller.supportsExecutionOrder = true;
  controller.description = "Evaluate with bynk eval";
  context.subscriptions.push(controller);

  const ranFor = (nb: vscode.NotebookDocument): Ran => {
    const key = nb.uri.toString();
    let r = ran.get(key);
    if (!r) ran.set(key, (r = new Map()));
    return r;
  };
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      ran.delete(nb.uri.toString());
      for (const c of nb.getCells()) diagnostics.delete(c.document.uri);
    }),
  );

  /** The unit a cell runs in, asking once (and remembering it for the notebook)
   *  when neither the cell nor the notebook names one. */
  async function resolveUnit(nb: vscode.NotebookDocument, cell: vscode.NotebookCell, root: vscode.Uri): Promise<string | undefined> {
    const own = unitFor(analyseCell(cell.document.getText()), typeof nb.metadata?.unit === "string" ? nb.metadata.unit : undefined);
    if (own) return own;
    return chooseUnit(nb, root);
  }

  async function chooseUnit(nb: vscode.NotebookDocument, root: vscode.Uri): Promise<string | undefined> {
    const units = await projectUnits(root);
    if (units.length === 0) {
      void vscode.window.showErrorMessage("Bynk Notebook: this project declares no `commons` or `context` to evaluate in.");
      return undefined;
    }
    const current = typeof nb.metadata?.unit === "string" ? nb.metadata.unit : undefined;
    const pick = await vscode.window.showQuickPick(
      units.map((u) => ({ label: u, description: u === current ? "current" : undefined })),
      { title: "Bynk Notebook: the unit cells run in", placeHolder: "A cell can name its own with `// @unit name` on its first line", ignoreFocusOut: true },
    );
    if (!pick) return undefined;
    const edit = new vscode.WorkspaceEdit();
    edit.set(nb.uri, [vscode.NotebookEdit.updateNotebookMetadata({ ...nb.metadata, unit: pick.label })]);
    await vscode.workspace.applyEdit(edit);
    return pick.label;
  }

  function timeoutSeconds(): number | undefined {
    const n = vscode.workspace.getConfiguration("bynk").get<number>("notebook.timeoutSeconds");
    return typeof n === "number" && n >= 1 ? n : undefined;
  }

  /** `bynk eval`, killed by the extension if the CLI itself does not finish.
   *  `"cancelled"` when the user stopped it. */
  async function evaluate(args: string[], root: string, stdin: string | undefined, token: vscode.CancellationToken, seconds: number): Promise<EvalResult | "cancelled"> {
    const source = new vscode.CancellationTokenSource();
    const sub = token.onCancellationRequested(() => source.cancel());
    const timer = setTimeout(() => source.cancel(), seconds * 1000 + GRACE_MS);
    try {
      const r = await runBynk(args, root, source.token, stdin);
      if (token.isCancellationRequested) return "cancelled";
      if (source.token.isCancellationRequested) return { kind: "error", errorKind: "timeout", message: `bynk eval did not finish within ${seconds} seconds and was stopped.`, diagnostics: [] };
      return decodeEval(r.stdout, r.stderr, r.code);
    } catch (e) {
      const message = e instanceof BynkNotFoundError ? e.message : e instanceof Error ? e.message : String(e);
      return { kind: "error", errorKind: "setup", message, diagnostics: [] };
    } finally {
      clearTimeout(timer);
      sub.dispose();
      source.dispose();
    }
  }

  async function runCell(nb: vscode.NotebookDocument, cell: vscode.NotebookCell, execution: vscode.NotebookCellExecution): Promise<void> {
    diagnostics.delete(cell.document.uri);
    const fail = (message: string): void => {
      void execution.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(message))]));
      execution.end(false, Date.now());
    };
    execution.start(Date.now());
    void execution.clearOutput();
    if (!vscode.workspace.isTrusted) return fail("Trust this workspace to run a Bynk cell: it compiles and runs your project's code.");
    if (nb.metadata?.invalid) return fail("This file is not a Bynk notebook; there is nothing to run.");
    const root = await projectRootFor(nb.uri);
    if (!root) return fail("This notebook is not in a Bynk project (no `bynk.toml` above it). Save it inside the project first.");
    const unit = await resolveUnit(nb, cell, root);
    if (!unit) return fail("Choose the unit this cell runs in: a `commons` or `context` of the project, or write `// @unit name` on its first line.");
    if (!isUnitName(unit)) return fail(`\`${unit}\` is not a unit name.`);

    const mine = ranFor(nb);
    const notebookUnit = typeof nb.metadata?.unit === "string" ? nb.metadata.unit : undefined;
    const cells: CellInput[] = nb
      .getCells()
      .filter((c) => c.kind === vscode.NotebookCellKind.Code)
      .map((c) => {
        const source = c.document.getText();
        // The unit it runs in, resolved the way the cell being run's was: a cell
        // with no `// @unit` is in the notebook's, not in this cell's.
        const resolved = unitFor(analyseCell(source), notebookUnit) ?? "";
        const last = mine.get(c.document.uri.toString());
        const same = last !== undefined && last.source === source && last.unit === resolved;
        return { source, unit: resolved, ran: same, edited: last !== undefined && !same };
      });
    const codeCells = nb.getCells().filter((c) => c.kind === vscode.NotebookCellKind.Code);
    const index = codeCells.findIndex((c) => c.index === cell.index);
    const snippet = buildSnippet(cells, index, unit);
    if (snippet.text.trim() === "") return fail("This cell has no code to evaluate.");

    const buffers = dirtyBuffers(root.fsPath);
    const seconds = timeoutSeconds() ?? 60;
    const args = evalArgs({ root: root.fsPath, unit, snippet: snippet.text, sourcesStdin: Object.keys(buffers).length > 0, timeoutSeconds: timeoutSeconds() });
    const evaluated = await evaluate(args, root.fsPath, Object.keys(buffers).length > 0 ? JSON.stringify(buffers) : undefined, execution.token, seconds);
    if (evaluated === "cancelled") {
      // The user stopped it: not a failure to show as an error.
      execution.end(undefined, Date.now());
      return;
    }
    const result = evaluated;

    const placed = placeDiagnostics(result.diagnostics, snippet.origins);
    showDiagnostics(codeCells[index], index, placed);
    const items: vscode.NotebookCellOutputItem[] = [];
    const notes: string[] = [];
    notes.push(...snippetNotes(snippet, (i) => `cell ${codeCells[i].index + 1}`));
    // Problems that can't sit on this cell's lines are listed here instead.
    const elsewhere = placed.filter((d) => d.cell === undefined || d.cell !== index);
    for (const d of elsewhere) notes.push(describe(d, codeCells, index));

    let ok = false;
    switch (result.kind) {
      case "value":
        ok = true;
        items.push(vscode.NotebookCellOutputItem.text(`${renderValue(result.value)}\n: ${result.type}`, "text/plain"));
        items.push(vscode.NotebookCellOutputItem.json({ value: result.value, type: result.type }, "application/json"));
        break;
      case "diagnostics":
        items.push(vscode.NotebookCellOutputItem.text(placed.length > 0 ? "The cell doesn't check." : "bynk eval gave no value.", "text/plain"));
        break;
      case "error":
        items.push(vscode.NotebookCellOutputItem.error(Object.assign(new Error(result.message), { name: result.errorKind === "timeout" ? "Timed out" : result.errorKind === "setup" ? "Could not run" : "Runtime error" })));
        break;
    }
    // The notes are an output of their own: one output holds one item per mime
    // type, so a second `text/plain` beside the value would be dropped.
    const outputs = [new vscode.NotebookCellOutput(items)];
    if (notes.length > 0) outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(notes.join("\n"), "text/plain")]));
    await execution.replaceOutput(outputs);
    if (ok && placed.every((d) => d.severity !== "error")) mine.set(cell.document.uri.toString(), { source: cell.document.getText(), unit });
    else mine.delete(cell.document.uri.toString());
    execution.end(ok, Date.now());
  }

  /** Diagnostics go on the cell being run only. A problem in a line an earlier
   *  cell wrote is listed in this cell's output instead: a diagnostic set on the
   *  earlier cell would stay there after the problem is fixed, until that cell
   *  was itself run again. */
  function showDiagnostics(cell: vscode.NotebookCell, index: number, placed: readonly CellDiagnostic[]): void {
    const doc = cell.document;
    const list: vscode.Diagnostic[] = [];
    for (const d of placed) {
      if (d.cell !== index || d.at === undefined) continue;
      const line = Math.min(d.at, doc.lineCount - 1);
      const col = Math.max(0, d.col - 1);
      const range = new vscode.Range(line, Math.min(col, doc.lineAt(line).text.length), line, doc.lineAt(line).text.length);
      const diag = new vscode.Diagnostic(range, d.message, d.severity === "error" ? vscode.DiagnosticSeverity.Error : d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
      diag.source = "bynk eval";
      if (d.code) diag.code = d.code;
      list.push(diag);
    }
    if (list.length > 0) diagnostics.set(doc.uri, list);
  }

  function describe(d: CellDiagnostic, codeCells: readonly vscode.NotebookCell[], index: number): string {
    const where = d.file !== undefined ? `${d.file}:${d.line}:${d.col}` : d.cell !== undefined && d.cell !== index ? `cell ${(codeCells[d.cell]?.index ?? d.cell) + 1}, line ${(d.at ?? 0) + 1}` : `line ${d.line}`;
    return `${d.severity} in ${where}${d.code ? ` (${d.code})` : ""}: ${d.message}`;
  }

  controller.executeHandler = async (cells, nb) => {
    // Cells run one after another: a later cell reads the earlier one's `let`s.
    for (const cell of cells) {
      const execution = controller.createNotebookCellExecution(cell);
      try {
        await runCell(nb, cell, execution);
      } catch (e) {
        output.appendLine(`cell ${cell.index + 1}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        void execution.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(e instanceof Error ? e : new Error(String(e)))]));
        execution.end(false, Date.now());
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("bynk.notebook.new", async () => {
      const root = await activeProjectRoot();
      const cells = [
        new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, "# Bynk notebook\n\nRun a cell to evaluate it with `bynk eval`. A cell runs in the notebook's unit, or the one on its first line: `// @unit shop.money`. Earlier cells' `let`s are available to the cells after them.", "markdown"),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "bynk"),
      ];
      const data = new vscode.NotebookData(cells);
      const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
      await vscode.window.showNotebookDocument(doc);
      if (root) await chooseUnit(doc, root);
    }),
    vscode.commands.registerCommand("bynk.notebook.chooseUnit", async () => {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      if (nb?.notebookType !== NOTEBOOK_TYPE) return;
      const root = await projectRootFor(nb.uri);
      if (!root) {
        void vscode.window.showErrorMessage("Bynk Notebook: this notebook is not in a Bynk project (no `bynk.toml` above it).");
        return;
      }
      await chooseUnit(nb, root);
    }),
  );
}
