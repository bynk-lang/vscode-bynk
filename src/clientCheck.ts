// #132: warn when the generated TypeScript client is stale.
//
// For a project whose `bynk.toml` has `[build.client]`, run `bynk client --check`
// (which writes nothing) after a change that could alter the client, and show a
// status-bar warning when the client on disk is stale or missing. Its action menu
// offers Regenerate (only when `bynk.generateClient` is registered) and Show
// difference (the CLI's first differing line). A passing check clears the warning.
//
// The runs ride the shared refresh hub (`viewRefresh.ts`), so they follow
// `bynk.views.refresh`, are scoped to the projects whose files changed
// (`refreshScope.ts`), and wait for the language server's round like the views
// do. The CLI needs a clean project: a project with errors is skipped, and what
// was last known stays on show. `bynk.client.check` turns the whole thing off.

import * as vscode from "vscode";

import { BynkNotFoundError, runBynk } from "./cli";
import { clientOutput } from "./client";
import {
  CHECK_ARGS,
  classifyCheck,
  isDrifted,
  nextState,
  statusFor,
  type ClientOutcome,
  type ClientState,
} from "./clientCheckCore";
import { GENERATE_CLIENT_COMMAND, parseClientConfig } from "./fileDecorationsCore";
import { projectRootFor } from "./projectRoots";
import { mapLimit } from "./refreshScope";
import type { ViewRefresh } from "./viewRefresh";

const ACTIONS_COMMAND = "bynk.checkClient";

/** At most this many projects are checked at once. */
const CONCURRENCY = 2;

interface Project {
  root: vscode.Uri;
  state: ClientState;
  /** A check is running, and another was asked for meanwhile. */
  running: boolean;
  again: boolean;
  /** What the latest check made of it (also what the command reports back). */
  last?: ClientOutcome;
}

/** What `bynk.checkClient` returns, once it has checked: for tests and scripts. */
export interface CheckSummary {
  projects: { root: string; state: string; last?: string }[];
}

export function registerClientCheck(context: vscode.ExtensionContext, viewRefresh: ViewRefresh): void {
  const check = new ClientCheck();
  context.subscriptions.push(
    check,
    vscode.commands.registerCommand(ACTIONS_COMMAND, () => check.showActions()),
    viewRefresh.onDidRefresh((keys) => void check.refresh(keys)),
    viewRefresh.onDidStartClient(() => void check.checkActive()),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e?.document.languageId === "bynk") void check.checkActive();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bynk.client.check")) void check.configChanged();
    }),
  );
  void check.checkActive();
}

class ClientCheck implements vscode.Disposable {
  private readonly projects = new Map<string, Project>();
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
  /** Roots the active editor has already led to a check. */
  private readonly seen = new Set<string>();

  constructor() {
    this.item.command = ACTIONS_COMMAND;
    this.item.name = "Bynk generated client";
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration("bynk").get<boolean>("client.check", true);
  }

  /** The projects the changed documents (URI strings) belong to. */
  async refresh(keys: ReadonlySet<string>): Promise<void> {
    if (!this.enabled()) return;
    const roots = new Map<string, vscode.Uri>();
    for (const key of keys) {
      const root = await projectRootFor(vscode.Uri.parse(key)).catch(() => undefined);
      if (root?.scheme === "file") roots.set(root.toString(), root);
    }
    await mapLimit([...roots.values()], CONCURRENCY, (root) => this.check(root));
  }

  async checkActive(): Promise<void> {
    if (!this.enabled()) return;
    const doc = vscode.window.activeTextEditor?.document;
    const root = doc?.languageId === "bynk" && doc.uri.scheme === "file" ? await projectRootFor(doc.uri) : undefined;
    if (!root || this.seen.has(root.toString())) return;
    this.seen.add(root.toString());
    await this.check(root);
  }

  async configChanged(): Promise<void> {
    if (this.enabled()) {
      await this.checkActive();
    } else {
      this.projects.clear();
      this.seen.clear();
      this.render();
    }
  }

  /** Check one project, never two at once for the same root: a request made
   *  while a check runs is answered by one more run after it. */
  private async check(root: vscode.Uri): Promise<void> {
    const key = root.toString();
    const project = this.projects.get(key) ?? { root, state: { kind: "none" } as ClientState, running: false, again: false };
    this.projects.set(key, project);
    if (project.running) {
      project.again = true;
      return;
    }
    project.running = true;
    try {
      do {
        project.again = false;
        const outcome = await this.run(root);
        project.last = outcome;
        project.state = nextState(project.state, outcome);
        this.render();
      } while (project.again && this.enabled());
    } finally {
      project.running = false;
    }
  }

  private async run(root: vscode.Uri): Promise<ClientOutcome> {
    try {
      const manifest = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "bynk.toml")));
      // No `[build.client]`: no client to be stale (and no warning left over
      // from a table that has since been removed).
      if (!parseClientConfig(manifest)) return { kind: "fresh" };
      if (hasErrors(root)) return { kind: "unknown", reason: "the project has errors" };
      return classifyCheck(await runBynk([...CHECK_ARGS], root.fsPath));
    } catch (e) {
      return { kind: "unknown", reason: e instanceof BynkNotFoundError ? e.message : String(e) };
    }
  }

  private drifted(): { name: string; state: ClientOutcome; root: vscode.Uri }[] {
    const out: { name: string; state: ClientOutcome; root: vscode.Uri }[] = [];
    for (const p of this.projects.values()) {
      if (isDrifted(p.state)) out.push({ name: p.root.path.split("/").filter(Boolean).pop() ?? p.root.path, state: p.state, root: p.root });
    }
    return out;
  }

  private render(): void {
    const status = statusFor(this.drifted());
    if (!status) {
      this.item.hide();
      return;
    }
    this.item.text = status.text;
    this.item.tooltip = status.tooltip;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.show();
  }

  /** The status item's action menu: Regenerate and Show difference. Also
   *  `Bynk: Check Generated Client`, which checks first. */
  async showActions(): Promise<CheckSummary> {
    if (this.drifted().length === 0) {
      await this.checkActive();
      const root = vscode.window.activeTextEditor ? await projectRootFor(vscode.window.activeTextEditor.document.uri) : undefined;
      if (root) {
        this.seen.add(root.toString());
        await this.check(root);
      }
    }
    const drifted = this.drifted();
    const summary: CheckSummary = {
      projects: [...this.projects.values()].map((p) => ({
        root: p.root.toString(),
        state: p.state.kind,
        last: p.last && (p.last.kind === "unknown" ? `unknown: ${p.last.reason}` : p.last.kind),
      })),
    };
    // The message waits for a choice, so the command does not wait for it.
    if (drifted.length === 0) {
      void vscode.window.showInformationMessage("Bynk: the generated client is up to date (or the project has no `[build.client]`).");
    } else {
      void this.offer(drifted);
    }
    return summary;
  }

  private async offer(drifted: { name: string; state: ClientOutcome; root: vscode.Uri }[]): Promise<void> {
    const regenerate = (await vscode.commands.getCommands(true)).includes(GENERATE_CLIENT_COMMAND);
    const buttons = regenerate ? ["Regenerate", "Show difference"] : ["Show difference"];
    const first = drifted[0];
    const message =
      drifted.length === 1
        ? `Bynk: the generated TypeScript client is ${first.state.kind === "missing" ? "missing" : "stale"} (${(first.state as { summary: string }).summary}).`
        : `Bynk: the generated TypeScript client is out of date in ${drifted.length} projects.`;
    const choice = await vscode.window.showWarningMessage(message, ...buttons);
    if (choice === "Show difference") {
      this.showDifference(drifted);
    } else if (choice === "Regenerate") {
      for (const d of drifted) {
        await vscode.commands.executeCommand(GENERATE_CLIENT_COMMAND, d.root);
        await this.check(d.root);
      }
    }
  }

  private showDifference(drifted: { name: string; state: ClientOutcome }[]): void {
    const output = clientOutput();
    output.clear();
    for (const d of drifted) {
      const state = d.state as { detail: string };
      output.appendLine(`${d.name}: the generated client is ${d.state.kind}`);
      output.appendLine(state.detail || "(`bynk client --check` gave no detail)");
      output.appendLine("");
    }
    output.show(true);
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** Whether the language server reports an error in a `.bynk` source of the
 *  project (a complaint about `bynk.toml` itself is the CLI's to make). */
function hasErrors(root: vscode.Uri): boolean {
  const prefix = root.toString().replace(/\/?$/, "/");
  return vscode.languages
    .getDiagnostics()
    .some(([uri, diagnostics]) => uri.path.endsWith(".bynk") && uri.toString().startsWith(prefix) && diagnostics.some((d) => d.severity === vscode.DiagnosticSeverity.Error));
}
