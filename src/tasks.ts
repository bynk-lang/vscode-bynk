// A build task that type-checks the whole project through `bynk check . --format
// short`, wired to the `$bynkc` problem-matcher so errors land in the Problems
// panel. The LSP already reports diagnostics for *open* files; this catches the
// rest (unopened files, project-level errors) on demand.
//
// Goes through the `bynk` driver rather than shelling `bynkc` directly (#486):
// the driver resolves its compiler as `$BYNK_BYNKC` → PATH → sibling-of-`bynk`,
// richer than a bare PATH lookup — a driver-first install (`bynkc` reachable
// only via `BYNK_BYNKC`, or sitting next to `bynk` off PATH) now works here too.

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { reportBynkNotFound } from "./doctor";
import { findExecutable } from "./procCore";
import { managedBynkPath } from "./toolchain";

const TASK_TYPE = "bynkc";

/** Task runs already reported as "bynk not found" by the start-time check. */
const reported = new WeakSet<vscode.TaskExecution>();

/** The `bynk` driver command: the `bynk.bynkPath` setting, else `bynk` on PATH,
 *  else the copy the extension downloaded (see `toolchain.ts`). */
export function bynkPath(): string {
  return (
    vscode.workspace.getConfiguration("bynk").get<string>("bynkPath", "").trim() ||
    managedBynkPath() ||
    "bynk"
  );
}

/** The `bynk.compilerPath` setting, or `undefined` when unset. Passed through as
 *  `BYNK_BYNKC` when shelling `bynk`, so the setting keeps pinning an exact
 *  `bynkc` now that `check`/`test` run through the driver instead of calling
 *  `bynkc` directly — `bynk` honours the same override. */
export function compilerOverride(): string | undefined {
  const p = vscode.workspace
    .getConfiguration("bynk")
    .get<string>("compilerPath", "")
    .trim();
  return p || undefined;
}

/** The `bynkc: check` build task for one project: `bynk check . --format short`,
 *  run in the project's own directory (`folder`, or `folder/project` for a
 *  nested one), errors routed through `$bynkc`. */
function checkTask(folder?: vscode.WorkspaceFolder, project?: string): vscode.Task {
  const override = compilerOverride();
  const base = folder ?? vscode.workspace.workspaceFolders?.[0];
  const cwd = base && (project ? vscode.Uri.joinPath(base.uri, project) : base.uri).fsPath;
  const exec = new vscode.ShellExecution(bynkPath(), ["check", ".", "--format", "short"], {
    ...(cwd ? { cwd } : {}),
    ...(override ? { env: { BYNK_BYNKC: override } } : {}),
  });
  const definition: vscode.TaskDefinition = project ? { type: TASK_TYPE, project } : { type: TASK_TYPE };
  const task = new vscode.Task(
    definition,
    folder ?? vscode.TaskScope.Workspace,
    project ? `check (${project})` : "check",
    "bynkc",
    exec,
    ["$bynkc"],
  );
  task.group = vscode.TaskGroup.Build;
  return task;
}

/** The workspace folder `project` is under, for a task not scoped to one: the
 *  first folder holding `project/bynk.toml`, else the first folder. */
async function folderHolding(project: string | undefined): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!project) return folders[0];
  for (const folder of folders) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, project, "bynk.toml"));
      return folder;
    } catch {
      /* not under this one */
    }
  }
  return folders[0];
}

/** One check task per project in the workspace, each in its own directory so
 *  a nested project is checked where its `bynk.toml` is. A workspace with no
 *  manifest still gets the plain task. */
async function checkTasks(): Promise<vscode.Task[]> {
  const manifests = await vscode.workspace.findFiles("**/bynk.toml", "**/node_modules/**");
  const tasks: vscode.Task[] = [];
  for (const manifest of manifests) {
    const folder = vscode.workspace.getWorkspaceFolder(manifest);
    if (!folder) continue;
    const project = path.posix.relative(folder.uri.path, path.posix.dirname(manifest.path));
    tasks.push(checkTask(folder, project || undefined));
  }
  tasks.sort((a, b) => a.name.localeCompare(b.name));
  return tasks.length > 0 ? tasks : [checkTask()];
}

export function registerTasks(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(TASK_TYPE, {
      provideTasks: checkTasks,
      resolveTask: async (task) => {
        if (task.definition.type !== TASK_TYPE) return undefined;
        const project = typeof task.definition.project === "string" ? task.definition.project : undefined;
        const folder = typeof task.scope === "object" ? task.scope : await folderHolding(project);
        const resolved = checkTask(folder, project);
        // Keep the user's definition (their tasks.json entry) as written.
        const out = new vscode.Task(task.definition, task.scope ?? vscode.TaskScope.Workspace, resolved.name, "bynkc", resolved.execution, ["$bynkc"]);
        out.group = vscode.TaskGroup.Build;
        return out;
      },
    }),
    // #2095: `bynk` itself missing is the one gap the Doctor can't diagnose, so
    // say how to fix it. Found by resolving the executable as the task starts
    // (conservatively: only a command that resolves nowhere), with the POSIX
    // shell's exit 127 as the fallback. Windows shells never produce 127.
    vscode.tasks.onDidStartTask((e) => {
      if (e.execution.task.definition.type !== TASK_TYPE) return;
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!findExecutable(bynkPath(), { platform: process.platform, env: process.env, cwd, home: os.homedir() })) {
        reported.add(e.execution);
        void reportBynkNotFound("not found");
      }
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      if (
        e.execution.task.definition.type === TASK_TYPE &&
        e.exitCode === 127 &&
        process.platform !== "win32" &&
        !reported.delete(e.execution)
      ) {
        void reportBynkNotFound("command not found");
      }
    }),
  );
}
