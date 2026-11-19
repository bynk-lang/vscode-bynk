// #222 (Part 1): **Bynk: Revert…**, a wrapper over `bynk revert`.
//
// Read-only until the confirmed step: `bynk revert --dry-run --format json`
// first (it reads Cloudflare, so it needs the CLI's credentials; the extension
// never touches them), shown verbatim in the "Bynk Revert" output channel. A
// refusal ends the flow there. Otherwise a modal names the environment and the
// Worker(s) (and a production-like environment asks for its name to be typed),
// and only then does `bynk revert --yes` run, its output streamed to the same
// channel. The Environments view refreshes afterwards. The arguments, the
// result parsing and the confirmation text are in revertCore.ts.

import * as vscode from "vscode";

import { BynkNotFoundError, findProjectRoot, projectContexts, spawnBynk } from "./cli";
import { lockEnvironments, validContextName, validEnvironmentName } from "./deployPlan";
import { runPlanReadOnly } from "./deployReadiness";
import { reportBynkNotFound } from "./doctor";
import { type RevertTarget, confirmation, credentialsMessage, formatRevertPlan, mentionsMissingCredentials, refusalSummary, revertArgs, revertOutcome, revertScopeFor } from "./revertCore";
import { bynkPath } from "./tasks";
import { readWorkerGroups } from "./workerGroupsStore";
import { workerScopes } from "./workerGroups";

/** Command arguments that skip a picker: `{ environment, context?, worker? }`
 *  (`context: ""` is every Worker the ledger records for the environment). */
interface Preset {
  environment?: string;
  context?: string;
  worker?: string;
}

let channel: vscode.OutputChannel | undefined;
let running = false;

export function registerRevert(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("bynk.revert", (preset?: Preset) => revert(preset)),
    { dispose: () => channel?.dispose() },
  );
}

async function revert(preset?: Preset): Promise<void> {
  // One revert at a time: a second dry run must not race the real one's lock writes.
  if (running) {
    void vscode.window.showInformationMessage("Bynk: a revert is already in progress.");
    return;
  }
  running = true;
  try {
    await revertFlow(preset);
  } finally {
    running = false;
  }
}

async function pickEnvironment(root: vscode.Uri): Promise<string | undefined> {
  let recorded: string[] = [];
  try {
    recorded = lockEnvironments(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "bynk.deploy.lock"))));
  } catch {
    /* no lock */
  }
  if (recorded.length === 0) {
    void vscode.window.showInformationMessage("Bynk: bynk.deploy.lock records no deployed environment, so there is nothing to revert.");
    return undefined;
  }
  return (
    await vscode.window.showQuickPick(
      recorded.map((n) => ({ label: n, description: "recorded in bynk.deploy.lock" })),
      { placeHolder: "Which environment should be reverted?" },
    )
  )?.label;
}

async function revertFlow(preset?: Preset): Promise<void> {
  const root = await findProjectRoot();
  if (!root) {
    void vscode.window.showErrorMessage("Bynk: no bynk.toml found in the workspace.");
    return;
  }
  for (const [what, v, ok] of [
    ["an environment name", preset?.environment, preset?.environment === undefined || validEnvironmentName(preset.environment)],
    ["a context name", preset?.context, !preset?.context || validContextName(preset.context)],
    ["a Worker name", preset?.worker, !preset?.worker || validContextName(preset.worker)],
  ] as const) {
    if (!ok) {
      void vscode.window.showErrorMessage(`Bynk: ${JSON.stringify(v)} is not ${what}.`);
      return;
    }
  }
  const environment = preset?.environment ?? (await pickEnvironment(root));
  if (!environment) return;
  const groups = await readWorkerGroups(root);

  // The scope: the preset's, else a pick. A member of a group is its group's Worker.
  let scope: { context?: string; worker?: string } = {};
  const named = preset?.worker || preset?.context;
  if (named) {
    const s = revertScopeFor(named, groups);
    scope = s.target;
    if (s.member && s.group) {
      void vscode.window.showInformationMessage(
        `Bynk: ${named} is in the Worker group \`${s.group.key}\`, which runs as one Worker, so the whole group (${s.group.contexts.join(", ")}) goes back together.`,
      );
    }
  } else if (preset?.context === undefined && preset?.worker === undefined) {
    const choices = workerScopes(await projectContexts(root), groups);
    if (choices.length > 1) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: "Every recorded Worker", description: "each goes back to its own previous deployment", scope: {} as { context?: string; worker?: string } },
          ...choices.map((c) => ({
            label: c.label,
            description: c.kind === "worker" ? `${c.description}; every member goes back together` : "this context alone",
            scope: (c.kind === "worker" ? { worker: c.value } : { context: c.value }) as { context?: string; worker?: string },
          })),
        ],
        { placeHolder: "What should be reverted?" },
      );
      if (!picked) return;
      scope = picked.scope;
    }
  }
  const target: RevertTarget = { environment, ...scope };

  const out = (channel ??= vscode.window.createOutputChannel("Bynk Revert"));
  const dryArgs = revertArgs(target, "dryRun");

  // 1. The dry run: read-only for the working tree (runPlanReadOnly puts back a
  //    bynk.schema.lock the CLI rewrote, as for the deploy plan).
  let cancelled = false;
  let result;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Bynk: checking whether ${environment} can be reverted…`, cancellable: true },
      (_p, token) => {
        token.onCancellationRequested(() => (cancelled = true));
        return runPlanReadOnly(root, dryArgs, token);
      },
    );
  } catch (e) {
    if (e instanceof BynkNotFoundError) await reportBynkNotFound();
    else void vscode.window.showErrorMessage(`Bynk: the revert check failed: ${String(e)}`);
    return;
  }
  const outcome = revertOutcome(result, cancelled);
  if (outcome.kind === "cancelled") return;
  out.clear();
  out.appendLine(`$ bynk ${dryArgs.join(" ")}`);
  if (outcome.kind === "credentials" || outcome.kind === "failed") {
    out.appendLine(outcome.detail);
    out.show(true);
    const msg =
      outcome.kind === "credentials"
        ? credentialsMessage()
        : `Bynk: \`bynk revert --dry-run\` could not check ${environment}. Nothing was changed.`;
    void vscode.window.showErrorMessage(msg, "Show Output");
    return;
  }
  for (const line of formatRevertPlan(outcome.plan)) out.appendLine(line);
  out.show(true);
  if (outcome.kind === "refused") {
    void vscode.window.showErrorMessage(`Bynk: ${refusalSummary(outcome.plan)}`, "Show Output");
    return;
  }

  // 2. Confirmation, naming the environment and Worker(s).
  const c = confirmation(target, outcome.plan, groups);
  const choice = await vscode.window.showWarningMessage(c.title, { modal: true, detail: c.detail }, c.button);
  if (choice !== c.button) return;
  if (c.typed) {
    const typed = await vscode.window.showInputBox({
      title: `Revert ${environment}?`,
      prompt: `${environment} reads as production. Type "${c.typed}" to revert it.`,
      validateInput: (v) => (v === c.typed ? undefined : `Type ${c.typed} exactly.`),
    });
    if (typed !== c.typed) return;
  }

  // 3. The real revert, streamed. Not cancellable once started.
  const runArgs = revertArgs(target, "run");
  out.appendLine("");
  out.appendLine(`$ bynk ${runArgs.join(" ")}`);
  let code: number | null;
  let text = "";
  try {
    code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Bynk: reverting ${environment}…` },
      () =>
        new Promise<number | null>((resolve, reject) => {
          const child = spawnBynk(runArgs, root.fsPath, {
            output: {
              append: (t) => {
                text += t;
                out.append(t);
              },
            },
          });
          child.once("error", (e) => reject((e as { code?: unknown }).code === "ENOENT" ? new BynkNotFoundError(bynkPath(), e) : e));
          child.once("close", resolve);
        }),
    );
  } catch (e) {
    if (e instanceof BynkNotFoundError) await reportBynkNotFound();
    else void vscode.window.showErrorMessage(`Bynk: the revert could not run: ${String(e)}`);
    return;
  } finally {
    // Whatever happened, the ledger may have moved.
    void vscode.commands.executeCommand("bynk.environments.refresh");
  }
  if (code === 0) {
    void vscode.window.showInformationMessage(`Bynk: reverted ${environment}. The Environments view is refreshed.`);
  } else {
    out.show(true);
    void vscode.window.showErrorMessage(
      mentionsMissingCredentials(text) ? credentialsMessage() : `Bynk: \`bynk revert\` failed (exit ${code ?? "signal"}). See the output for what it changed, if anything.`,
      "Show Output",
    );
  }
}
