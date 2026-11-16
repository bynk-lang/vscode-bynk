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
// (`modelDiffCore.ts`). The worktree is removed afterwards. The page lists the
// differences and, through `modelDiffGraphCore.ts` and `webview/model-diff.ts`,
// draws them on the architecture map and the agent state diagrams (#153).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { requestArchitectureModel } from "./architectureMap";
import { requestContractDiff } from "./contractDiff";
import {
  dependencyWarning,
  diffSnapshots,
  firstResolvable,
  headRev,
  mergeBase,
  mergeBaseChoice,
  pullRequestRefs,
  scratchProblems,
  withoutLocations,
  parseRefs,
  projectSubpath,
  SCRATCH_PREFIX,
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
import { buildGraphs } from "./modelDiffGraphCore";
import { renderModelDiffHtml } from "./modelDiffHtml";
import { handlerSymbols, type SymbolLike } from "./refreshScheduler";
import { wireHandlerKey, type WireHandler } from "./wireDiffCore";
import { activeProjectRoot } from "./projectRoots";
import type { ViewRefresh } from "./viewRefresh";
import { getNonce, isRevealMessage, revealLocation } from "./webviewHost";
import type { ArchModel } from "./webview/architectureTypes";
import type { CdModel } from "./webview/contractDiffTypes";
import type { AgentStateModel } from "./webview/stateTypes";
import type { WcModel } from "./webview/wireContractTypes";

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

/** Every `.bynk` file under `dir`, skipping hidden and dependency directories. */
function allBynkFiles(dir: string): string[] {
  const out: string[] = [];
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
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.endsWith(".bynk")) out.push(p);
      else if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") queue.push(p);
    }
  }
  return out;
}

/** Read each handler's wire contract (#154), given a way to list a file's
 *  handlers. A handler the server has no wire contract for (an agent's, say)
 *  is left out. */
async function wireContracts(
  client: LanguageClient,
  files: string[],
  symbolsOf: (file: string) => Promise<SymbolLike[]>,
): Promise<Record<string, WireHandler>> {
  const out: Record<string, WireHandler> = {};
  for (const file of files) {
    const uri = vscode.Uri.file(file).toString();
    const handlers = handlerSymbols(await symbolsOf(file));
    for (const h of handlers) {
      const params = { textDocument: { uri }, position: h.symbol.selectionRange.start };
      // The revision's first round is committed by now (its architecture model
      // was answered), so a null is a handler with no wire contract.
      const model = await client.sendRequest<WcModel | null>("bynk/wireContract", params);
      if (model) out[wireHandlerKey(model, h.symbol.name)] = { model, uri };
    }
  }
  return out;
}

/** A project of a scratch checkout, open in the language server: one of its
 *  files is open, which is what resolves the project. */
interface OpenTree {
  uri: string;
  files: string[];
}

async function openTree(client: LanguageClient, projectDir: string): Promise<OpenTree | undefined> {
  const file = firstBynkFile(projectDir);
  if (!file) return undefined;
  const uri = vscode.Uri.file(file).toString();
  await client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "bynk", version: 1, text: fs.readFileSync(file, "utf8") },
  });
  return { uri, files: allBynkFiles(projectDir) };
}

const closeTree = (client: LanguageClient, tree: OpenTree): Promise<void> =>
  client.sendNotification("textDocument/didClose", { textDocument: { uri: tree.uri } });

/** The architecture model and contract diff of an open tree. */
async function treeBasics(client: LanguageClient, tree: OpenTree): Promise<Pick<ModelSnapshot, "architecture" | "contracts">> {
  const wait = () => new Promise<void>((r) => setTimeout(r, 400));
  const ask = <T,>(method: string) =>
    untilAnswered(() => client.sendRequest<T | null>(method, { textDocument: { uri: tree.uri } }), 15, wait);
  const architecture = await ask<ArchModel>("bynk/architectureModel");
  const contracts = await ask<CdModel>("bynk/contractDiff");
  return { architecture, contracts };
}

/** Each handler's wire contract in an open tree: its other files are opened in
 *  the server for the length of the read. */
async function treeWire(client: LanguageClient, tree: OpenTree): Promise<Record<string, WireHandler>> {
  const opened: string[] = [];
  try {
    return await wireContracts(client, tree.files, async (f) => {
      const fileUri = vscode.Uri.file(f).toString();
      if (fileUri !== tree.uri) {
        await client.sendNotification("textDocument/didOpen", {
          textDocument: { uri: fileUri, languageId: "bynk", version: 1, text: fs.readFileSync(f, "utf8") },
        });
        opened.push(fileUri);
      }
      return (await client.sendRequest<SymbolLike[] | null>("textDocument/documentSymbol", { textDocument: { uri: fileUri } })) ?? [];
    });
  } finally {
    for (const u of opened) await client.sendNotification("textDocument/didClose", { textDocument: { uri: u } });
  }
}

const EMPTY: ModelSnapshot = { architecture: null, contracts: null, agents: {} };

/** Read the model of the project at `projectDir`, which is not a workspace
 *  folder, by opening one of its files in the language server. `live` is the
 *  other side's architecture, for the agents both have. */
async function snapshotOfTree(
  client: LanguageClient,
  projectDir: string,
  live: ArchModel | null,
): Promise<ModelSnapshot> {
  const tree = await openTree(client, projectDir);
  if (!tree) return EMPTY;
  try {
    const { architecture, contracts } = await treeBasics(client, tree);
    // Agent state is per agent: the ones both revisions have, asked while the
    // revision's file is still open in the server.
    const agents =
      architecture && live ? await agentModels(client, sharedAgents(architecture, live), "before") : {};
    return { architecture, contracts, agents, wire: architecture ? await treeWire(client, tree) : undefined };
  } finally {
    await closeTree(client, tree);
  }
}

/** Read two revisions' projects, both open in the server at once (the agents
 *  both have are asked on each side). */
async function snapshotsOfTwoTrees(
  client: LanguageClient,
  beforeDir: string,
  afterDir: string,
): Promise<{ before: ModelSnapshot; after: ModelSnapshot }> {
  const [bt, at] = [await openTree(client, beforeDir), await openTree(client, afterDir)];
  try {
    if (!bt || !at) return { before: EMPTY, after: EMPTY };
    const [bb, ab] = [await treeBasics(client, bt), await treeBasics(client, at)];
    const pairs = bb.architecture && ab.architecture ? sharedAgents(bb.architecture, ab.architecture) : [];
    const before: ModelSnapshot = { ...bb, agents: await agentModels(client, pairs, "before") };
    const after: ModelSnapshot = { ...ab, agents: await agentModels(client, pairs, "after") };
    if (bb.architecture) before.wire = await treeWire(client, bt);
    if (ab.architecture) after.wire = await treeWire(client, at);
    return { before, after };
  } finally {
    if (bt) await closeTree(client, bt);
    if (at) await closeTree(client, at);
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

/** One side of a comparison: a revision git resolves to a commit, with how to
 *  name it. */
interface Side {
  rev: string;
  label: string;
}

const describeChoice = (c: RefChoice): string =>
  c.label.startsWith("Merge base") ? `${c.label} (${c.description})` : c.label;

/** Pick a ref. `first` adds the merge base with the default branch (what a pull
 *  request changes) at the top, `workingTree` an entry for the working tree
 *  (answered as `null`, cancel being `undefined`). */
async function pickRef(
  git: Git,
  repo: string,
  opts: { title: string; first?: boolean; workingTree?: boolean },
): Promise<RefChoice | null | undefined> {
  const [base, listed] = await Promise.all([
    opts.first ? mergeBaseChoice(git, repo) : Promise.resolve(undefined),
    git.run(LIST_REFS_ARGS, repo),
  ]);
  const items: Array<vscode.QuickPickItem & { choice?: RefChoice; tree?: boolean }> = [];
  if (opts.workingTree) items.push({ label: "Working tree", description: "what is on disk now", tree: true });
  if (base) items.push({ ...base, choice: base });
  const refs = parseRefs(listed.stdout);
  if (refs.length > 0) items.push({ label: "Branches and tags", kind: vscode.QuickPickItemKind.Separator });
  for (const r of refs) items.push({ ...r, choice: r });
  const picked = await vscode.window.showQuickPick(items, {
    title: opts.title,
    placeHolder: base ? `Default: the merge base with ${base.label.replace("Merge base with ", "")}` : "Pick a branch, tag or commit",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  return picked.tree ? null : picked.choice;
}

/** `ref` as a side, or `undefined` (after saying so) when git does not know it. */
async function sideOf(git: Git, repo: string, ref: string, label = ref): Promise<Side | undefined> {
  const rev = await resolveRev(git, repo, ref);
  if (!rev) {
    void vscode.window.showErrorMessage(`Bynk: git does not know the revision ${label}.`);
    return undefined;
  }
  return { rev, label };
}

export function registerModelDiff(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
  getClient: () => LanguageClient | undefined,
): void {
  let panel: vscode.WebviewPanel | undefined;
  const show = (html: (nonce: string, cspSource: string, scriptUri: string, elkUri: string) => string): void => {
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "bynkModelDiff",
        "Bynk Model Diff",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out")] },
      );
      panel.onDidDispose(() => (panel = undefined));
      panel.webview.onDidReceiveMessage((m: unknown) => {
        if (isRevealMessage(m)) void revealLocation(m.uri, m.range);
      });
    }
    const scriptUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "out", "model-diff.js"))
      .toString();
    const elkUri = panel.webview
      .asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "out", "elk.js"))
      .toString();
    panel.webview.html = html(getNonce(), panel.webview.cspSource, scriptUri, elkUri);
    panel.reveal(undefined, false);
  };

  /** The project the comparison is about, and the repository it is in. */
  const target = async (): Promise<{ client: LanguageClient; root: vscode.Uri; repo: string; sub: string } | undefined> => {
    const client = getClient();
    if (!client) {
      void vscode.window.showErrorMessage("Bynk: Compare Model needs the language server running.");
      return undefined;
    }
    const root = await activeProjectRoot();
    if (!root || root.scheme !== "file") {
      void vscode.window.showInformationMessage("Open a Bynk project (a folder with a bynk.toml) to compare its model.");
      return undefined;
    }
    const repo = await repoRoot(execGit, root.fsPath);
    const sub = repo ? projectSubpath(repo, root.fsPath) : undefined;
    if (!repo || sub === undefined) {
      void vscode.window.showInformationMessage("Bynk: Compare Model needs the project to be in a git repository.");
      return undefined;
    }
    return { client, root, repo, sub };
  };

  /** Compare `from` with `to`, or with the working tree when `to` is absent, and
   *  show the page. Resolves to the diff, for tests. */
  const compare = async (
    t: NonNullable<Awaited<ReturnType<typeof target>>>,
    from: Side,
    to: Side | undefined,
  ) => {
    const { client, root, repo, sub } = t;
    const scratches: string[] = [];
    const scratch = (): string => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
      scratches.push(d);
      return d;
    };
    const exists = async (p: string) => fs.existsSync(p);
    const title = to ? `Comparing the model of ${from.label} with ${to.label}…` : `Comparing the model with ${from.label}…`;
    const warnings: string[] = [];
    const read = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      async () => {
        try {
          if (to) {
            // Both sides are revisions: two checkouts, both open in the server.
            const beforeDir = path.join(scratch(), "tree");
            const afterDir = path.join(scratch(), "tree");
            return await withRevisionTree(execGit, repo, sub, from.rev, beforeDir, exists, (b) =>
              withRevisionTree(execGit, repo, sub, to.rev, afterDir, exists, async (a) => {
                const snaps = await snapshotsOfTwoTrees(client, b.projectDir, a.projectDir);
                for (const [side, dir] of [[from, b.projectDir], [to, a.projectDir]] as const) {
                  const found = scratchProblems.take(dir);
                  if (found.length > 0) warnings.push(dependencyWarning(side.label, found));
                }
                return snaps;
              }),
            );
          }
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
          if (architecture) {
            after.wire = await wireContracts(client, allBynkFiles(root.fsPath), async (f) => {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
              const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
                "vscode.executeDocumentSymbolProvider",
                doc.uri,
              );
              return (syms ?? []).filter((x) => "selectionRange" in x) as SymbolLike[];
            });
          }
          const before = await withRevisionTree(
            execGit,
            repo,
            sub,
            from.rev,
            path.join(scratch(), "tree"),
            exists,
            async ({ projectDir }) => {
              const snap = await snapshotOfTree(client, projectDir, architecture);
              if (snap.architecture && architecture) {
                after.agents = await agentModels(client, sharedAgents(snap.architecture, architecture), "after");
              }
              const found = scratchProblems.take(projectDir);
              if (found.length > 0) warnings.push(dependencyWarning(from.label, found));
              return snap;
            },
          );
          return { before, after };
        } finally {
          for (const d of scratches) fs.rmSync(d, { recursive: true, force: true });
        }
      },
    );
    let result = diffSnapshots(read.before, read.after);
    const graphs = buildGraphs(read.before, read.after);
    // Between two revisions there is no working tree to open.
    if (to) {
      result = withoutLocations(result);
      graphs.linked = false;
    }
    if (warnings.length > 0) result = { ...result, warnings };
    show((nonce, cspSource, scriptUri, elkUri) =>
      renderModelDiffHtml(result, { against: from.label, to: to?.label, nonce, cspSource, scriptUri, elkUri, graphs }),
    );
    // For tests; the palette ignores it.
    return { ...result, graphs };
  };

  const failed = (error: unknown): void => {
    void vscode.window.showErrorMessage(`Bynk: could not compare the model: ${error instanceof Error ? error.message : String(error)}`);
  };

  context.subscriptions.push(
    { dispose: () => panel?.dispose() },
    // `(ref?, to?)`: with a ref, that revision against the working tree (or
    // against `to`, a second revision); else pick one.
    vscode.commands.registerCommand("bynk.compareModel", async (refArg?: unknown, toArg?: unknown) => {
      try {
        const t = await target();
        if (!t) return;
        let from: Side | undefined;
        if (typeof refArg === "string" && refArg !== "") {
          from = await sideOf(execGit, t.repo, refArg);
        } else {
          const choice = await pickRef(execGit, t.repo, { title: "Compare the model of the working tree with…", first: true });
          if (!choice) return;
          from = await sideOf(execGit, t.repo, choice.rev, describeChoice(choice));
        }
        if (!from) return;
        let to: Side | undefined;
        if (typeof toArg === "string" && toArg !== "") {
          to = await sideOf(execGit, t.repo, toArg);
          if (!to) return;
        }
        return await compare(t, from, to);
      } catch (error) {
        failed(error);
      }
    }),
    // Two revisions, or a revision and the working tree, both picked.
    vscode.commands.registerCommand("bynk.compareModelBetween", async () => {
      try {
        const t = await target();
        if (!t) return;
        const first = await pickRef(execGit, t.repo, { title: "Compare the model of… (the earlier revision)", first: true });
        if (!first) return;
        const second = await pickRef(execGit, t.repo, { title: `…with (the later one; ${first.label} is the earlier)`, workingTree: true });
        if (second === undefined) return;
        const from = await sideOf(execGit, t.repo, first.rev, describeChoice(first));
        if (!from) return;
        const to = second ? await sideOf(execGit, t.repo, second.rev, describeChoice(second)) : undefined;
        if (second && !to) return;
        return await compare(t, from, to);
      } catch (error) {
        failed(error);
      }
    }),
    // On a pull request in the GitHub Pull Requests extension's view: what the
    // pull request changes (the merge base with its base branch) against its
    // head, or against the working tree when the pull request is checked out.
    vscode.commands.registerCommand("bynk.compareModelPullRequest", async (arg?: unknown) => {
      try {
        const t = await target();
        if (!t) return;
        const pr = pullRequestRefs(arg);
        if (!pr) {
          void vscode.window.showInformationMessage(
            "Bynk: could not read this pull request's branches from the GitHub Pull Requests extension; pick the revisions instead.",
          );
          return await vscode.commands.executeCommand("bynk.compareModelBetween");
        }
        const base = await firstResolvable(execGit, t.repo, pr.base);
        if (!base) {
          void vscode.window.showErrorMessage(
            `Bynk: the pull request's base (${pr.base[pr.base.length - 1]}) is not in this clone; fetch it and try again.`,
          );
          return;
        }
        const head = pr.head ? await resolveRev(execGit, t.repo, pr.head) : undefined;
        if (pr.head && !head) {
          void vscode.window.showErrorMessage("Bynk: the pull request's head is not in this clone; check the pull request out or fetch it, then try again.");
          return;
        }
        const current = await headRev(execGit, t.repo);
        // A pull request that is checked out is compared with the working tree.
        const toTree = head !== undefined && head !== current ? head : undefined;
        const mb = (await mergeBase(execGit, t.repo, base, head ?? current ?? "")) ?? base;
        const what = pr.label ? `pull request ${pr.label}` : "the pull request";
        const from: Side = { rev: mb, label: `the merge base of ${what}` };
        const to: Side | undefined = toTree ? { rev: toTree, label: `the head of ${what}` } : undefined;
        return await compare(t, from, to);
      } catch (error) {
        failed(error);
      }
    }),
  );
}
