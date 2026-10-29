// #16: "Bynk: Export OpenAPI", a thin wrapper over `bynk openapi` (the spec is
// the deliverable; there is no editor view of it). It asks where to save,
// runs the CLI through the shared runner so `bynk.bynkPath` and
// `bynk.compilerPath` apply, then offers to open the file.

import * as vscode from "vscode";

import { BynkNotFoundError, findProjectRoot, runBynk } from "./cli";
import { openapiArgs, openapiFailure } from "./openapiCore";

export function registerOpenapi(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("bynk.exportOpenapi", exportOpenapi));
}

async function exportOpenapi(): Promise<void> {
  const root = await findProjectRoot();
  if (!root) {
    void vscode.window.showInformationMessage("Open a Bynk project (a folder with a bynk.toml) to export its OpenAPI document.");
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(root, "openapi.json"),
    filters: { OpenAPI: ["json", "yaml", "yml"] },
    saveLabel: "Export OpenAPI",
  });
  if (!target) return;
  const run = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Exporting OpenAPI…", cancellable: true },
    (_progress, token) => runBynk(openapiArgs(root.fsPath, target.fsPath), root.fsPath, token).catch((e) => e),
  );
  if (run instanceof BynkNotFoundError) {
    void vscode.window.showErrorMessage(run.message);
    return;
  }
  if (run instanceof Error) {
    void vscode.window.showErrorMessage(`Could not run bynk openapi: ${run.message}`);
    return;
  }
  if (run.code !== 0) {
    void vscode.window.showErrorMessage(openapiFailure(run.stderr));
    return;
  }
  const open = await vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(target)}.`, "Open");
  if (open) await vscode.window.showTextDocument(target);
}
