// #2097, #40: which Bynk project a file belongs to — the directory of the
// nearest `bynk.toml` at or above it, bounded by the workspace folder that
// holds the file (see projectRootsCore.ts for the rule and for loose files).
// This is the one root resolver: the project sidebar groups files by it, the
// architecture-model cache keys on it, and everything that runs `bynk` roots
// at it, so a stray manifest in a parent directory is never a project.

import * as os from "node:os";
import * as vscode from "vscode";

import { inWorkspace, resolveRoot, type RootOptions } from "./projectRootsCore";

const options = (): RootOptions => ({
  home: vscode.Uri.file(os.homedir()).path,
  caseInsensitive: process.platform === "win32",
});

const cache = new Map<string, Promise<vscode.Uri | undefined>>();

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The project root (the directory holding the nearest `bynk.toml`, no higher
 *  than the file's workspace folder) for a file, or `undefined`. */
export function projectRootFor(file: vscode.Uri): Promise<vscode.Uri | undefined> {
  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === file.scheme && f.uri.authority === file.authority)
    .map((f) => f.uri.path);
  const key = `${file.with({ path: "", query: "", fragment: "" }).toString()}|${folders.join(",")}|${file.path}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = resolveRoot(file.path, folders, (dir) =>
      exists(vscode.Uri.joinPath(file.with({ path: dir }), "bynk.toml")),
    options()).then((dir) => (dir === undefined ? undefined : file.with({ path: dir, query: "", fragment: "" })));
    cache.set(key, hit);
  }
  return hit;
}

/** Whether `file` lies in a workspace folder. */
export function inWorkspaceFolder(file: vscode.Uri): boolean {
  return inWorkspace(
    file.path,
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === file.scheme).map((f) => f.uri.path),
    options(),
  );
}

/** `projectRootFor`, for what an agent steers (LM tools, `/fix`): a file
 *  outside every workspace folder has no project, loose or not. */
export async function workspaceRootFor(file: vscode.Uri): Promise<vscode.Uri | undefined> {
  return inWorkspaceFolder(file) ? projectRootFor(file) : undefined;
}

/** The project the user is working in: the root of the active `.bynk` file,
 *  else the first workspace folder that is itself a project. With
 *  `workspaceOnly`, an active file outside the workspace doesn't count. */
export async function activeProjectRoot(workspaceOnly = false): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active?.languageId === "bynk" && active.uri.scheme === "file" && !(workspaceOnly && !inWorkspaceFolder(active.uri))) {
    const root = await projectRootFor(active.uri);
    if (root) return root;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await exists(vscode.Uri.joinPath(folder.uri, "bynk.toml"))) return folder.uri;
  }
  return undefined;
}

/** Forget cached lookups (a `bynk.toml` was created, deleted or moved). */
export function clearProjectRoots(): void {
  cache.clear();
}

/** Keep the cache honest: a manifest created, deleted or renamed, or a
 *  directory holding one moved, or the workspace folders changing. */
export function watchProjectRoots(context: vscode.ExtensionContext): void {
  const manifests = vscode.workspace.createFileSystemWatcher("**/bynk.toml");
  context.subscriptions.push(
    manifests,
    manifests.onDidCreate(clearProjectRoots),
    manifests.onDidDelete(clearProjectRoots),
    vscode.workspace.onDidCreateFiles(clearProjectRoots),
    vscode.workspace.onDidDeleteFiles(clearProjectRoots),
    vscode.workspace.onDidRenameFiles(clearProjectRoots),
    vscode.workspace.onDidChangeWorkspaceFolders(clearProjectRoots),
  );
}
