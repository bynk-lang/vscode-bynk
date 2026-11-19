// #150: the Environments view — what `bynk.deploy.lock` records as deployed in
// each environment, how the working tree's service contracts differ from it,
// and which agent classes lag their current state version there.
//
// Local only: the lock file, `bynk migrate status` (through the store the
// Project tree shares) and the language server's `bynk/contractDiff`. The
// actions reuse the existing commands, which keep their own confirmation flows
// (ADR 0510; `migrationsCore.ts` DECISION C), and the view never passes `--yes`.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { requestContractDiff } from "./contractDiff";
import { buildEnvironmentsTree, type EnvTreeNode } from "./environmentsCore";
import { readWorkerGroups } from "./workerGroupsStore";
import { findProjectRoot } from "./cli";
import { sharedMigrationsStore } from "./migrationsView";
import type { ViewRefresh } from "./viewRefresh";
import type { CdService } from "./webview/contractDiffTypes";

interface Loaded {
  root: vscode.Uri;
  tree: EnvTreeNode[];
}

class EnvironmentsProvider implements vscode.TreeDataProvider<EnvTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<EnvTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private loaded: Promise<Loaded | undefined> | undefined;
  private dirty = false;
  private visible = () => true;
  /** The nodes by id, for `getParent`-free lookups of a node's root. */
  root: vscode.Uri | undefined;

  constructor(
    private readonly hub: ViewRefresh,
    private readonly client: () => LanguageClient | undefined,
  ) {}

  attach(view: vscode.TreeView<EnvTreeNode>): vscode.Disposable {
    this.visible = () => view.visible;
    return view.onDidChangeVisibility((e) => {
      if (e.visible && this.dirty) this.refresh();
    });
  }

  /** Reload when visible, else when next shown. */
  invalidate(): void {
    if (!this.visible()) {
      this.dirty = true;
      return;
    }
    this.refresh();
  }

  refresh(fresh = false): void {
    this.dirty = false;
    this.loaded = this.load(fresh);
    this.emitter.fire(undefined);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  getTreeItem(node: EnvTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(node.icon);
    item.contextValue = node.contextValue;
    // An environment opens expanded: its contexts are the point.
    if (node.data.kind === "environment") item.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    return item;
  }

  async getChildren(node?: EnvTreeNode): Promise<EnvTreeNode[]> {
    if (node) return node.children;
    this.loaded ??= this.load(false);
    return (await this.loaded)?.tree ?? [];
  }

  private async load(fresh: boolean): Promise<Loaded | undefined> {
    const root = await findProjectRoot();
    this.root = root;
    if (!root) return undefined;
    const store = sharedMigrationsStore();
    if (fresh) store.clear(root);
    const [lock, drift, migrations, groups] = await Promise.all([
      readLock(root),
      this.drift(root, fresh),
      store.get(root),
      readWorkerGroups(root),
    ]);
    return {
      root,
      tree: buildEnvironmentsTree({
        lock,
        drift,
        groups,
        migrations:
          migrations.kind === "status"
            ? migrations
            : { kind: "unavailable", detail: migrations.kind === "failed" ? migrations.detail.split("\n")[0] : "bynk is not installed (see Bynk: Doctor)" },
      }),
    };
  }

  /** The contract diff's service rows, or `null` when it cannot be had. */
  private async drift(root: vscode.Uri, fresh: boolean): Promise<CdService[] | null> {
    const client = this.client();
    if (!client) return null;
    try {
      const [file] = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), "**/node_modules/**", 1);
      if (!file) return null;
      const model = await requestContractDiff(client, this.hub, file.toString(), fresh);
      if (!model || model.ledger !== "read") return null;
      return model.services;
    } catch {
      return null;
    }
  }

  /** A `.bynk` file in the project, for commands that resolve a project from one. */
  async projectFile(): Promise<vscode.Uri | undefined> {
    const root = this.root ?? (await findProjectRoot());
    if (!root) return undefined;
    const [file] = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), "**/node_modules/**", 1);
    return file;
  }
}

async function readLock(root: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "bynk.deploy.lock")));
  } catch {
    return undefined;
  }
}

export function registerEnvironments(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
  client: () => LanguageClient | undefined,
): void {
  const provider = new EnvironmentsProvider(hub, client);
  const view = vscode.window.createTreeView("bynk.environments", { treeDataProvider: provider });
  const env = (node?: EnvTreeNode): string | undefined =>
    node && "environment" in node.data ? node.data.environment : undefined;
  context.subscriptions.push(
    provider,
    view,
    provider.attach(view),
    // The lock and the locks' watchers feed the hub; so do source edits, which move drift.
    hub.onDidRefresh(() => provider.invalidate()),
    hub.onDidStartClient(() => provider.invalidate()),
    sharedMigrationsStore().onDidChange(() => provider.invalidate()),
    vscode.commands.registerCommand("bynk.environments.refresh", () => provider.refresh(true)),
    // Test seam (not contributed): the tree as the view would show it.
    vscode.commands.registerCommand("bynk._environmentsSnapshot", async () => {
      provider.refresh(true);
      const plain = (n: EnvTreeNode): unknown => ({
        id: n.id,
        label: n.label,
        description: n.description,
        contextValue: n.contextValue,
        data: n.data,
        children: n.children.map(plain),
      });
      return (await provider.getChildren()).map(plain);
    }),
    // Each action hands the existing command a preset; their pickers, plans and
    // confirmations are unchanged.
    vscode.commands.registerCommand("bynk.environments.showPlan", (n?: EnvTreeNode) =>
      vscode.commands.executeCommand("bynk.showDeployPlan", { environment: env(n), context: "" }),
    ),
    vscode.commands.registerCommand("bynk.environments.checkReadiness", (n?: EnvTreeNode) =>
      vscode.commands.executeCommand("bynk.checkDeployReadiness", { environment: env(n), context: "" }),
    ),
    vscode.commands.registerCommand("bynk.environments.deploy", (n?: EnvTreeNode) =>
      vscode.commands.executeCommand("bynk.deploy", { environment: env(n), context: "" }),
    ),
    vscode.commands.registerCommand("bynk.environments.tail", (n?: EnvTreeNode) =>
      vscode.commands.executeCommand("bynk.tailLogs", { environment: env(n) }),
    ),
    // #222: an environment reverts every recorded Worker, a Worker its group, a context its own Worker.
    vscode.commands.registerCommand("bynk.environments.revert", (n?: EnvTreeNode) =>
      vscode.commands.executeCommand(
        "bynk.revert",
        n?.data.kind === "workerGroup"
          ? { environment: n.data.environment, worker: n.data.worker }
          : n?.data.kind === "context"
            ? { environment: n.data.environment, context: n.data.context }
            : { environment: env(n), context: "" },
      ),
    ),
    vscode.commands.registerCommand("bynk.environments.sweep", async (n?: EnvTreeNode) =>
      vscode.commands.executeCommand("bynk.migrate.sweep", {
        root: provider.root ?? (await findProjectRoot()),
        environment: env(n),
        context: "",
      }),
    ),
    vscode.commands.registerCommand("bynk.environments.showContractDiff", async (n?: EnvTreeNode) =>
      vscode.commands.executeCommand(
        "bynk.showContractDiff",
        (await provider.projectFile())?.toString(),
        // #157: scope the panel to the node it was invoked on.
        n?.data.kind === "context"
          ? { context: n.data.context, environment: n.data.environment }
          : // A Worker group's contracts are read together: every member's rows.
            n?.data.kind === "workerGroup"
            ? { context: n.data.worker, contexts: n.data.contexts, environment: n.data.environment }
            : undefined,
      ),
    ),
  );
}
