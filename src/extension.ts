// Bynk VS Code extension entry point.
//
// Activates on .bynk files or workspaces containing bynk.toml. Provisions the
// bynkc-lsp language server (see server.ts: setting → PATH → cached → download)
// and connects to it as an LSP client. If no server can be provisioned the
// failure is loud and actionable (error toast + a status-bar item + commands to
// retry), rather than silently degrading to grammar-only highlighting.

import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

import {
  compareVersions,
  downloadServer,
  DownloadCancelled,
  expectedServerVersion,
  isBelowMinVersion,
  parseVersion,
  readServerVersion,
  resolveExistingServer,
  serverMinVersion,
  serverVersion,
  targetTriple,
  tooOldServerPrompt,
  type ResolvedServer,
} from "./server";
import { newContext, newProject } from "./scaffold";
import { registerTesting } from "./testing";
import { registerTestCodeLens } from "./testCodeLens";
import { registerApproveRequirements } from "./approveRequirements";
import { provideCodeLenses } from "./codelens";
import { registerSequenceDiagram } from "./sequenceDiagram";
import { registerDocumentationView } from "./documentationView";
import { capabilityPathClientFeature } from "./capabilityPath";
import { explainClientFeature } from "./explainView";
import { refinedExplorerClientFeature, trustExplorerLink } from "./refinedExplorer";
import { registerArchitectureMap } from "./architectureMap";
import { registerAgentStateView } from "./agentStateView";
import { registerContractDiff } from "./contractDiff";
import { registerWireContract } from "./wireContract";
import { registerFeatures } from "./features";
import { ViewRefresh } from "./viewRefresh";
import { StartQueue } from "./startQueue";
import { registerProjectTree } from "./projectTree";
import { activeProjectRoot, watchProjectRoots } from "./projectRoots";
import type { LivePanel } from "./livePanel";

let client: LanguageClient | undefined;
/** #31: every start and restart goes through this, one at a time. */
const startQueue = new StartQueue();
let output: vscode.LogOutputChannel;
let projectNameItem: vscode.StatusBarItem | undefined;
let serverItem: vscode.StatusBarItem | undefined;
/** #2093: the refresh hub shared by every model view (and their cache). */
let viewRefresh: ViewRefresh | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // v10 of vscode-languageclient types `outputChannel` as a `LogOutputChannel`.
  output = vscode.window.createOutputChannel("Bynk LSP", { log: true });

  projectNameItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  projectNameItem.command = "bynk.openProjectConfig";
  serverItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99,
  );
  serverItem.command = "bynk.showServerOutput";
  context.subscriptions.push(projectNameItem, serverItem);

  // Commands work whether or not the server is currently running, so register
  // them before the first start attempt — that way "Restart"/"Download" are
  // available to recover from a failed start.
  context.subscriptions.push(
    vscode.commands.registerCommand("bynk.openProjectConfig", openProjectConfig),
    vscode.commands.registerCommand("bynk.showServerOutput", () => output.show()),
    vscode.commands.registerCommand("bynk.restartServer", () =>
      startServer(context, { interactive: true }),
    ),
    vscode.commands.registerCommand("bynk.downloadServer", () =>
      startServer(context, { interactive: true, forceDownload: true }),
    ),
    // Scaffolding (B-2): work without the server, so register them eagerly too.
    vscode.commands.registerCommand("bynk.newContext", () => newContext()),
    vscode.commands.registerCommand("bynk.newProject", () => newProject()),
  );

  // #2093: the model views share one refresh hub — it turns saves/edits
  // (`bynk.views.refresh`) and the server's round-committed signal (the
  // `handleDiagnostics` middleware below) into refreshes, and caches model
  // fetches so views showing the same model share a request. A closure over
  // the module-level `client` (not the value at registration time), since the
  // client isn't started yet here and is recreated on every `startServer`.
  viewRefresh = new ViewRefresh(() => client);
  context.subscriptions.push(viewRefresh);

  // The features that need only the context, the hub, the client getter or the
  // output channel: see features.ts (add new ones there, not here).
  registerFeatures({ context, output, viewRefresh, client: () => client });

  // v0.59: the Test Explorer — runs `bynkc test --format json`. v0.78: also discovers
  // eagerly and exposes case locations for the Test CodeLens. #2269: its Watch toggle
  // reruns on the hub's change signal, so the hub is built first.
  const testApi = registerTesting(context, viewRefresh);

  // #2473: review and approve the npm packages dependencies' adapters ask for;
  // pending ones are found in `check`/`dev`/`deploy` output, and badge the
  // Project view.
  const approvals = registerApproveRequirements(context);

  // v0.78: a `▷ Run | Debug` CodeLens above each test case (+ native gutter glyphs
  // from the eager discovery above).
  registerTestCodeLens(context, testApi);

  // The four live model views (#846 sequence diagram, #847 documentation,
  // #851 architecture map, #855 wire contract), each a `LivePanel`: refresh
  // on edit, follow the cursor where handler-scoped, restore after a reload.
  const liveViews: Record<string, LivePanel<unknown>> = {
    bynkSequenceDiagram: registerSequenceDiagram(context, viewRefresh) as LivePanel<unknown>,
    bynkDocumentation: registerDocumentationView(context, viewRefresh) as LivePanel<unknown>,
    bynkArchitectureMap: registerArchitectureMap(context, viewRefresh) as LivePanel<unknown>,
    bynkWireContract: registerWireContract(context, viewRefresh) as LivePanel<unknown>,
    // #2467: project-scoped, like the architecture map.
    bynkContractDiff: registerContractDiff(context, viewRefresh) as LivePanel<unknown>,
    // #2196: the agent state view — agent-scoped, so it follows the cursor
    // from agent to agent and highlights the handler under it.
    bynkAgentState: registerAgentStateView(context, viewRefresh) as LivePanel<unknown>,
  };
  // #2097: the Bynk activity-bar project tree — units, `consumes` edges and
  // declarations — on the same refresh hub and model cache as the views.
  registerProjectTree(context, viewRefresh, approvals);
  // Test seams for the integration suite (not contributed, so never in the
  // palette): read a view's state, pin it, and drive the reload path.
  context.subscriptions.push(
    vscode.commands.registerCommand("bynk._liveViewState", (viewType: string) =>
      liveViews[viewType]?.snapshot(),
    ),
    vscode.commands.registerCommand("bynk._liveViewPin", (viewType: string, pinned: boolean) =>
      liveViews[viewType]?.setPinned(pinned),
    ),
    vscode.commands.registerCommand(
      "bynk._liveViewRestore",
      (viewType: string, panel: vscode.WebviewPanel, state: unknown) =>
        liveViews[viewType]?.restore(panel, state),
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateProjectItem()),
    // `bynk.bynkPath` applies live (toolchain.ts); the server path does too.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bynk.executablePath")) {
        void startServer(context, { interactive: false });
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      updateProjectItem();
      void refreshProjectContext();
    }),
  );

  // `bynk.hasProject` gates the command-palette / explorer menus (package.json
  // `contributes.menus`) on "this workspace is a Bynk project". `when` clauses
  // cannot use the `workspaceContains:` activation predicate, so we mirror it as
  // a custom context key, kept live by a `bynk.toml` create/delete watcher.
  watchProjectRoots(context);
  const tomlWatcher = vscode.workspace.createFileSystemWatcher("**/bynk.toml");
  tomlWatcher.onDidCreate(() => void refreshProjectContext());
  tomlWatcher.onDidDelete(() => void refreshProjectContext());
  context.subscriptions.push(tomlWatcher);
  void refreshProjectContext();

  // Not awaited: a download, or a prompt waiting on the user, must not hold
  // activation (#31). The status item and `viewRefresh.whenClient` carry the
  // outcome.
  void startServer(context, { interactive: false });
}

/** Set the `bynk.hasProject` context key from whether the workspace holds any
 *  `bynk.toml`. Drives the `when`-gating of the palette and explorer menus. */
async function refreshProjectContext(): Promise<void> {
  const matches = await vscode.workspace.findFiles(
    "**/bynk.toml",
    "**/node_modules/**",
    1,
  );
  await vscode.commands.executeCommand(
    "setContext",
    "bynk.hasProject",
    matches.length > 0,
  );
}

/** Provision a server, (re)start the client, and reflect the result in the UI.
 *  Safe to call repeatedly (restart command): calls are queued, and one a later
 *  call has superseded stops short of creating a client. */
function startServer(
  context: vscode.ExtensionContext,
  opts: { interactive: boolean; forceDownload?: boolean },
): Promise<void> {
  return startQueue
    .run((superseded, signal) => startServerNow(context, opts, superseded, signal))
    .catch((e) => {
      output.appendLine(`[server] start failed: ${String(e)}`);
      setServerItem("error", "Bynk LSP: failed");
    });
}

async function startServerNow(
  context: vscode.ExtensionContext,
  opts: { interactive: boolean; forceDownload?: boolean },
  superseded: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  // Queued behind a start, then overtaken (or the extension is shutting down):
  // don't stop the client, download, or prompt for work that is replaced.
  if (superseded()) return;
  await stopClient();
  if (superseded()) return;

  const resolved = await ensureServer(context, opts, signal);
  if (superseded()) return;
  if (!resolved) {
    setServerItem("error", "Bynk LSP: not running");
    return;
  }

  const serverOptions: ServerOptions = {
    run: { command: resolved.path, transport: TransportKind.stdio },
    debug: { command: resolved.path, transport: TransportKind.stdio },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "bynk" }],
    synchronize: {
      // No client-side `fileEvents` here: since v0.183 (LSP foundations slice
      // E) the server registers the `**/*.bynk`, `**/bynk.toml` and (#2081)
      // `**/bynk.schema.lock` watchers itself via
      // `workspace/didChangeWatchedFiles` dynamic registration, so it is
      // notified of source, manifest and schema-lock edits for *any* client.
      // Keeping a client-side watcher too would double-notify the server. The
      // separate `tomlWatcher` above is unrelated — it only drives the
      // `bynk.hasProject` context key and never reaches the server.
      configurationSection: "bynk",
    },
    // #2459: read at start-up; later changes reach the server through the
    // `configurationSection` sync above (`workspace/didChangeConfiguration`).
    initializationOptions: {
      docLinks: {
        reportUnresolved: vscode.workspace
          .getConfiguration("bynk")
          .get<string>("docLinks.reportUnresolved", "hint"),
      },
    },
    outputChannel: output,
    middleware: {
      // #2470: a refined type's "Try values…" hover link runs one command.
      provideHover: async (document, position, token, next) =>
        trustExplorerLink(await next(document, position, token)),
      // Client-side gate for the server's always-on inlay hints. The master
      // `bynk.inlayHints.enable` suppresses them entirely (returning []); when
      // on, the per-kind `bynk.inlayHints.types` / `.parameterNames` toggles
      // filter the result by the server-tagged `kind`. Takes effect on the next
      // request (edit/scroll). The built-in `editor.inlayHints.enabled` is the
      // instant, editor-wide toggle — these are the persistent Bynk preferences.
      provideInlayHints: async (document, viewPort, token, next) => {
        const cfg = vscode.workspace.getConfiguration("bynk");
        if (!cfg.get<boolean>("inlayHints.enable", true)) return [];
        const showTypes = cfg.get<boolean>("inlayHints.types", true);
        const showParams = cfg.get<boolean>("inlayHints.parameterNames", true);
        const hints = await next(document, viewPort, token);
        if (!hints || (showTypes && showParams)) return hints;
        return hints.filter((h) =>
          h.kind === vscode.InlayHintKind.Type
            ? showTypes
            : h.kind === vscode.InlayHintKind.Parameter
              ? showParams
              : true,
        );
      },
      // The reference-count CodeLens carries `editor.action.showReferences`,
      // whose arguments must be real VS Code instances; the server sends them
      // as plain LSP JSON, so re-hydrate them client-side.
      provideCodeLenses,
      // #2093: every publish follows a committed analysis round — the moment
      // the model requests (served from that round) can see an edit. The
      // live views re-pull on it while a save/edit has them armed.
      handleDiagnostics: (uri, diagnostics, next) => {
        next(uri, diagnostics);
        viewRefresh?.roundCommitted();
      },
    },
  };

  const started = new LanguageClient("bynk", "Bynk LSP", serverOptions, clientOptions);
  // #2098: tells the server this client runs `bynk.explainDiagnostic`, so it
  // offers the "Explain …" quick fix.
  started.registerFeature(explainClientFeature());
  // #2469: likewise for the "Show capability path" action.
  started.registerFeature(capabilityPathClientFeature());
  started.registerFeature(refinedExplorerClientFeature());
  try {
    await started.start();
  } catch (e) {
    await started.dispose().catch(() => undefined);
    output.appendLine(`[server] failed to start: ${String(e)}`);
    void vscode.window
      .showErrorMessage(
        `Bynk: the language server failed to start (${resolved.source}). See the Bynk LSP output.`,
        "Show Output",
        "Restart",
      )
      .then((pick) => {
        if (pick === "Show Output") output.show();
        if (pick === "Restart") void startServer(context, { interactive: true });
      });
    setServerItem("error", "Bynk LSP: failed");
    return;
  }

  // Published only once running, so `whenClient()` never hands out a client
  // that then fails to start. A later start stops it first.
  client = started;
  if (superseded()) return;
  viewRefresh?.clientStarted();
  void checkVersionMatch(context, resolved);
  setServerItem("ok", `Bynk LSP (${resolved.source})`);
  updateProjectItem();
}

/** Resolve an existing server or, when nothing is configured and the platform
 *  is supported, download one. Returns undefined (after surfacing a clear,
 *  actionable error) when no server can be provisioned. */
async function ensureServer(
  context: vscode.ExtensionContext,
  opts: { interactive: boolean; forceDownload?: boolean },
  signal: AbortSignal,
): Promise<ResolvedServer | undefined> {
  if (!opts.forceDownload) {
    const existing = resolveExistingServer(context);
    if (existing) return existing;
  }

  const configured = vscode.workspace
    .getConfiguration("bynk")
    .get<string>("executablePath", "")
    .trim();
  if (configured && !opts.forceDownload) {
    // An explicit setting that doesn't resolve: don't paper over it with a
    // download — tell the user their setting is wrong.
    reportNoServer(
      `Bynk: \`bynk.executablePath\` is set to "${configured}", but no such executable was found.`,
      context,
    );
    return undefined;
  }

  if (!targetTriple()) {
    reportNoServer(
      `Bynk: no prebuilt language server for ${process.platform}/${process.arch}. ` +
        "Build it with `cargo build --release -p bynk-lsp` and set `bynk.executablePath`.",
      context,
    );
    return undefined;
  }

  try {
    const path = await downloadServer(context, output, signal);
    return { path, source: "downloaded" };
  } catch (e) {
    // Cancelled by the user, or overtaken by a later start: not a failure.
    if (e instanceof DownloadCancelled || signal.aborted) return undefined;
    output.appendLine(`[server] download failed: ${String(e)}`);
    reportNoServer(
      `Bynk: couldn't download the language server (${serverVersion(context)}). ` +
        "It may not be released yet, or the network is unavailable.",
      context,
    );
    return undefined;
  }
}

/** Offer recovery without waiting on it: the start that found no server is
 *  inside the start queue, so awaiting the toast would hold up every later
 *  start (and activation) until it is dismissed. "Download Server" queues a
 *  fresh start of its own. */
function reportNoServer(
  message: string,
  context: vscode.ExtensionContext,
): void {
  void vscode.window
    .showErrorMessage(message, "Download Server", "Open Settings", "Show Output")
    .then((pick) => {
      if (pick === "Download Server") {
        void startServer(context, { interactive: true, forceDownload: true });
      } else if (pick === "Open Settings") {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "bynk.executablePath",
        );
      } else if (pick === "Show Output") {
        output.show();
      }
    });
}

/** Warn if the running server's version disagrees with the one this extension
 *  build expects ({@link expectedServerVersion}: the pin for a downloaded server,
 *  the extension's own version for one from PATH or the setting, #1673). A
 *  server *older* than expected (most likely a stale `bynkc-lsp` on PATH —
 *  `resolveExistingServer` prefers PATH over the pinned/downloaded copy without
 *  comparing versions, #484) gets an actionable prompt, since it can silently
 *  mis-diagnose syntax the checker already accepts. A newer or
 *  otherwise-differing server just gets a note in the output channel: the
 *  download remedy would only fetch an older one. */
async function checkVersionMatch(
  context: vscode.ExtensionContext,
  resolved: ResolvedServer,
): Promise<void> {
  const reported = await readServerVersion(resolved.path); // "bynkc-lsp 0.23.0"
  const expected = expectedServerVersion(
    resolved.source,
    serverVersion(context),
    context.extension.packageJSON.version as string,
  ); // "0.23.0"
  if (!reported) return;

  // Older than the oldest server the extension supports: not a stale-version
  // nudge but an incompatibility, whatever the expected version is. The pin is
  // never below the minimum (server_version.unit.test.ts), so a download helps.
  const min = serverMinVersion(context);
  if (isBelowMinVersion(reported, min)) {
    output.appendLine(
      `[server] too old: running "${reported}" (${resolved.source}), extension needs at least ${min}`,
    );
    const { message, action } = tooOldServerPrompt(resolved.source, resolved.path, reported, min);
    void vscode.window
      .showErrorMessage(message, ...(action ? [action] : []), "Ignore")
      .then((pick) => {
        if (pick === "Open Settings") {
          void vscode.commands.executeCommand("workbench.action.openSettings", "bynk.executablePath");
        } else if (pick === "Download Matching Server") {
          void startServer(context, { interactive: true, forceDownload: true });
        }
      });
    return;
  }

  if (reported.includes(expected)) return;

  output.appendLine(
    `[server] version note: running "${reported}" (${resolved.source}), extension expects ${expected}`,
  );

  const reportedVer = parseVersion(reported);
  const expectedVer = parseVersion(expected);
  const isStale =
    reportedVer && expectedVer && compareVersions(reportedVer, expectedVer) < 0;

  if (isStale && resolved.source === "setting") {
    // Forcing a download here would silently paper over the pinned setting
    // for this session only — it reverts (and re-warns) on the next reload,
    // without ever telling the user the *setting* is what's stale. Point them
    // at it instead.
    void vscode.window
      .showWarningMessage(
        `Bynk: the language server pinned by \`bynk.executablePath\` is "${reported}", ` +
          `older than the ${expected} this extension expects. It may flag valid syntax as errors.`,
        "Open Settings",
        "Ignore",
      )
      .then((pick) => {
        if (pick === "Open Settings") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "bynk.executablePath",
          );
        }
      });
  } else if (isStale && !downloadIsNewer(context, reportedVer)) {
    // #1673: a PATH server can be older than this extension build yet newer
    // than the last shipped release the download fetches, so downloading would
    // only go further back. Point at the PATH install instead.
    void vscode.window.showWarningMessage(
      `Bynk: language server is "${reported}" (${resolved.source}), older than the ` +
        `${expected} this extension expects. Rebuild or reinstall that \`bynkc-lsp\`; ` +
        "the downloadable server is older still.",
    );
  } else if (isStale) {
    void vscode.window
      .showWarningMessage(
        `Bynk: language server is "${reported}" (${resolved.source}), older than the ` +
          `${expected} this extension expects. It may flag valid syntax as errors.`,
        "Download Matching Server",
        "Ignore",
      )
      .then((pick) => {
        if (pick === "Download Matching Server") {
          void startServer(context, { interactive: true, forceDownload: true });
        }
      });
  }
  // A newer or otherwise-differing server: the version note above is all.
}

/** Whether the server a download would fetch (the pin) is newer than
 *  `reported`, i.e. whether "Download Matching Server" actually helps. */
function downloadIsNewer(
  context: vscode.ExtensionContext,
  reported: ReturnType<typeof parseVersion>,
): boolean {
  const pin = parseVersion(serverVersion(context));
  return !!reported && !!pin && compareVersions(reported, pin) < 0;
}

async function stopClient(): Promise<void> {
  if (client) {
    try {
      await client.stop();
    } catch {
      /* already down */
    }
    client = undefined;
  }
}

export async function deactivate(): Promise<void> {
  startQueue.cancelPending();
  await startQueue.idle();
  await stopClient();
}

// ---------------------------------------------------------------------------
// Status bar + project config
// ---------------------------------------------------------------------------

function setServerItem(state: "ok" | "error", text: string): void {
  if (!serverItem) return;
  const icon = state === "ok" ? "$(check)" : "$(error)";
  serverItem.text = `${icon} ${text}`;
  serverItem.tooltip =
    state === "ok"
      ? "Bynk language server is running — click to show its output"
      : "Bynk language server is not running — click to show its output";
  serverItem.backgroundColor =
    state === "error"
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
  updateProjectItem();
}

let projectItemSeq = 0;

function updateProjectItem(): void {
  // Bumped on every call, hiding included, so a read still in flight can't
  // show the item over an editor that has since stopped being Bynk.
  const seq = ++projectItemSeq;
  const show =
    vscode.window.activeTextEditor?.document.languageId === "bynk";
  if (!projectNameItem || !serverItem) return;
  if (!show) {
    projectNameItem.hide();
    serverItem.hide();
    return;
  }
  void readProjectName().then((name) => {
    // A newer editor switch started its own read; don't show this stale name.
    if (seq !== projectItemSeq) return;
    projectNameItem!.text = `$(symbol-package) ${name ?? "no project"}`;
    projectNameItem!.tooltip = name
      ? "Open bynk.toml"
      : "No bynk.toml found in this workspace";
    projectNameItem!.show();
  });
  serverItem.show();
}

async function findBynkToml(): Promise<vscode.Uri | undefined> {
  const root = await activeProjectRoot();
  return root && vscode.Uri.joinPath(root, "bynk.toml");
}

async function readProjectName(): Promise<string | undefined> {
  const tomlUri = await findBynkToml();
  if (!tomlUri) return undefined;
  try {
    const buf = await vscode.workspace.fs.readFile(tomlUri);
    const text = Buffer.from(buf).toString("utf8");
    return text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}

async function openProjectConfig(): Promise<void> {
  const config = await findBynkToml();
  if (config) {
    const doc = await vscode.workspace.openTextDocument(config);
    await vscode.window.showTextDocument(doc);
  } else {
    void vscode.window.showInformationMessage(
      "No bynk.toml found in the current workspace.",
    );
  }
}
