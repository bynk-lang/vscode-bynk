// #16: "Bynk: Export OpenAPI", a thin wrapper over `bynk openapi` (the spec is
// the deliverable; there is no editor view of it). It asks where to save,
// runs the CLI through the shared runner so `bynk.bynkPath` and
// `bynk.compilerPath` apply, then offers to open the file.

import * as vscode from "vscode";

import { findProjectRoot, runBynk } from "./cli";
import { openapiArgs, openapiOutcome } from "./openapiCore";

export function registerOpenapi(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("bynk.exportOpenapi", exportOpenapi));
}

async function exportOpenapi(): Promise<void> {
  const root = await findProjectRoot();
  if (!root) {
    void vscode.window.showInformationMessage("Open a Bynk project (a folder with a bynk.toml) to export its OpenAPI document.");
    return;
  }
  // The CLI reads the project from disk: unsaved edits would be left out of a
  // spec that then reads as current.
  const dirty = vscode.workspace.textDocuments.filter((d) => d.languageId === "bynk" && d.isDirty);
  if (dirty.length > 0) {
    const save = await vscode.window.showWarningMessage(
      "Some Bynk files have unsaved changes, which the export would leave out.",
      "Save and Export",
    );
    if (!save) return;
    // Only the Bynk files the prompt named, not every dirty document.
    for (const d of dirty) await d.save();
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(root, "openapi.json"),
    filters: { OpenAPI: ["json", "yaml", "yml"] },
    saveLabel: "Export OpenAPI",
  });
  if (!target) return;
  if (target.scheme !== "file") {
    void vscode.window.showErrorMessage("Choose a location on the local file system: `bynk openapi` writes the file itself.");
    return;
  }
  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Exporting OpenAPI…", cancellable: true },
    async (_progress, token) => {
      try {
        const run = await runBynk(openapiArgs(root.fsPath, target.fsPath), root.fsPath, token);
        return openapiOutcome(run, token.isCancellationRequested);
      } catch (error) {
        return openapiOutcome({ error }, token.isCancellationRequested);
      }
    },
  );
  if (outcome.kind === "cancelled") return;
  if (outcome.kind === "failed") {
    void vscode.window.showErrorMessage(outcome.message);
    return;
  }
  const open = await vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(target)}.`, "Open");
  if (open) await vscode.window.showTextDocument(target);
}
