// #846: "Bynk: Show Sequence Diagram" — the extension's first webview panel.
//
// Issues the `bynk/sequenceModel` custom LSP request (this server's first
// non-standard request — see `bynk-lsp/src/sequence_request.rs`) for the
// handler at the invoking CodeLens/command position, renders the result as
// a UML sequence diagram (the first-party engine in `src/diagram/`,
// model-diagrams slice 1), and handles click-to-code: the webview posts
// plain JSON `{uri, range}` (never real VS Code instances — a webview has
// no access to the `vscode` module), hydrated here into a real
// `vscode.Uri`/`Range` and revealed — the same hydration posture
// `codelens.ts` uses for `editor.action.showReferences`, just travelling
// the opposite direction (webview -> host, not server -> client).

// #2093: the panel is now a `LivePanel`: it refreshes on edits, follows the
// cursor from handler to handler (unless pinned), and survives a reload.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { commandTarget, LivePanel, type ViewTarget } from "./livePanel";
import { diagramMessages } from "./diagramHost";
import { isOpenSequence, isShowTiming } from "./sequenceMessages";
import { modelCoverage } from "./modelCoverage";
import type { ViewRefresh } from "./viewRefresh";
import { allTraceViews, bumpTraceIntent, latestTraceTarget, onDidChangeRequestTraces, traceIntent, tracesFor } from "./requestTraces";
import { allowedPageUri, revealLocation } from "./webviewHost";
import type { SequenceModel, SequencePayload } from "./webview/types";

interface SequenceModelParams {
  textDocument: { uri: string };
  position: { line: number; character: number };
}

/** The pending coalesced repost of the traces. */
let repostTimer: ReturnType<typeof setTimeout> | undefined;

export function registerSequenceDiagram(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
): LivePanel<SequencePayload> {
  const shared = diagramMessages(context, "sequence diagram");

  const view = new LivePanel<SequencePayload>(context, {
    viewType: "bynkSequenceDiagram",
    commandLabel: "Show Sequence Diagram",
    script: "webview.js",
    globalName: "__BYNK_SEQUENCE_MODEL__",
    followsCursor: true,
    reportsCursor: true,
    title: () => "Bynk Sequence Diagram",
    request: requestSequence,
    onMessage: (message) => {
      if (shared.handle(message)) return;
      // #218: the trace picker's Show Request Timing.
      if (isShowTiming(message)) {
        void vscode.commands.executeCommand("bynk.showRequestTiming", message.id, message.compareId);
        return;
      }
      if (isOpenSequence(message) && allowedPageUri(message.uri)) {
        // A `ref` link: show the callee's handler in the editor (so a
        // cursor-following view agrees), then its diagram (so a pinned one
        // moves too).
        void revealLocation(message.uri, message.range).then(() =>
          view.show({ uri: message.uri, position: message.range.start }),
        );
      }
    },
    onDispose: () => shared.dispose(),
    missMessage: "Bynk: no handler found at the cursor.",
  }, hub);
  // #144: a coverage run, or clearing it, redraws the overlay in place.
  const coverageChanged = modelCoverage.onDidChange(() => {
    void view.refresh();
  });
  context.subscriptions.push(
    view,
    coverageChanged,
    // #143: a request reached the dev server: show its trace on the diagram
    // the panel has, without asking the language server again.
    // Coalesced: a burst of requests (a load test, a polling client) redraws
    // the page once per 200 ms, not once per request.
    onDidChangeRequestTraces(() => {
      if (repostTimer) return;
      repostTimer = setTimeout(() => {
        repostTimer = undefined;
        view.repost((p) => withTraces(p));
      }, 200);
    }),
    { dispose: () => repostTimer && clearTimeout(repostTimer) },
    // Not in package.json: every stored trace as the page would be given it,
    // for the integration tests (a webview cannot be read back).
    vscode.commands.registerCommand("bynk._requestTraces", () => allTraceViews()),
    vscode.commands.registerCommand("bynk.showRequestTrace", async () => {
      const target = latestTraceTarget();
      if (target.kind === "none") {
        void vscode.window.showInformationMessage(
          "Bynk: no request trace yet. Start the dev server (Bynk: Start Dev Server), send a request, then run this again.",
        );
        return;
      }
      if (target.kind === "no-location") {
        void vscode.window.showInformationMessage(
          `Bynk: the newest request (${target.route}) made no calls with a source location, so there is no handler to open. Open its sequence diagram yourself and the trace will show there, or see where its time went.`,
          "Show Request Timing",
        ).then((pick) => {
          if (pick) void vscode.commands.executeCommand("bynk.showRequestTiming");
        });
        return;
      }
      bumpTraceIntent();
      return view.show({ uri: target.uri, position: { line: target.line, character: target.character } });
    }),
    // Not in package.json: Send Request's Show trace. Follows the latest request again.
    vscode.commands.registerCommand("bynk._showTraceAt", (uriArg?: unknown, positionArg?: unknown) => {
      const target = commandTarget(uriArg, positionArg, true);
      if (!target) return;
      bumpTraceIntent();
      return view.show(target);
    }),
    vscode.commands.registerCommand(
      "bynk.showSequenceDiagram",
      (uriArg?: unknown, positionArg?: unknown) => {
        const target = commandTarget(uriArg, positionArg, true);
        if (!target) {
          void vscode.window.showErrorMessage(
            "Bynk: Show Sequence Diagram needs a .bynk file open (or a Show Sequence lens).",
          );
          return;
        }
        return view.show(target);
      },
    ),
  );
  return view;
}

async function requestSequence(
  client: LanguageClient,
  target: ViewTarget,
): Promise<SequencePayload | null> {
  if (!target.position) return null;
  const params: SequenceModelParams = {
    textDocument: { uri: target.uri },
    position: target.position,
  };
  const model = await client.sendRequest<SequenceModel | null>("bynk/sequenceModel", params);
  if (!model) return null;
  // #144: the last coverage run's lines for this file, if any.
  const coverage = await modelCoverage.forUri(target.uri);
  return withTraces(coverage ? { model, uri: target.uri, coverage } : { model, uri: target.uri });
}

/** #143: the payload with the traces that belong on its handler. */
function withTraces(payload: SequencePayload): SequencePayload {
  const traces = tracesFor(payload.model, payload.uri);
  const { traces: _old, traceIntent: _intent, ...rest } = payload;
  const intent = traceIntent();
  return traces.length > 0 ? { ...rest, traces, ...(intent > 0 ? { traceIntent: intent } : {}) } : rest;
}
