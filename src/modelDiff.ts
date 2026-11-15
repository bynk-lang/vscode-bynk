// #147: "Bynk: Compare Model with…" — the architecture, contract, agent-state
// and capability differences between a git revision and the working tree.
//
// How the other revision's model is obtained: the revision is checked out into
// a temporary `git worktree`, one of its `.bynk` files is opened in the
// language server with a raw `textDocument/didOpen` (the server resolves the
// project from the file's nearest `bynk.toml`, and reads the rest of the tree
// from disk; the tree need not be a workspace folder), and the same custom
// requests the live views use (`bynk/architectureModel`, `bynk/contractDiff`,
// `bynk/agentStateModel`) are sent for it. The working-tree side goes through
// the live views' own requests. The two models are diffed client-side
// (`modelDiffCore.ts`). The worktree is removed afterwards.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { requestArchitectureModel } from "./architectureMap";
import { requestContractDiff } from "./contractDiff";
import {
  diffSnapshots,
  mergeBaseChoice,
  parseRefs,
  projectSubpath,
  repoRoot,
  resolveRev,
  sharedAgents,
  untilAnswered,
  withRevisionTree,
  LIST_REFS_ARGS,
  type Git,
  type ModelSnapshot,
  type RefChoice,
} from "./modelDiffCore";
import { renderModelDiffHtml } from "./modelDiffHtml";
import { activeProjectRoot } from "./projectRoots";
import type { ViewRefresh } from "./viewRefresh";
import { getNonce, isRevealMessage, revealLocation } from "./webviewHost";
import type { ArchModel } from "./webview/architectureTypes";
import type { CdModel } from "./webview/contractDiffTypes";
import type { AgentStateModel } from "./webview/stateTypes";

const execGit: Git = {
  run: (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && (error as { code?: unknown }).code === "ENOENT") return reject(error);
        const code = error ? ((error as { code?: unknown }).code as number | undefined) ?? 1 : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
      });
    }),
};

/** The first `.bynk` file under `dir` (shallowest directory first), skipping
 *  hidden and dependency directories. */
function firstBynkFile(dir: string): string | undefined {
  const queue = [dir];
  while (queue.length > 0) {
    const d = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".bynk")) return path.join(d, e.name);
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") queue.push(path.join(d, e.name));
    }
  }
  return undefined;
}

/** Read the model of the project at `projectDir`, which is not a workspace
 *  folder, by opening one of its files in the language server. */
async function snapshotOfTree(
  client: LanguageClient,
  projectDir: string,
  live: ArchModel | null,
): Promise<ModelSnapshot> {
  const file = firstBynkFile(projectDir);
  if (!file) return { architecture: null, contracts: null, agents: {} };
  const uri = vscode.Uri.file(file).toString();
  await client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "bynk", version: 1, text: fs.readFileSync(file, "utf8") },
  });
  try {
    const wait = () => new Promise<void>((r) => setTimeout(r, 400));
    const ask = <T,>(method: string) =>
      untilAnswered(() => client.sendRequest<T | null>(method, { textDocument: { uri } }), 15, wait);
    const architecture = await ask<ArchModel>("bynk/architectureModel");
    const contracts = await ask<CdModel>("bynk/contractDiff");
    // Agent state is per agent: the ones both revisions have, asked while the
    // revision's file is still open in the server.
    const agents =
      architecture && live ? await agentModels(client, sharedAgents(architecture, live), "before") : {};
    return { architecture, contracts, agents };
  } finally {
    await client.sendNotification("textDocument/didClose", { textDocument: { uri } });
  }
}

async function agentModels(
  client: LanguageClient,
  pairs: ReturnType<typeof sharedAgents>,
  side: "before" | "after",
): Promise<Record<string, AgentStateModel>> {
  const out: Record<string, AgentStateModel> = {};
  for (const p of pairs) {
    const loc = p[side];
    const model = await client.sendRequest<AgentStateModel | null>("bynk/agentStateModel", {
      textDocument: { uri: loc.uri },
      position: loc.range.start,
    });
    if (model) out[p.key] = model;
  }
  return out;
}

async function pickRef(git: Git, repo: string): Promise<RefChoice | undefined> {
  const [base, listed] = await Promise.all([mergeBaseChoice(git, repo), git.run(LIST_REFS_ARGS, repo)]);
  const items: Array<vscode.QuickPickItem & { choice?: RefChoice }> = [];
  if (base) items.push({ ...base, choice: base });
  const refs = parseRefs(listed.stdout);
  if (refs.length > 0) items.push({ label: "Branches and tags", kind: vscode.QuickPickItemKind.Separator });
  for (const r of refs) items.push({ ...r, choice: r });
  const picked = await vscode.window.showQuickPick(items, {
    title: "Compare the model of the working tree with…",
    placeHolder: base ? `Default: the merge base with ${base.label.replace("Merge base with ", "")}` : "Pick a branch, tag or commit",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.choice;
}

export function registerModelDiff(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
  getClient: () => LanguageClient | undefined,
): void {
  let panel: vscode.WebviewPanel | undefined;
  const show = (html: (nonce: string, cspSource: string) => string): void => {
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "bynkModelDiff",
        "Bynk Model Diff",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true },
      );
      panel.onDidDispose(() => (panel = undefined));
      panel.webview.onDidReceiveMessage((m: unknown) => {
        if (isRevealMessage(m)) void revealLocation(m.uri, m.range);
      });
    }
    panel.webview.html = html(getNonce(), panel.webview.cspSource);
    panel.reveal(undefined, false);
  };

  context.subscriptions.push(
    { dispose: () => panel?.dispose() },
    vscode.commands.registerCommand("bynk.compareModel", async (refArg?: unknown) => {
      const client = getClient();
      if (!client) {
        void vscode.window.showErrorMessage("Bynk: Compare Model needs the language server running.");
        return;
      }
      const root = await activeProjectRoot();
      if (!root || root.scheme !== "file") {
        void vscode.window.showInformationMessage("Open a Bynk project (a folder with a bynk.toml) to compare its model.");
        return;
      }
      try {
        const repo = await repoRoot(execGit, root.fsPath);
        const sub = repo ? projectSubpath(repo, root.fsPath) : undefined;
        if (!repo || sub === undefined) {
          void vscode.window.showInformationMessage("Bynk: Compare Model needs the project to be in a git repository.");
          return;
        }
        let rev: string | undefined;
        let label: string;
        if (typeof refArg === "string" && refArg !== "") {
          label = refArg;
          rev = await resolveRev(execGit, repo, refArg);
        } else {
          const choice = await pickRef(execGit, repo);
          if (!choice) return;
          label = choice.label.startsWith("Merge base") ? `${choice.label} (${choice.description})` : choice.label;
          rev = await resolveRev(execGit, repo, choice.rev);
        }
        if (!rev) {
          void vscode.window.showErrorMessage(`Bynk: git does not know the revision ${label}.`);
          return;
        }
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-model-diff-"));
        const dir = path.join(scratch, "tree");
        const diff = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Comparing the model with ${label}…` },
          async () => {
            // The working-tree side: any `.bynk` file in the project resolves it.
            const active = vscode.window.activeTextEditor?.document;
            const afterFile =
              active?.languageId === "bynk" && active.uri.fsPath.startsWith(root.fsPath)
                ? active.uri.toString()
                : vscode.Uri.file(firstBynkFile(root.fsPath) ?? "").toString();
            const [architecture, contracts] = await Promise.all([
              requestArchitectureModel(client, hub, afterFile, true),
              requestContractDiff(client, hub, afterFile, true),
            ]);
            const after: ModelSnapshot = { architecture, contracts, agents: {} };
            try {
              const before = await withRevisionTree(
                execGit,
                repo,
                sub,
                rev!,
                dir,
                async (p) => fs.existsSync(p),
                async ({ projectDir }) => {
                  const snap = await snapshotOfTree(client, projectDir, architecture);
                  if (snap.architecture && architecture) {
                    after.agents = await agentModels(client, sharedAgents(snap.architecture, architecture), "after");
                  }
                  return snap;
                },
              );
              return { before, after };
            } finally {
              fs.rmSync(scratch, { recursive: true, force: true });
            }
          },
        );
        const result = diffSnapshots(diff.before, diff.after);
        show((nonce, cspSource) => renderModelDiffHtml(result, { against: label, nonce, cspSource }));
      } catch (error) {
        void vscode.window.showErrorMessage(`Bynk: could not compare the model: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
}
