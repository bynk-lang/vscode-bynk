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
  analyseRefined,
  buildSnippet,
  cellKindOf,
  decodeEval,
  decodeRefined,
  evalArgs,
  isUnitName,
  mergeRows,
  placeDiagnostics,
  refinedJson,
  refinedSource,
  renderRefinedTable,
  renderValue,
  setAside,
  snippetNotes,
  unitFor,
  unitNames,
  type CandidateRow,
  type CellDiagnostic,
  type CellInput,
  type EvalResult,
} from "./notebookCore";
import { decodeResponse, handlerSource, noUnitSuite, renderResponse, responseJson, suiteNote, withCall } from "./notebookHandlerCore";
import { registerNotebookSerializer } from "./notebookSerializer";
import { activeProjectRoot, projectRootFor } from "./projectRoots";
import { projectRoutes } from "./scenario";
import { actorClause, writeCall } from "./scenarioPromoteCore";
import { unitMatches } from "./scenarioCore";

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
    // The cell kinds are told apart by `cellKindOf` (a leading `// @…` directive):
    // a refined-type cell is its own run; every other cell is an expression.
    const directive = cellKindOf(cell.document.getText());
    if (directive.kind === "bad-directive") return fail(`${directive.problem} (${directive.directive})`);
    if (directive.kind === "handler") return runHandler({ cell, execution, root, unit, cells, index, codeCells, forget: () => mine.delete(cell.document.uri.toString()) });
    const refined = analyseRefined(cell.document.getText());
    if (refined) return runRefined({ cell, execution, root, unit, cells, index, codeCells, refined, remember: () => mine.set(cell.document.uri.toString(), { source: cell.document.getText(), unit }), forget: () => mine.delete(cell.document.uri.toString()) });
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

  interface HandlerRun {
    cell: vscode.NotebookCell;
    execution: vscode.NotebookCellExecution;
    root: vscode.Uri;
    unit: string;
    cells: CellInput[];
    index: number;
    codeCells: vscode.NotebookCell[];
    forget: () => void;
  }

  /** A handler cell (#191): the cell's `stub`s and typed call, run inside the
   *  unit's own unit-tier suite when it has one (so its stubs and fixtures
   *  apply), else on their own. When the call is the cell's last statement, the
   *  response is read back as a variant and its payload. */
  async function runHandler(r: HandlerRun): Promise<void> {
    const { cell, execution, root, unit, index, codeCells } = r;
    const source = cell.document.getText();
    const { text, cell: observed } = handlerSource(source);
    const snippet = buildSnippet(r.cells.map((c, i) => (i === index ? { ...c, source: text } : c)), index, unit);
    // The cell's own body, not the snippet: stubs and earlier cells' `let`s fill it too.
    if (analyseCell(source).body.length === 0) {
      void execution.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error("This cell has no call to run: write the handler's call under `// @handler`, or use **Bynk: Insert Handler Call…**."))]));
      execution.end(false, Date.now());
      return;
    }
    const buffers = dirtyBuffers(root.fsPath);
    const hasBuffers = Object.keys(buffers).length > 0;
    // One limit for the cell: a second call, without the suite, gets what is left of it.
    const limit = timeoutSeconds() ?? 60;
    const startedAt = Date.now();
    let usedSuite = true;
    let evaluated: EvalResult | "cancelled" | undefined;
    for (const suite of [unit, undefined]) {
      const seconds = Math.max(1, Math.floor(limit - (Date.now() - startedAt) / 1000));
      evaluated = await evaluate(evalArgs({ root: root.fsPath, unit, suite, snippet: snippet.text, sourcesStdin: hasBuffers, timeoutSeconds: seconds }), root.fsPath, hasBuffers ? JSON.stringify(buffers) : undefined, execution.token, seconds);
      if (evaluated === "cancelled") {
        execution.end(undefined, Date.now());
        return;
      }
      usedSuite = suite !== undefined;
      // A unit with no unit-tier suite (none, or only another tier) is run without one.
      if (!(suite !== undefined && evaluated.kind === "error" && evaluated.errorKind === "setup" && noUnitSuite(evaluated.message))) break;
    }
    const result = evaluated as EvalResult;

    const placed = placeDiagnostics(result.diagnostics, snippet.origins);
    // A bare call was bound on its own line: a column there is shifted by the binding.
    const shifted = placed.map((d) => (d.cell === index && d.at !== undefined && d.at === observed.rewritten ? { ...d, col: 1 } : d));
    // A problem in the `match` the extension appended is not on a line the user wrote.
    const inAppended = (d: CellDiagnostic): boolean => observed.appendedFrom !== undefined && d.cell === index && d.at !== undefined && d.at >= observed.appendedFrom;
    showDiagnostics(codeCells[index], index, shifted.filter((d) => !inAppended(d)));
    const notes: string[] = snippetNotes(snippet, (i) => `cell ${codeCells[i].index + 1}`);
    for (const d of shifted.filter((x) => x.cell === undefined || x.cell !== index)) notes.push(describe(d, codeCells, index));
    for (const d of shifted.filter(inAppended)) notes.push(`The extension's \`match\` over the response didn't check (${d.code || d.severity}): ${d.message} End the cell with a \`match\` of your own to show the response.`);
    const hasStubs = snippet.stubs.length > 0 || analyseCell(source).header.some((h) => h.text.trimStart().startsWith("stub"));
    if (result.kind !== "diagnostics") notes.push(suiteNote(unit, usedSuite, hasStubs));

    let items: vscode.NotebookCellOutputItem[] = [];
    let ok = false;
    switch (result.kind) {
      case "value": {
        const response = observed.response ? decodeResponse(result.value) : undefined;
        if (observed.response && !response) {
          items = [vscode.NotebookCellOutputItem.text(`Expected the response of \`${observed.response}\`, got ${renderValue(result.value)}\n: ${result.type}`, "text/plain")];
        } else if (response) {
          ok = response.variant !== null;
          items = [vscode.NotebookCellOutputItem.text(ok ? renderResponse(response) : `${renderResponse(response)}: it is a raw or streamed body. End the cell with a \`match\` of your own to read it.`, "text/plain"), vscode.NotebookCellOutputItem.json(responseJson(response), "application/json")];
        } else {
          ok = true;
          items = [vscode.NotebookCellOutputItem.text(`${renderValue(result.value)}\n: ${result.type}`, "text/plain"), vscode.NotebookCellOutputItem.json({ value: result.value, type: result.type }, "application/json")];
        }
        break;
      }
      case "diagnostics":
        items = [vscode.NotebookCellOutputItem.text(placed.length > 0 ? "The cell doesn't check." : "bynk eval gave no value.", "text/plain")];
        break;
      case "error":
        items = [vscode.NotebookCellOutputItem.error(Object.assign(new Error(result.message), { name: result.errorKind === "timeout" ? "Timed out" : result.errorKind === "setup" ? "Could not run" : "Runtime error" }))];
        break;
    }
    const outputs = [new vscode.NotebookCellOutput(items)];
    if (notes.length > 0) outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(notes.join("\n"), "text/plain")]));
    await execution.replaceOutput(outputs);
    // A handler cell binds nothing a later cell may use: its `let`s would send the
    // call again, in a cell that runs without the suite (and its stubs). It counts
    // as not run, so `buildSnippet` leaves it out.
    r.forget();
    execution.end(ok, Date.now());
  }

  interface RefinedRun {
    cell: vscode.NotebookCell;
    execution: vscode.NotebookCellExecution;
    root: vscode.Uri;
    unit: string;
    cells: CellInput[];
    index: number;
    codeCells: vscode.NotebookCell[];
    refined: NonNullable<ReturnType<typeof analyseRefined>>;
    remember: () => void;
    forget: () => void;
  }

  /** A refined-type cell: every candidate goes through the real constructor,
   *  `Type.of(…)`, in one `bynk eval` call that returns a list of results. A
   *  candidate that does not type-check as the constructor's argument fails the
   *  whole call, so those are reported on their own lines and the rest run again
   *  in a second call. */
  async function runRefined(r: RefinedRun): Promise<void> {
    const { cell, execution, root, unit, index, codeCells, refined } = r;
    if (refined.candidates.length === 0) {
      void execution.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(`Write the values to try, one per line, under \`// @refined ${refined.type}\`.`))]));
      execution.end(false, Date.now());
      return;
    }
    const source = cell.document.getText();
    const buffers = dirtyBuffers(root.fsPath);
    const hasBuffers = Object.keys(buffers).length > 0;
    // One limit for the cell: the second call gets what is left of it.
    const limit = timeoutSeconds() ?? 60;
    const startedAt = Date.now();
    const skip = new Set<number>();
    const invalid: CandidateRow[] = [];
    const shown: CellDiagnostic[] = [];
    const notes: string[] = [];
    let rows: CandidateRow[] | undefined;
    let failure: { items: vscode.NotebookCellOutputItem[]; placed: CellDiagnostic[] } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, sent } = refinedSource(source, refined, skip);
      if (sent.length === 0) break;
      const snippet = buildSnippet(r.cells.map((c, i) => (i === index ? { ...c, source: text } : c)), index, unit);
      const seconds = Math.max(1, Math.floor(limit - (Date.now() - startedAt) / 1000));
      const evaluated = await evaluate(evalArgs({ root: root.fsPath, unit, snippet: snippet.text, sourcesStdin: hasBuffers, timeoutSeconds: seconds }), root.fsPath, hasBuffers ? JSON.stringify(buffers) : undefined, execution.token, seconds);
      if (evaluated === "cancelled") {
        execution.end(undefined, Date.now());
        return;
      }
      const placed = placeDiagnostics(evaluated.diagnostics, snippet.origins);
      if (attempt === 0) notes.push(...snippetNotes(snippet, (i) => `cell ${codeCells[i].index + 1}`));
      const byLine = new Map(sent.map((c) => [c.line, c]));
      const aside = attempt === 0 && evaluated.kind !== "error" ? setAside(placed, sent, index) : undefined;
      if (aside) {
        // Only candidates are at fault: set them aside and run the rest.
        for (const line of aside.skip) skip.add(line);
        invalid.push(...aside.invalid);
        shown.push(...placed.filter((d) => d.severity === "error").map((d) => ({ ...d, col: 1 })));
        continue;
      }
      shown.push(...placed.map((d) => (d.cell === index && d.at !== undefined && byLine.has(d.at) ? { ...d, col: 1 } : d)));
      if (evaluated.kind === "value") {
        rows = decodeRefined(sent, evaluated.value);
        if (!rows) failure = { items: [vscode.NotebookCellOutputItem.text(`Expected a list of results from \`${refined.type}.of\`, got ${renderValue(evaluated.value)}\n: ${evaluated.type}`, "text/plain")], placed };
      } else if (evaluated.kind === "diagnostics") {
        failure = { items: [vscode.NotebookCellOutputItem.text(placed.length > 0 ? "The cell doesn't check." : "bynk eval gave no value.", "text/plain")], placed };
      } else {
        failure = { items: [vscode.NotebookCellOutputItem.error(Object.assign(new Error(evaluated.message), { name: evaluated.errorKind === "timeout" ? "Timed out" : evaluated.errorKind === "setup" ? "Could not run" : "Runtime error" }))], placed };
      }
      break;
    }
    showDiagnostics(cell, index, shown);
    const elsewhere = shown.filter((d) => d.cell === undefined || d.cell !== index);
    for (const d of elsewhere) notes.push(describe(d, codeCells, index));

    const outputs: vscode.NotebookCellOutput[] = [];
    let ok = false;
    if (failure) outputs.push(new vscode.NotebookCellOutput(failure.items));
    else {
      const all = mergeRows(rows, invalid);
      // A cell where no candidate reached the constructor (a misspelt type, say)
      // did not run: it shows what was found, but not as a success.
      ok = rows !== undefined && all.length > 0;
      outputs.push(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(renderRefinedTable(refined.type, all), "text/plain"),
          vscode.NotebookCellOutputItem.json(refinedJson(refined.type, all), "application/json"),
        ]),
      );
    }
    if (notes.length > 0) outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(notes.join("\n"), "text/plain")]));
    await execution.replaceOutput(outputs);
    // Nothing a later cell can use is bound here, but the cell counts as run.
    if (ok) r.remember();
    else r.forget();
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
    vscode.commands.registerCommand("bynk.notebook.insertHandlerCall", async () => {
      const editor = vscode.window.activeNotebookEditor;
      const nb = editor?.notebook;
      const cell = editor && editor.selections[0] ? nb?.cellAt(editor.selections[0].start) : undefined;
      if (!nb || nb.notebookType !== NOTEBOOK_TYPE || !cell || cell.kind !== vscode.NotebookCellKind.Code) {
        void vscode.window.showErrorMessage("Bynk Notebook: select a code cell to put the handler call in.");
        return;
      }
      const source = cell.document.getText();
      const kind = cellKindOf(source);
      if (kind.kind !== "expression" && kind.kind !== "handler") {
        void vscode.window.showErrorMessage(kind.kind === "refined" ? "Bynk Notebook: this is a refined-type cell; use an empty cell for a handler call." : `Bynk Notebook: ${kind.problem}`);
        return;
      }
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage("Bynk Notebook: trust this workspace first; the routes come from the language server's analysis of your project.");
        return;
      }
      const root = await projectRootFor(nb.uri);
      if (!root) {
        void vscode.window.showErrorMessage("Bynk Notebook: this notebook is not in a Bynk project (no `bynk.toml` above it).");
        return;
      }
      const unit = await resolveUnit(nb, cell, root);
      if (!unit) return;
      const { routes, complete } = await projectRoutes(root);
      const here = routes.filter((r) => unitMatches(r.unit, unit) && r.service);
      if (here.length === 0) {
        void vscode.window.showErrorMessage(complete ? `Bynk Notebook: \`${unit}\` serves no HTTP route to call. A handler cell calls an HTTP handler of the cell's unit.` : "Bynk Notebook: the language server hasn't described the project's routes yet. Wait for it to start and try again.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        here.map((r) => ({ label: `${r.method} ${r.path}`, description: r.service, route: r })),
        { title: `Bynk Notebook: the handler of \`${unit}\` to call`, ignoreFocusOut: true },
      );
      if (!pick) return;
      const route = pick.route;
      const admits = route.actors ?? [];
      let actor: string | undefined;
      if (admits.length > 0) {
        actor = admits.includes("Visitor") ? "Visitor" : admits.length === 1 ? admits[0] : await vscode.window.showQuickPick(admits, { title: "Run the call as which actor?", ignoreFocusOut: true });
        if (!actor) return;
      }
      const call = writeCall(route, actor ? actorClause(actor, route.identities?.[actor]) : undefined);
      if (!call) {
        void vscode.window.showErrorMessage(`Bynk Notebook: ${route.method} ${route.path} can't be written as a call (it takes a raw body, or the server named no service).`);
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      const doc = cell.document;
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), withCall(source, call.text, kind.kind));
      await vscode.workspace.applyEdit(edit);
      if (call.holes.length > 0) void vscode.window.showWarningMessage(`Bynk Notebook: fill in ${call.holes.join("; ")}`);
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
