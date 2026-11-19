// #210: **Promote Cell to Test Case** and **Promote Notebook to Suite**, the
// editor side. The translation is `notebookPromoteCore.ts`; this asks the user
// what to keep, checks the result with the compiler in a scratch copy (as
// **Promote Scenario to Test Suite** does, #158) and writes it only if it checks.
//
// The suites are the source of truth: what is written is a one-way copy, and the
// notebook is not run by `bynk test`.

import * as path from "node:path";

import * as vscode from "vscode";

import { NOTEBOOK_TYPE, isUnitName } from "./notebookCore";
import {
  caseNames,
  findSuite,
  insertCases,
  mergeConsumes,
  newSuite,
  planCase,
  planSuite,
  renderCase,
  resolveUnits,
  suiteHeading,
  suiteFileName,
  summarise,
  uniqueName,
  unitsOf,
  type CasePlan,
  type CellOutput,
  type PromoteCell,
} from "./notebookPromoteCore";
import { projectRootFor } from "./projectRoots";
import { checkSuitesInCopy } from "./promoteCheck";
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
    // An open buffer is the text to use (it may have unsaved edits); any other file is read, not opened.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    let text: string;
    if (open) text = open.getText();
    else {
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
    }
    if (!/^suite\s/m.test(text)) continue;
    const found = findSuite(text, unit);
    if (found && found.tier === "unit") return { uri, text, dirty: open?.isDirty ?? false };
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
  for (let n = 0; ; n++) {
    const next = vscode.Uri.joinPath(root, "tests", suiteFileName(unit, n));
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
  interface Job {
    unit: string;
    target: vscode.Uri;
    existing?: { uri: vscode.Uri; text: string; dirty: boolean };
    edits?: { offset: number; text: string }[];
    plans: CasePlan[];
    names: string[];
    accepted: Set<string>[];
    text: string;
    warnings: string[];
  }

  /** One unit's suite: what to write, the assertions and names the user chose.
   *  A string is a reason it can't be written; undefined is the user cancelling. */
  async function prepare(cells: PromoteCell[], unit: string, cellIndex: number | undefined, root: vscode.Uri, notebookName: string): Promise<Job | string | undefined> {
    let plans: CasePlan[];
    const warnings: string[] = [];
    if (cellIndex !== undefined) {
      const planned = planCase(cells, cellIndex, unit);
      if (!planned.ok) return `cell ${cellIndex + 1} can't be a case: ${planned.reason}`;
      plans = [planned.plan];
    } else {
      const suite = planSuite(cells, unit);
      plans = suite.cases;
      if (plans.length === 0) return `no code cell of \`${unit}\` can be a case.${suite.skipped.length > 0 ? ` (cell ${suite.skipped[0].cell + 1}: ${suite.skipped[0].reason})` : ""}`;
      for (const x of suite.skipped) warnings.push(`Cell ${x.cell + 1} was left out: ${x.reason}`);
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
      const name = await vscode.window.showInputBox({
        title: `Promote ${cellLabel}: the case's name`,
        prompt: `A case name, unique within the suite for ${unit}. It is written as the \`case\` description.`,
        value: uniqueName(plan.name, taken),
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() === "" ? "A case needs a name." : /[\u0000-\u001f]/.test(v) ? "A name can't hold a control character." : taken.has(v) ? "A case of that name is already in the suite." : undefined),
      });
      if (name === undefined) return undefined;
      taken.add(name);
      names.push(name);
    }

    const cases = plans.map((p, i) => renderCase(p, names[i], accepted[i]));
    const consumes = mergeConsumes(plans);
    if (existing) {
      const r = insertCases(existing.text, unit, consumes, cases);
      if (!r.ok) return `can't add to ${vscode.workspace.asRelativePath(existing.uri, false)}: ${r.reason}.`;
      return { unit, target: existing.uri, existing, edits: r.edits, plans, names, accepted, text: r.text, warnings };
    }
    const target = await newSuitePath(root, unit);
    return { unit, target, plans, names, accepted, text: newSuite(unit, suiteHeading(cells), notebookName, consumes, cases), warnings };
  }

  /** The shared flow: `cellIndex` for one cell, undefined for the whole notebook,
   *  which writes each unit's cells to that unit's own suite in one go. Resolves
   *  to where it wrote (the first suite), or undefined when it wrote nothing. */
  async function promote(nb: vscode.NotebookDocument, cellIndex: number | undefined): Promise<vscode.Uri | undefined> {
    const fail = (m: string): undefined => {
      void vscode.window.showErrorMessage(`Bynk Notebook: ${m}`);
      return undefined;
    };
    if (nb.notebookType !== NOTEBOOK_TYPE) return fail("this is not a Bynk notebook.");
    if (nb.metadata?.invalid) return fail("this file is not a Bynk notebook; there is nothing to promote.");
    const root = await projectRootFor(nb.uri);
    if (!root) return fail("this notebook is not in a Bynk project (no `bynk.toml` above it). Save it inside the project first.");

    // The units to write suites for.
    let units: string[];
    if (cellIndex !== undefined) {
      const u = await deps.resolveUnit(nb, nb.cellAt(cellIndex), root);
      units = u ? [u] : [];
    } else {
      units = unitsOf(cellsOf(nb, deps));
      if (units.length === 0) {
        const u = await deps.chooseUnit(nb, root);
        units = u ? [u] : [];
      }
    }
    if (units.length === 0) return undefined;
    const bad = units.find((u) => !isUnitName(u));
    if (bad) return fail(`\`${bad}\` is not a unit name.`);

    const cells = cellsOf(nb, deps);
    const label = cellIndex !== undefined ? `cell ${cellIndex + 1}` : "the notebook";
    const notebookName = vscode.workspace.asRelativePath(nb.uri, false);
    const jobs: Job[] = [];
    const left: string[] = [];
    for (const unit of units) {
      const job = await prepare(cells, unit, cellIndex, root, notebookName);
      if (job === undefined) return undefined;
      if (typeof job === "string") {
        // One unit with nothing to write doesn't stop the others; it is listed in the summary.
        if (cellIndex === undefined && units.length > 1) {
          left.push(`No suite for \`${unit}\`: ${job}`);
          continue;
        }
        return fail(job);
      }
      jobs.push(job);
    }
    if (jobs.length === 0) return fail(left.join(" "));
    if (new Set(jobs.map((j) => j.target.fsPath)).size < jobs.length) return fail("two of the units' suites are in one file, which can't be edited in one go; promote them one at a time.");

    // The compiler checks every suite, together, before anything is written; nothing is written otherwise.
    const verdict = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Checking the generated suite…", cancellable: true },
      (_p, token) => checkSuitesInCopy(root.fsPath, jobs.map((j) => ({ relative: path.relative(root.fsPath, j.target.fsPath), text: j.text })), token),
    );
    if (verdict.kind !== "ok") {
      deps.output.appendLine(`── promote ${notebookName} (${label}) ──`);
      for (const j of jobs) deps.output.appendLine(`// ${vscode.workspace.asRelativePath(j.target, false)}\n${j.text}`);
      if (verdict.kind === "errors") for (const d of verdict.errors) deps.output.appendLine(describeDiagnostic(d));
      deps.output.show(true);
      const hint = jobs.some((j) => j.accepted.some((a) => a.size > 0)) ? " An assertion on a value the notebook can't type (an opaque type, a Float shown as a whole number) is the usual cause: untick it." : "";
      return fail(
        verdict.kind === "errors"
          ? `the generated case doesn't check, so nothing was written (${verdict.errors[0] ? describeDiagnostic(verdict.errors[0]) : "see the Bynk Notebook output"}).${hint}`
          : `the generated case couldn't be checked (${verdict.reason}), so nothing was written.`,
      );
    }

    const WRITE = "Write";
    const SHOW = "Show";
    const where = (j: Job): string => vscode.workspace.asRelativePath(j.target, false);
    const detail = jobs
      .map((j) => `${j.existing ? "Extends" : "Creates"} ${where(j)}:\n${summarise(j.plans, j.names, j.accepted, j.warnings)}`)
      .join("\n\n")
      .concat(left.length > 0 ? `\n\n${left.join("\n")}` : "");
    const pick = await vscode.window.showInformationMessage(
      jobs.length === 1 ? `${jobs[0].existing ? "Add to" : "Create"} ${where(jobs[0])}?` : `Write ${jobs.length} suites?`,
      { modal: true, detail: `${detail}\n\nA one-way copy: the notebook is not kept in sync with it, and \`bynk test\` does not run the notebook.` },
      WRITE,
      SHOW,
    );
    if (pick === SHOW) {
      for (const j of jobs) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "bynk", content: j.text }), { preview: false });
      return undefined;
    }
    if (pick !== WRITE) return undefined;

    // Every buffer is checked as it was read before the first write.
    for (const j of jobs) {
      if (!j.existing) continue;
      const doc = await vscode.workspace.openTextDocument(j.existing.uri);
      if (doc.getText() !== j.existing.text) return fail(`${where(j)} changed while you were choosing; promote again.`);
    }
    const written: vscode.Uri[] = [];
    for (const j of jobs) {
      if (j.existing && j.edits) {
        const doc = await vscode.workspace.openTextDocument(j.existing.uri);
        const edit = new vscode.WorkspaceEdit();
        for (const e of j.edits) edit.insert(j.existing.uri, doc.positionAt(e.offset), e.text);
        if (!(await vscode.workspace.applyEdit(edit))) return fail(`couldn't edit ${where(j)}${written.length > 0 ? ` (${written.length} suite${written.length === 1 ? "" : "s"} already written)` : ""}.`);
        // Save only what this wrote: a file with unsaved edits of the user's own stays unsaved.
        if (!j.existing.dirty) await doc.save();
      } else {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(j.target, ".."));
        await vscode.workspace.fs.writeFile(j.target, new TextEncoder().encode(j.text));
      }
      written.push(j.target);
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(written[0]));
    return written[0];
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
