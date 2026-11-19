// #221: "Bynk: Check Deploy Readiness" — the vscode side of
// `deployReadinessCore.ts`. It gathers the sources the editor already reads
// (the language server's contract diff, `bynk migrate status`, the deploy plan,
// `bynk.deploy.lock`, the Worker groups, the Test Explorer's last run), has the
// core judge them, caches the answer per environment and source state, and shows
// it as one panel whose rows link to the view that fixes them. Deploy… and Show
// Deploy Plan run it first; Deploy's own button is gated on it (`gateFor`).
//
// Read-only. Nothing is provisioned or deployed, and no secret value is read:
// the plan is `bynk deploy --dry-run`, and a secrets file is only ever passed on
// as a path. One thing `bynk` v0.639.1 does on a dry run is write: it records the
// build's schema in `bynk.schema.lock` (even when it then refuses the deploy),
// and its generated build output under `.bynk/` (disposable, and ignored by the
// `.gitignore` bynk writes there). `runPlanReadOnly` puts a lock that existed back byte for byte,
// so a preview never leaves a committed file changed.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { BynkNotFoundError, runBynk, type BynkResult } from "./cli";
import { isActionMessage, renderActionHtml } from "./cliView";
import { requestContractDiff } from "./contractDiff";
import { deployArgs, type DeployTarget, type PlanOutcome, planOutcome } from "./deployPlan";
import {
  cacheKey,
  evaluateReadiness,
  type FixTarget,
  gateFor,
  type Gate,
  READINESS_CSS,
  ReadinessCache,
  type ReadinessInput,
  type ReadinessReport,
  renderReadinessHtml,
  verdictLine,
} from "./deployReadinessCore";
import { sharedMigrationsStore } from "./migrationsView";
import { lastTestRun } from "./testResults";
import type { ViewRefresh } from "./viewRefresh";
import { readWorkerGroups } from "./workerGroupsStore";

/** One check's answer, with the plan it ran, which the plan view reuses. */
export interface ReadinessEntry {
  report: ReadinessReport;
  /** The dry run's outcome when it ran to the end; absent when it was cancelled. */
  plan?: PlanOutcome;
}

const SCHEMA_LOCK = "bynk.schema.lock";

/** Run the deploy plan (`bynk deploy --dry-run --format json`) and leave
 *  `bynk.schema.lock` as it found it. The driver records the build's schema there
 *  even on a dry run and even when it then refuses (bynk v0.639.1); a preview
 *  must not leave a committed file changed. */
export async function runPlanReadOnly(
  root: vscode.Uri,
  args: string[],
  token?: vscode.CancellationToken,
): Promise<BynkResult> {
  const lock = vscode.Uri.joinPath(root, SCHEMA_LOCK);
  let before: Uint8Array | undefined;
  try {
    before = await vscode.workspace.fs.readFile(lock);
  } catch {
    before = undefined; // none yet: there is nothing to put back
  }
  try {
    return await runBynk(args, root.fsPath, token);
  } finally {
    try {
      const after = await vscode.workspace.fs.readFile(lock).then(
        (b) => b,
        () => undefined,
      );
      // Byte for byte, and only a file that existed before: a lock the run
      // creates is the driver's, and is left alone.
      if (before !== undefined && (after === undefined || !sameBytes(before, after))) {
        await vscode.workspace.fs.writeFile(lock, before);
      }
    } catch {
      /* best effort: the lock is the driver's to rewrite on the next build */
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

interface PanelState {
  root: vscode.Uri;
  target: DeployTarget;
  /** What Continue does: open the plan view (with Deploy, or without). */
  continueTo: (plan: PlanOutcome | undefined) => void | Promise<void>;
  canDeploy: boolean;
}

export class DeployReadiness implements vscode.Disposable {
  private readonly cache = new ReadinessCache<ReadinessEntry>();
  private readonly running = new Map<string, Promise<ReadinessEntry | undefined>>();
  private panel: vscode.WebviewPanel | undefined;
  private state: PanelState | undefined;
  private lastSourceChange = 0;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly hub: ViewRefresh,
    private readonly client: () => LanguageClient | undefined,
  ) {
    const changed = (): void => {
      this.lastSourceChange = Date.now();
      this.cache.invalidate();
      this.scheduleRecheck();
    };
    // A save of a `.bynk` file or the manifest, once per real change.
    this.disposables.push(hub.onDidChangeSource(changed));
    // What is live changes after a deploy. (Not `bynk.schema.lock`: the driver
    // rewrites it itself, and a check must not retrigger on its own run.)
    const watcher = vscode.workspace.createFileSystemWatcher("**/bynk.deploy.lock");
    this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("bynk.bynkPath")) this.cache.invalidate();
      }),
    );
  }

  dispose(): void {
    if (this.recheck) clearTimeout(this.recheck);
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /** The panel refreshes on save while it is open, once the burst of changes settles. */
  private scheduleRecheck(): void {
    if (!this.panel || !this.state) return;
    if (this.recheck) clearTimeout(this.recheck);
    this.recheck = setTimeout(() => {
      this.recheck = undefined;
      if (this.panel && this.state) void this.showFor(this.state, false);
    }, 600);
  }

  /** The readiness of `target`: the cached answer while no source has changed,
   *  else a fresh one. `undefined` when the user cancelled. */
  async check(
    root: vscode.Uri,
    target: DeployTarget,
    opts: { fresh?: boolean; token?: vscode.CancellationToken } = {},
  ): Promise<ReadinessEntry | undefined> {
    const key = `${root.toString()}|${cacheKey(target)}`;
    if (!opts.fresh) {
      const cached = this.cache.get(key);
      if (cached) return cached;
      const running = this.running.get(key);
      if (running) return running;
    }
    const run = this.compute(root, target, opts.token).then((entry) => {
      if (this.running.get(key) === run) this.running.delete(key);
      return entry.entry;
    });
    this.running.set(key, run);
    return run;
  }

  private async compute(
    root: vscode.Uri,
    target: DeployTarget,
    token?: vscode.CancellationToken,
  ): Promise<{ entry: ReadinessEntry | undefined }> {
    const key = `${root.toString()}|${cacheKey(target)}`;
    const generation = this.cache.state;
    // Sequential where it matters: the contract diff reads the locks, so it
    // finishes before the plan run (which touches `bynk.schema.lock`) starts.
    const [contracts, migrations, groups, lock] = await Promise.all([
      this.contracts(root),
      this.migrations(root),
      readWorkerGroups(root),
      readText(vscode.Uri.joinPath(root, "bynk.deploy.lock")),
    ]);
    const plan = await this.plan(root, target, token);
    if (token?.isCancellationRequested || plan.kind === "cancelled") return { entry: undefined };
    const run = lastTestRun(root.toString());
    const input: ReadinessInput = {
      environment: target.environment,
      target,
      contracts,
      plan,
      migrations,
      lock,
      groups,
      tests: run
        ? { kind: "ran", passed: run.passed, failed: run.failed, skipped: run.skipped, stale: run.at < this.lastSourceChange }
        : { kind: "none" },
    };
    const entry: ReadinessEntry = {
      report: evaluateReadiness(input),
      ...(plan.kind === "plan" || plan.kind === "failed" ? { plan } : {}),
    };
    // Kept only if no source changed while it ran: that answer is already stale.
    this.cache.set(key, entry, generation);
    return { entry };
  }

  private async contracts(root: vscode.Uri): Promise<ReadinessInput["contracts"]> {
    const client = this.client();
    if (!client) return { unavailable: "the language server is not running" };
    try {
      const [file] = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), "**/node_modules/**", 1);
      if (!file) return { unavailable: "the project has no .bynk file" };
      const model = await requestContractDiff(client, this.hub, file.toString(), true);
      return model ?? { unavailable: "the language server has no committed analysis yet" };
    } catch (e) {
      return { unavailable: `the contract diff failed: ${String(e)}` };
    }
  }

  private async migrations(root: vscode.Uri): Promise<ReadinessInput["migrations"]> {
    const state = await sharedMigrationsStore().refresh(root);
    if (state.kind === "status") return state;
    return { kind: "unavailable", detail: state.kind === "failed" ? (state.detail.split("\n")[0] ?? "bynk migrate status failed") : "bynk is not installed (see Bynk: Doctor)" };
  }

  private async plan(
    root: vscode.Uri,
    target: DeployTarget,
    token?: vscode.CancellationToken,
  ): Promise<PlanOutcome | { kind: "unavailable"; reason: string }> {
    try {
      const result = await runPlanReadOnly(root, deployArgs(target, "plan"), token);
      return planOutcome(result, token?.isCancellationRequested ?? false);
    } catch (e) {
      if (e instanceof BynkNotFoundError) return { kind: "unavailable", reason: "bynk is not installed (see Bynk: Doctor)" };
      return { kind: "unavailable", reason: String(e) };
    }
  }

  /** Check with a cancellable progress notification. */
  async checkWithProgress(root: vscode.Uri, target: DeployTarget, fresh = false): Promise<ReadinessEntry | undefined> {
    const cached = fresh ? undefined : this.cache.get(`${root.toString()}|${cacheKey(target)}`);
    if (cached) return cached;
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Bynk: checking that ${target.environment} is ready to deploy…`,
        cancellable: true,
      },
      (_progress, token) => this.check(root, target, { fresh, token }),
    );
  }

  /** The gate for the extension's own Deploy. */
  async gate(root: vscode.Uri, target: DeployTarget): Promise<{ gate: Gate; report: ReadinessReport } | undefined> {
    const entry = await this.checkWithProgress(root, target);
    return entry ? { gate: gateFor(entry.report), report: entry.report } : undefined;
  }

  /** Check and show the panel; `continueTo` is the Continue button. */
  async show(state: PanelState, fresh = false): Promise<void> {
    await this.showFor(state, fresh, true);
  }

  private async showFor(state: PanelState, fresh: boolean, withProgress = false): Promise<void> {
    const entry = withProgress
      ? await this.checkWithProgress(state.root, state.target, fresh)
      : await this.check(state.root, state.target, { fresh });
    if (!entry) return; // cancelled
    this.state = state;
    const panel = this.ensurePanel();
    const title = `Bynk Deploy Readiness: ${entry.report.environment}`;
    panel.title = title;
    const canContinue = entry.plan?.kind === "plan";
    panel.webview.html = renderActionHtml(
      panel.webview,
      title,
      renderReadinessHtml(entry.report, {
        ...(canContinue ? { continueLabel: state.canDeploy ? "Continue to the deploy plan" : "Show the deploy plan" } : {}),
      }),
      READINESS_CSS,
    );
    panel.reveal(undefined, true);
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;
    const panel = (this.panel = vscode.window.createWebviewPanel("bynkDeployReadiness", "Bynk Deploy Readiness", vscode.ViewColumn.Active, {
      enableScripts: true,
    }));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.state = undefined;
    });
    panel.webview.onDidReceiveMessage((m: unknown) => {
      if (!isActionMessage(m) || !this.state) return;
      const state = this.state;
      switch (m.action) {
        case "recheck":
          void this.showFor(state, true, true);
          break;
        case "continue":
          void this.check(state.root, state.target).then((entry) => state.continueTo(entry?.plan));
          break;
        case "fix":
          void this.fix(m.args.target, state);
          break;
      }
    });
    return panel;
  }

  /** Open the view that fixes a check. */
  private async fix(target: string | undefined, state: PanelState): Promise<void> {
    const { root } = state;
    const env = state.target.environment;
    const scope = { context: state.target.context ?? "", ...(state.target.worker ? { worker: state.target.worker } : {}) };
    switch (target as FixTarget | undefined) {
      case "contractDiff": {
        const [file] = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), "**/node_modules/**", 1);
        await vscode.commands.executeCommand("bynk.showContractDiff", file?.toString(), { environment: env });
        break;
      }
      case "migrations":
        await vscode.commands.executeCommand("bynk.migrate.sweep", { root, environment: env, context: "" });
        break;
      case "environments":
        await vscode.commands.executeCommand("bynk.environments.focus");
        break;
      case "plan":
        await vscode.commands.executeCommand("bynk.showDeployPlan", { environment: env, ...scope });
        break;
      case "tests":
        await vscode.commands.executeCommand("bynk.runTests");
        break;
      case "manifest":
        await vscode.window.showTextDocument(vscode.Uri.joinPath(root, "bynk.toml"));
        break;
      case "doctor":
        await vscode.commands.executeCommand("bynk.doctor");
        break;
    }
  }

  /** The line a notification says about a report. */
  static line(report: ReadinessReport): string {
    return verdictLine(report);
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}
