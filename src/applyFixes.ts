// #130: "Bynk: Apply Fixes Across Project…", a thin wrapper over
// `bynk check --fix=<codes>`: the project-wide version of the language
// server's per-file `source.fixAll.bynk`. It asks which codes, saves dirty
// buffers (the CLI reads from disk), runs the CLI through the shared runner
// so `bynk.bynkPath` applies, and reports the files it changed.

import * as path from "node:path";

import * as vscode from "vscode";

import { applyFixesArgs, applyFixesOutcome, describeOutcome, parseCodes } from "./applyFixesCore";
import { findProjectRoot, runBynk } from "./cli";
import { reportedCodes } from "./explainView";

export const APPLY_FIXES_COMMAND = "bynk.applyFixesAcrossProject";

export function registerApplyFixes(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(APPLY_FIXES_COMMAND, (codes?: unknown) =>
      applyFixes(Array.isArray(codes) ? codes.filter((c): c is string => typeof c === "string") : undefined),
    ),
  );
}

const TYPE_ONE = "Type a code…";

async function askForCodes(): Promise<string[] | undefined> {
  const reported = reportedCodes(vscode.languages.getDiagnostics());
  const picks = await vscode.window.showQuickPick(
    [...reported.map((label) => ({ label })), { label: TYPE_ONE, description: "a code from CI output or an upgrade note" }],
    {
      title: "Bynk: Apply Fixes Across Project",
      placeHolder: "Codes whose fixes to apply in every file (reported in this workspace)",
      canPickMany: true,
    },
  );
  if (!picks) return undefined;
  const codes = picks.filter((p) => p.label !== TYPE_ONE).map((p) => p.label);
  if (picks.some((p) => p.label === TYPE_ONE) || (reported.length === 0 && codes.length === 0)) {
    const typed = await vscode.window.showInputBox({
      title: "Bynk: Apply Fixes Across Project",
      prompt: "Diagnostic codes, comma-separated",
      placeHolder: "bynk.consumes.type_not_selected, bynk.consumes.unit_not_consumed",
    });
    if (typed === undefined) return undefined;
    codes.push(...parseCodes(typed));
  }
  return [...new Set(codes)];
}

async function applyFixes(given?: string[]): Promise<void> {
  const root = await findProjectRoot();
  if (!root) {
    void vscode.window.showInformationMessage("Open a Bynk project (a folder with a bynk.toml) to apply fixes across it.");
    return;
  }
  const codes = given && given.length > 0 ? given : await askForCodes();
  if (!codes || codes.length === 0) return;

  const dirty = vscode.workspace.textDocuments.filter((d) => d.languageId === "bynk" && d.isDirty);
  if (dirty.length > 0) {
    const save = await vscode.window.showWarningMessage(
      "Some Bynk files have unsaved changes. The fixes read files from disk, so they must be saved first.",
      "Save and Apply",
    );
    if (!save) return;
    for (const d of dirty) {
      if (!(await d.save())) {
        void vscode.window.showErrorMessage(`Could not save ${vscode.workspace.asRelativePath(d.uri)}; no fixes were applied.`);
        return;
      }
    }
  }

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Applying fixes across the project…", cancellable: true },
    async (_progress, token) => {
      try {
        const run = await runBynk(applyFixesArgs(root.fsPath, codes), root.fsPath, token);
        return applyFixesOutcome(run, token.isCancellationRequested);
      } catch (error) {
        return applyFixesOutcome({ error }, token.isCancellationRequested);
      }
    },
  );
  if (outcome.kind === "cancelled") return;
  if (outcome.kind === "failed") {
    void vscode.window.showErrorMessage(outcome.message);
    return;
  }
  const message = describeOutcome(outcome);
  if (outcome.kind === "nothing") {
    void vscode.window.showInformationMessage(message);
    return;
  }
  const show = await vscode.window.showInformationMessage(message, "Show Changed Files");
  if (show) {
    const items = outcome.files.map((f) => ({
      label: f.path,
      description: f.codes.map((c) => `${c.code} ×${c.count}`).join(", "),
    }));
    const pick = await vscode.window.showQuickPick(items, { title: "Files changed", placeHolder: "Open a file" });
    if (pick) {
      // The CLI names files as typed from the project root.
      const uri = vscode.Uri.file(path.resolve(root.fsPath, pick.label));
      await vscode.window.showTextDocument(uri);
    }
  }
}
