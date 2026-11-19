// #210: **Promote Cell to Test Case** and **Promote Notebook to Suite**, the
// editor side. The translation is `notebookPromoteCore.ts`; this asks the user
// what to keep, checks the result with the compiler in a scratch copy (as
// **Promote Scenario to Test Suite** does, #158) and writes it only if it checks.
//
// The suites are the source of truth: what is written is a one-way copy, and the
// notebook is not run by `bynk test`.

import * as path from "node:path";

import * as vscode from "vscode";

import { dirtyBuffers } from "./dirtyBuffers";
import { NOTEBOOK_TYPE, isUnitName } from "./notebookCore";
import {
  caseNames,
  findSuite,
  insertCases,
  newSuite,
  planCase,
  planSuite,
  renderCase,
  resolveUnits,
  suiteHeading,
  summarise,
  uniqueName,
  unitsOf,
  type CasePlan,
  type CellOutput,
  type PromoteCell,
} from "./notebookPromoteCore";
import { projectRootFor } from "./projectRoots";
import { checkSuiteInCopy } from "./promoteCheck";
import { describeDiagnostic } from "./richDiagnostics";

export interface PromoteDeps {
  /** What a cell showed when it last ran without a problem, if its source and unit are still what ran. */
  outputOf(cell: vscode.NotebookCell, unit: string | undefined): CellOutput | undefined;
  resolveUnit(nb: vscode.NotebookDocument, cell: vscode.NotebookCell, root: vscode.Uri): Promise<string | undefined>;
  chooseUnit(nb: vscode.NotebookDocument, root: vscode.Uri): Promise<string | undefined>;
  output: vscode.OutputChannel;
}

/** The unit-tier suite for `unit` among the project's files: its text (the open
 *  buffer's, when there is one) and whether that has unsaved edits. */
async function findUnitSuite(root: vscode.Uri, unit: string): Promise<{ uri: vscode.Uri; text: string; dirty: boolean } | undefined> {
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), "**/{node_modules,out,.bynk,target,dist,.wrangler,.bynk-test-bin}/**");
  // The conventional place first.
  const preferred = path.join(root.fsPath, "tests", `${unit}.bynk`);
  files.sort((a, b) => Number(b.fsPath === preferred) - Number(a.fsPath === preferred) || (a.fsPath < b.fsPath ? -1 : 1));
  for (const uri of files) {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue;
    }
    const text = doc.getText();
    if (!/^suite\s/m.test(text)) continue;
    const found = findSuite(text, unit);
    if (found && found.tier === "unit") return { uri, text, dirty: doc.isDirty };
  }
  return undefined;
}

/** A path for a new suite: `tests/<unit>.bynk`, or `tests/<unit>.unit.bynk`
 *  (then `.unit2`, …) when that file is already there, holding some other suite. */
async function newSuitePath(root: vscode.Uri, unit: string): Promise<vscode.Uri> {
  const exists = async (u: vscode.Uri): Promise<boolean> => {
    try {
      await vscode.workspace.fs.stat(u);
      return true;
    } catch {
      return false;
    }
  };
  const first = vscode.Uri.joinPath(root, "tests", `${unit}.bynk`);
  if (!(await exists(first))) return first;
  for (let n = 1; ; n++) {
    const next = vscode.Uri.joinPath(root, "tests", `${unit}.unit${n === 1 ? "" : n}.bynk`);
    if (!(await exists(next))) return next;
  }
}

/** The cells of the notebook as the core reads them. */
function cellsOf(nb: vscode.NotebookDocument, deps: PromoteDeps): PromoteCell[] {
  const nbUnit = typeof nb.metadata?.unit === "string" && isUnitName(nb.metadata.unit) ? nb.metadata.unit : undefined;
  const raw = nb.getCells().map((c) => ({ kind: c.kind === vscode.NotebookCellKind.Code ? ("code" as const) : ("markdown" as const), source: c.document.getText(), cell: c }));
  return resolveUnits(raw, nbUnit).map((p, i) => ({ ...p, output: p.kind === "code" ? deps.outputOf(raw[i].cell, p.unit) : undefined }));
}

/** Ask which of a cell's offered assertions to write. `undefined` when the user
 *  cancels the whole promotion. Nothing is ticked to begin with. */
async function chooseAssertions(plan: CasePlan, label: string): Promise<Set<string> | undefined> {
  if (plan.offers.length === 0) return new Set();
  const picks = await vscode.window.showQuickPick(
    plan.offers.map((o) => ({ label: o.label, description: o.detail, id: o.id })),
    {
      title: `Promote ${label}: assert what it showed?`,
      placeHolder: "Tick the checks to write into the case. Nothing is asserted unless you tick it.",
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (!picks) return undefined;
  return new Set(picks.map((p) => p.id));
}

export function registerNotebookPromote(context: vscode.ExtensionContext, deps: PromoteDeps): void {
  /** The shared flow: `cellIndex` for one cell, undefined for the whole notebook.
   *  Resolves to where it wrote, or undefined when it wrote nothing. */
  async function promote(nb: vscode.NotebookDocument, cellIndex: number | undefined): Promise<vscode.Uri | undefined> {
    const fail = (m: string): undefined => {
      void vscode.window.showErrorMessage(`Bynk Notebook: ${m}`);
      return undefined;
    };
    if (nb.notebookType !== NOTEBOOK_TYPE) return fail("this is not a Bynk notebook.");
    if (nb.metadata?.invalid) return fail("this file is not a Bynk notebook; there is nothing to promote.");
    const root = await projectRootFor(nb.uri);
    if (!root) return fail("this notebook is not in a Bynk project (no `bynk.toml` above it). Save it inside the project first.");

    // The unit the suite is for.
    let unit: string | undefined;
    if (cellIndex !== undefined) {
      unit = await deps.resolveUnit(nb, nb.cellAt(cellIndex), root);
    } else {
      const units = unitsOf(cellsOf(nb, deps));
      const own = typeof nb.metadata?.unit === "string" ? nb.metadata.unit : undefined;
      if (units.length === 0) unit = await deps.chooseUnit(nb, root);
      else if (units.length === 1) unit = units[0];
      else {
        const pick = await vscode.window.showQuickPick(
          units.map((u) => ({ label: u, description: u === own ? "the notebook's unit" : undefined })),
          { title: "Promote Notebook to Suite: the unit to write the suite for", placeHolder: "Cells of the other units are left out; run this again for each", ignoreFocusOut: true },
        );
        unit = pick?.label;
      }
    }
    if (!unit) return undefined;
    if (!isUnitName(unit)) return fail(`\`${unit}\` is not a unit name.`);

    const cells = cellsOf(nb, deps);
    const label = cellIndex !== undefined ? `cell ${cellIndex + 1}` : "the notebook";
    let plans: CasePlan[];
    const warnings: string[] = [];
    if (cellIndex !== undefined) {
      const planned = planCase(cells, cellIndex, unit);
      if (!planned.ok) return fail(`cell ${cellIndex + 1} can't be a case: ${planned.reason}`);
      plans = [planned.plan];
    } else {
      const suite = planSuite(cells, unit);
      plans = suite.cases;
      if (plans.length === 0) return fail(`no code cell of \`${unit}\` can be a case.${suite.skipped.length > 0 ? ` (cell ${suite.skipped[0].cell + 1}: ${suite.skipped[0].reason})` : ""}`);
      for (const o of suite.otherUnits) warnings.push(`Cell ${o.cell + 1} runs in \`${o.unit}\`, so it is not in this suite: promote the notebook again for that unit.`);
      for (const s of suite.skipped) warnings.push(`Cell ${s.cell + 1} was left out: ${s.reason}`);
      if (suite.neverRan.length > 0) warnings.push(`Cell${suite.neverRan.length === 1 ? "" : "s"} ${suite.neverRan.map((i) => i + 1).join(", ")} ${suite.neverRan.length === 1 ? "has" : "have"} not run since ${suite.neverRan.length === 1 ? "it was" : "they were"} last edited, so no assertion is offered for ${suite.neverRan.length === 1 ? "it" : "them"}. Run ${suite.neverRan.length === 1 ? "it" : "them"} first to be offered some.`);
    }

    // The suite it goes to, for the names already taken.
    const existing = await findUnitSuite(root, unit);
    const taken = new Set(existing ? caseNames(existing.text) : []);

    // Assertions to write, then names to confirm: both are the user's.
    const accepted: Set<string>[] = [];
    const names: string[] = [];
    for (const plan of plans) {
      const cellLabel = `cell ${plan.cell + 1}`;
      const ticked = await chooseAssertions(plan, cellLabel);
      if (!ticked) return undefined;
      accepted.push(ticked);
      const suggested = uniqueName(plan.name, taken);
      const name = await vscode.window.showInputBox({
        title: `Promote ${cellIndex !== undefined ? label : cellLabel}: the case's name`,
        prompt: "A case name, unique within the suite. It is written as the `case` description.",
        value: suggested,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() === "" ? "A case needs a name." : /[\u0000-\u001f]/.test(v) ? "A name can't hold a control character." : taken.has(v) ? "A case of that name is already in the suite." : undefined),
      });
      if (name === undefined) return undefined;
      taken.add(name);
      names.push(name);
    }

    const cases = plans.map((p, i) => renderCase(p, names[i], accepted[i]));
    const consumes: string[] = [];
    const seen = new Set<string>();
    for (const p of plans) {
      for (const c of p.consumes) {
        const k = c.replace(/\s+/g, " ").trim();
        if (!seen.has(k)) {
          seen.add(k);
          consumes.push(c);
        }
      }
    }

    // The new text of the file.
    const notebookName = vscode.workspace.asRelativePath(nb.uri, false);
    let target: vscode.Uri;
    let text: string;
    let edits: { offset: number; text: string }[] | undefined;
    if (existing) {
      const r = insertCases(existing.text, unit, consumes, cases);
      if (!r.ok) return fail(`can't add to ${vscode.workspace.asRelativePath(existing.uri, false)}: ${r.reason}.`);
      target = existing.uri;
      text = r.text;
      edits = r.edits;
    } else {
      target = await newSuitePath(root, unit);
      text = newSuite(unit, suiteHeading(cells), notebookName, consumes, cases);
    }

    // The compiler checks it before anything is written; nothing is written otherwise.
    const relative = path.relative(root.fsPath, target.fsPath);
    const verdict = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Checking the generated suite…", cancellable: true },
      (_p, token) => checkSuiteInCopy(root.fsPath, relative, text, token),
    );
    if (verdict.kind !== "ok") {
      deps.output.appendLine(`── promote ${notebookName} (${label}) ──`);
      deps.output.appendLine(text);
      if (verdict.kind === "errors") for (const d of verdict.errors) deps.output.appendLine(describeDiagnostic(d));
      deps.output.show(true);
      const hint = plans.some((p, i) => accepted[i].size > 0) ? " An assertion on a value the notebook can't type (an opaque type, a Float shown as a whole number) is the usual cause: untick it." : "";
      return fail(
        verdict.kind === "errors"
          ? `the generated case doesn't check, so nothing was written (${verdict.errors[0] ? describeDiagnostic(verdict.errors[0]) : "see the Bynk Notebook output"}).${hint}`
          : `the generated case couldn't be checked (${verdict.reason}), so nothing was written.`,
      );
    }

    const WRITE = "Write";
    const SHOW = "Show";
    const where = vscode.workspace.asRelativePath(target, false);
    const pick = await vscode.window.showInformationMessage(
      `${existing ? "Add to" : "Create"} ${where}?`,
      { modal: true, detail: `${summarise(plans, names, accepted, warnings)}\n\nA one-way copy: the notebook is not kept in sync with it, and \`bynk test\` does not run the notebook.` },
      WRITE,
      SHOW,
    );
    if (pick === SHOW) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "bynk", content: text }));
      return undefined;
    }
    if (pick !== WRITE) return undefined;

    if (existing && edits) {
      const doc = await vscode.workspace.openTextDocument(existing.uri);
      // The text was read from this buffer: if it changed while the user chose, the offsets are stale.
      if (doc.getText() !== existing.text) return fail(`${where} changed while you were choosing; promote again.`);
      const edit = new vscode.WorkspaceEdit();
      for (const e of edits) edit.insert(existing.uri, doc.positionAt(e.offset), e.text);
      if (!(await vscode.workspace.applyEdit(edit))) return fail(`couldn't edit ${where}.`);
      // Save only what this wrote: a file with unsaved edits of the user's own stays unsaved.
      if (!existing.dirty) await doc.save();
      await vscode.window.showTextDocument(doc);
      return existing.uri;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    return target;
  }

  /** The cell a command was invoked on: a cell menu passes it, else the selection. */
  function targetCell(arg: unknown): { nb: vscode.NotebookDocument; index: number } | undefined {
    const given = (arg as { cell?: vscode.NotebookCell } | undefined)?.cell ?? (arg as vscode.NotebookCell | undefined);
    if (given && typeof given === "object" && "notebook" in given && "index" in given) return { nb: given.notebook, index: given.index };
    const editor = vscode.window.activeNotebookEditor;
    const sel = editor?.selections[0];
    return editor && sel ? { nb: editor.notebook, index: sel.start } : undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("bynk.notebook.promoteCell", async (arg?: unknown) => {
      const t = targetCell(arg);
      const cell = t?.nb.cellAt(t.index);
      if (!t || !cell || t.nb.notebookType !== NOTEBOOK_TYPE || cell.kind !== vscode.NotebookCellKind.Code) {
        void vscode.window.showErrorMessage("Bynk Notebook: select a code cell to promote.");
        return undefined;
      }
      return promote(t.nb, t.index);
    }),
    vscode.commands.registerCommand("bynk.notebook.promoteNotebook", async (arg?: unknown) => {
      const nb = (arg as { notebook?: vscode.NotebookDocument } | undefined)?.notebook ?? vscode.window.activeNotebookEditor?.notebook;
      if (!nb || nb.notebookType !== NOTEBOOK_TYPE) {
        void vscode.window.showErrorMessage("Bynk Notebook: open a Bynk notebook to promote.");
        return undefined;
      }
      return promote(nb, undefined);
    }),
  );
}
