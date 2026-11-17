// The VS Code side of the Worker groups reader (`workerGroups.ts`): a project's
// `bynk.toml`, read through the editor so an unsaved edit counts, as the driver
// reads it with the open buffer as an overlay.

import * as vscode from "vscode";

import { projectRootFor } from "./projectRoots";
import { parseWorkerGroups, type WorkerGroup } from "./workerGroups";

/** The `[deploy.workers.<key>]` groups of the project at `root`; none when
 *  there is no manifest or no groups, so an ungrouped project is unchanged. */
export async function readWorkerGroups(root: vscode.Uri): Promise<WorkerGroup[]> {
  const manifest = vscode.Uri.joinPath(root, "bynk.toml");
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === manifest.toString());
  try {
    const text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(manifest));
    return parseWorkerGroups(text);
  } catch {
    return [];
  }
}

/** The groups of the project `file` belongs to. */
export async function workerGroupsFor(file: vscode.Uri): Promise<WorkerGroup[]> {
  const root = await projectRootFor(file);
  return root ? readWorkerGroups(root) : [];
}
