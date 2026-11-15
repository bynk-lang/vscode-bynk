// #131: "Bynk: Generate TypeScript Client (experimental)", a thin wrapper over
// `bynk client`. With `[build.client]` in bynk.toml it runs with no flags and
// the CLI writes where the table says; otherwise it asks where to save. The
// id `bynk.generateClient` takes no arguments, so other features can offer it
// as a "Regenerate" action.

import * as vscode from "vscode";

import { findProjectRoot, runBynk } from "./cli";
import { clientArgs, clientOutcome, httpServiceChoices, type ClientLayout } from "./clientCore";
import { GENERATE_CLIENT_COMMAND, parseClientConfig } from "./fileDecorationsCore";

let output: vscode.OutputChannel | undefined;

export function registerClient(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand(GENERATE_CLIENT_COMMAND, generateClient));
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** The `from http` services the project's sources declare, sorted. */
async function httpServices(root: vscode.Uri): Promise<string[]> {
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), "**/{node_modules,.bynk}/**");
  const sources: string[] = [];
  for (const f of files) {
    const text = await readText(f);
    if (text) sources.push(text);
  }
  return httpServiceChoices(sources);
}

/** `root` is the project to generate for, when another feature (a "Regenerate"
 *  action) already knows it; anything that is not a Uri (a menu or palette
 *  invocation passes none, or its own context) falls back to the active project. */
async function generateClient(root?: unknown): Promise<void> {
  const project = root instanceof vscode.Uri ? root : await findProjectRoot();
  await generate(project);
}

async function generate(root: vscode.Uri | undefined): Promise<void> {
  if (!root) {
    void vscode.window.showInformationMessage("Open a Bynk project (a folder with a bynk.toml) to generate its TypeScript client.");
    return;
  }
  const dirty = vscode.workspace.textDocuments.filter((d) => d.languageId === "bynk" && d.isDirty);
  if (dirty.length > 0) {
    const save = await vscode.window.showWarningMessage(
      "Some Bynk files have unsaved changes, which the client would leave out.",
      "Save and Generate",
    );
    if (!save) return;
    for (const d of dirty) {
      if (!(await d.save())) {
        void vscode.window.showErrorMessage(`Could not save ${vscode.workspace.asRelativePath(d.uri)}; generation was cancelled.`);
        return;
      }
    }
  }

  const toml = await readText(vscode.Uri.joinPath(root, "bynk.toml"));
  let opts: { out?: string; layout?: ClientLayout; services?: string[] } = {};
  let written: vscode.Uri | undefined;
  if (toml === undefined || parseClientConfig(toml) === undefined) {
    const picked = await askTarget(root);
    if (!picked) return;
    opts = picked.opts;
    written = picked.uri;
  }

  const outcome = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating TypeScript client…", cancellable: true },
    async (_progress, token) => {
      try {
        const run = await runBynk(clientArgs({ root: root.fsPath, ...opts }), root.fsPath, token);
        return clientOutcome(run, token.isCancellationRequested);
      } catch (error) {
        return clientOutcome({ error }, token.isCancellationRequested);
      }
    },
  );
  if (outcome.kind === "cancelled") return;
  const channel = (output ??= vscode.window.createOutputChannel("Bynk Client"));
  if (outcome.kind === "failed") {
    channel.appendLine(outcome.message);
    const show = await vscode.window.showErrorMessage(outcome.message, "Show Output");
    if (show) channel.show(true);
    return;
  }
  let message = written ? `Wrote ${vscode.workspace.asRelativePath(written)}.` : "Generated the client named by [build.client].";
  if (outcome.skipped.length > 0) {
    channel.appendLine(`Routes the client cannot represent yet (left out):`);
    for (const s of outcome.skipped) channel.appendLine(`  ${s}`);
    message += ` ${outcome.skipped.length} route${outcome.skipped.length === 1 ? " was" : "s were"} skipped.`;
  }
  const buttons = [...(written ? ["Open"] : []), ...(outcome.skipped.length > 0 ? ["Show Skipped"] : [])];
  const choice = await vscode.window.showInformationMessage(message, ...buttons);
  if (choice === "Open" && written) {
    let stat: vscode.FileStat | undefined;
    try {
      stat = await vscode.workspace.fs.stat(written);
    } catch {
      /* gone: open it as given */
    }
    const file = stat && stat.type & vscode.FileType.Directory ? vscode.Uri.joinPath(written, "index.ts") : written;
    await vscode.window.showTextDocument(file);
  } else if (choice === "Show Skipped") channel.show(true);
}

/** Without `[build.client]`: where to write, the layout, and which services. */
async function askTarget(
  root: vscode.Uri,
): Promise<{ uri: vscode.Uri; opts: { out: string; layout: ClientLayout; services?: string[] } } | undefined> {
  const layoutPick = await vscode.window.showQuickPick(
    [
      { label: "One file", description: "a single .ts module", layout: "file" as ClientLayout },
      { label: "A folder", description: "index.ts, types.ts, codecs.ts and runtime.ts", layout: "dir" as ClientLayout },
    ],
    { title: "Generate TypeScript Client (experimental)", placeHolder: "Layout" },
  );
  if (!layoutPick) return undefined;
  const layout = layoutPick.layout;
  const target =
    layout === "file"
      ? await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(root, "api.ts"),
          filters: { TypeScript: ["ts"] },
          saveLabel: "Generate Client",
        })
      : (
          await vscode.window.showOpenDialog({
            defaultUri: root,
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: "Generate Client Here",
          })
        )?.[0];
  if (!target) return undefined;
  if (target.scheme !== "file") {
    void vscode.window.showErrorMessage("Choose a location on the local file system: `bynk client` writes the files itself.");
    return undefined;
  }
  let services: string[] | undefined;
  const names = await httpServices(root);
  if (names.length > 1) {
    const picks = await vscode.window.showQuickPick(names, {
      canPickMany: true,
      title: "Services to include",
      placeHolder: "Leave all unticked for every `from http` service",
    });
    if (!picks) return undefined;
    if (picks.length > 0 && picks.length < names.length) services = picks;
  }
  return { uri: target, opts: { out: target.fsPath, layout, services } };
}
