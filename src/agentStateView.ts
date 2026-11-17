// #2196: "Bynk: Show Agent State" — the agent state view (agent-state-views
// track, slice 2). Issues `bynk/agentStateModel` for the agent at the
// command/lens position and renders its state machines (`webview/state.ts`).
//
// A `LivePanel` like the other model views (ADR 0504), but agent-scoped: it
// follows the cursor from agent to agent (`followScope: "owner"`), and inside
// one agent it only moves the highlight to the handler under the cursor,
// without re-requesting the model.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { listLiveInstances, readLiveInstance } from "./agentInspect";
import { onDidChangeDevServer } from "./devServer";
import { commandTarget, LivePanel, type ViewTarget } from "./livePanel";
import { modelCoverage } from "./modelCoverage";
import type { ViewRefresh } from "./viewRefresh";
import type { AgentStateModel, AgentStatePayload } from "./webview/stateTypes";

interface AgentStateModelParams {
  textDocument: { uri: string };
  position: { line: number; character: number };
}

const BODY_CSS = `
  .controls { display: flex; flex-wrap: wrap; align-items: baseline; gap: 1em; margin-bottom: 0.5em; }
  .controls h2 { margin: 0; font-size: 1.1em; font-weight: 600; }
  .controls select { margin-left: 0.25em; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .diagram { overflow-x: auto; margin: 0.5em 0 1em; }
  .diagram .label.focus { font-weight: 700; text-decoration: underline; }
  table.states { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  table.states th, table.states td { border: 1px solid var(--vscode-panel-border, #555); padding: 0.3em 0.6em; text-align: left; vertical-align: top; }
  table.states thead th { background: var(--vscode-editor-inactiveSelectionBackground, transparent); }
  table.states th.unreachable { opacity: 0.55; font-style: italic; }
  table.states .entry { cursor: pointer; white-space: nowrap; }
  table.states .entry.moves { font-weight: 600; }
  table.states .muted { color: var(--vscode-descriptionForeground); }
  table.states tr.focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .flag-known { color: var(--vscode-errorForeground, #f14c4c); }
  .flag-possible { color: var(--vscode-editorWarning-foreground, #cca700); }
  .diagram path.flag-known { stroke: var(--vscode-errorForeground, #f14c4c) !important; stroke-width: 2px; }
  .diagram path.flag-possible { stroke: var(--vscode-editorWarning-foreground, #cca700) !important; stroke-width: 2px; stroke-dasharray: 5 3; }
  .legend p { margin: 0.25em 0; font-size: 0.9em; }
  .effects h3 { font-size: 1em; margin: 0.9em 0 0.3em; }
  .effects.focus h3 { text-decoration: underline; }
  .effects-details { margin-top: 1em; }
  .effects-details summary { cursor: pointer; }
  .muted { color: var(--vscode-descriptionForeground); }
  .live { margin: 0.5em 0 1em; padding: 0.5em 0.75em; border: 1px solid var(--vscode-panel-border, #555); border-radius: 4px; }
  .live h3 { font-size: 1em; margin: 0 0 0.4em; }
  .live .row { display: flex; flex-wrap: wrap; gap: 0.75em; align-items: baseline; margin: 0.25em 0; }
  .live table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  .live td, .live th { padding: 0.15em 0.6em 0.15em 0; text-align: left; vertical-align: top; }
  .live tr.step { cursor: pointer; }
  .live tr.step.selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .live .state-now { font-weight: 700; }
`;

/** The agent the page shows now, for validating its instance requests. */
let shown: AgentStateModel | undefined;

export function registerAgentStateView(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
): LivePanel<AgentStatePayload> {
  const view = new LivePanel<AgentStatePayload>(context, {
    viewType: "bynkAgentState",
    commandLabel: "Show Agent State",
    script: "state.js",
    vendorScripts: ["elk.js"],
    globalName: "__BYNK_AGENT_STATE__",
    bodyCss: BODY_CSS,
    followsCursor: true,
    followScope: "owner",
    scopeNoun: "agent",
    // `bynk-lsp`'s document symbol for `on call place()` is `call place`.
    focusName: (symbol) => symbol.replace(/^call /, ""),
    title: (p) => (p ? `Bynk State: ${p.model.agent}` : "Bynk Agent State"),
    request: requestAgentState,
    missMessage: "Bynk: no agent found at the cursor.",
    onRender: (payload) => {
      shown = payload?.model;
    },
    // #145: the page asks for one listed instance's state, or for the State
    // Migrations view. The host reads only an instance it listed itself.
    onMessage: (message, post) => {
      const m = message as { type: string; ref?: unknown };
      if (m.type === "inspectInstance" && typeof m.ref === "string" && shown) {
        void readLiveInstance(shown, m.ref).then((answer) => answer && post(answer));
      } else if (m.type === "showMigrations") {
        void vscode.commands.executeCommand("bynk.project.focus");
      }
    },
  }, hub);
  // #144: a coverage run, or clearing it, redraws the overlay in place.
  const coverageChanged = modelCoverage.onDidChange(() => {
    void view.refresh();
  });
  context.subscriptions.push(
    view,
    coverageChanged,
    // Not in package.json: what the host answers a page's request for one
    // listed instance, for the integration tests (a webview cannot be driven).
    vscode.commands.registerCommand("bynk._readLiveInstance", (ref: unknown) =>
      shown && typeof ref === "string" ? readLiveInstance(shown, ref) : undefined,
    ),
    // The listing follows the session: it appears when `bynk dev` serves and
    // goes when it stops.
    onDidChangeDevServer(() => void view.refresh()),
    vscode.commands.registerCommand(
      "bynk.showAgentState",
      (uriArg?: unknown, positionArg?: unknown) => {
        const target = commandTarget(uriArg, positionArg, true);
        if (!target) {
          void vscode.window.showErrorMessage(
            "Bynk: Show Agent State needs a .bynk file open (or a Show State lens).",
          );
          return;
        }
        return view.show(target);
      },
    ),
  );
  return view;
}

async function requestAgentState(
  client: LanguageClient,
  target: ViewTarget,
): Promise<AgentStatePayload | null> {
  if (!target.position) return null;
  const params: AgentStateModelParams = {
    textDocument: { uri: target.uri },
    position: target.position,
  };
  const model = await client.sendRequest<AgentStateModel | null>("bynk/agentStateModel", params);
  if (!model) return null;
  // #144: the last coverage run's lines for this file, if any.
  const coverage = await modelCoverage.forUri(target.uri);
  // #145: the running dev server's instances of this agent, if one runs.
  const live = await listLiveInstances(model.agent);
  return { model, uri: target.uri, ...(coverage ? { coverage } : {}), ...(live ? { live } : {}) };
}
