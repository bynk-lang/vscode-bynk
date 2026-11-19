// #218: "Bynk: Show Request Timing" — a UML timing diagram of one request: a
// lifeline per participant, a shared time axis, nested cross-Worker calls, the
// longest chain, and a second trace of the same route stacked under it.
//
// It is reached from the sequence page's trace picker (its **Show Request
// Timing** button), from the information message **Show Last Request Trace**
// gives when the newest request has no handler to open, and from the command
// itself, which shows the newest request. The traces are the editor's in-memory
// store (`requestTraces.ts`); nothing here logs or writes one out.
//
// The page (`webview/timing.ts`) draws with the diagram engine. A webview
// cannot be read back, so `bynk._requestTiming` returns what the page was given
// as the layout core made of it, for the integration tests.

import * as vscode from "vscode";

import { diagramMessages } from "./diagramHost";
import { buildComparison, buildTimeline, type Comparison, type Timeline } from "./requestTimingCore";
import { newestTraceId, onDidChangeRequestTraces, timingChoices, timingSource } from "./requestTraces";
import { isShowTiming } from "./sequenceMessages";
import { getNonce, isRevealMessage, renderWebviewHtml, revealLocation } from "./webviewHost";
import type { TimingPayload, TimingUpdate } from "./webview/timingTypes";

const VIEW_TYPE = "bynkRequestTiming";

/** What the page was given, as the layout core reads it (a test seam). */
export interface TimingSnapshot {
  requestId: string;
  route: string;
  timeline: Timeline;
  comparison?: Comparison;
  choices: string[];
}

function payloadFor(id: string, compareId: string | undefined): TimingPayload | undefined {
  const source = timingSource(id);
  if (!source) return undefined;
  const choices = timingChoices(id);
  // Only a trace of the same route and Worker is offered, and only one it can be compared with.
  const compare = compareId !== undefined && compareId !== id && choices.some((c) => c.id === compareId) ? timingSource(compareId) : undefined;
  return { source, ...(compare ? { compare } : {}), choices };
}

/** Whether a comparison was asked for and refused: the other trace is not of
 *  this route in this Worker, or is no longer held. */
function refused(compareId: string | undefined, payload: TimingPayload): boolean {
  return compareId !== undefined && compareId !== payload.source.trace.id && payload.compare === undefined;
}

export function registerRequestTiming(context: vscode.ExtensionContext): void {
  const shared = diagramMessages(context, "request timing diagram");
  let panel: vscode.WebviewPanel | undefined;
  let shown: TimingPayload | undefined;

  const show = (id: string | undefined, compareId?: string): TimingSnapshot | undefined => {
    const chosen = id ?? newestTraceId();
    if (chosen === undefined) {
      void vscode.window.showInformationMessage(
        "Bynk: no request trace yet. Start the dev server (Bynk: Start Dev Server), send a request, then run this again.",
      );
      return undefined;
    }
    const payload = payloadFor(chosen, compareId);
    if (!payload) {
      void vscode.window.showInformationMessage("Bynk: that request trace is no longer held. Send the request again.");
      return undefined;
    }
    shown = payload;
    if (refused(compareId, payload)) {
      void vscode.window.showInformationMessage(
        "Bynk: that request can't be compared: the other trace is of a different route or Worker, or is no longer held. Showing this request alone.",
      );
    }
    const title = `Bynk: Request Timing — ${payload.source.trace.route}`;
    if (!panel) {
      const created = (panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out")],
        },
      ));
      created.onDidDispose(() => {
        panel = undefined;
        shown = undefined;
        shared.dispose();
      });
      created.webview.onDidReceiveMessage((message: unknown) => {
        // The page is untrusted: every message is checked before the host acts.
        if (shared.handle(message)) return;
        if (isRevealMessage(message)) {
          void revealLocation(message.uri, message.range);
        } else if (isShowTiming(message)) {
          show(message.id, message.compareId);
        }
      });
      created.webview.html = renderWebviewHtml({
        webview: created.webview,
        scriptUri: created.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "out", "timing.js")),
        nonce: getNonce(),
        title: "Bynk: Request Timing",
        globalName: "__BYNK_TIMING__",
        payload,
      });
      created.reveal(vscode.ViewColumn.Beside, true);
    } else {
      panel.title = title;
      // Bring it forward: it may be behind another tab, and this was asked for.
      panel.reveal(undefined, true);
      const update: TimingUpdate = { type: "timing", payload };
      void panel.webview.postMessage(update);
    }
    return snapshot(payload);
  };

  // A request arrived (or the store was cleared) while the page is open: its
  // pickers list the route's current traces, so refresh them. Coalesced, like
  // the sequence page's overlay, so a burst of requests redraws once.
  let refresh: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    { dispose: () => { if (refresh) clearTimeout(refresh); panel?.dispose(); } },
    onDidChangeRequestTraces(() => {
      if (!panel || !shown || refresh) return;
      refresh = setTimeout(() => {
        refresh = undefined;
        if (!panel || !shown) return;
        const fresh = payloadFor(shown.source.trace.id, shown.compare?.trace.id);
        if (!fresh) return; // the request on show was evicted: leave it drawn
        shown = fresh;
        const update: TimingUpdate = { type: "timing", payload: fresh };
        void panel.webview.postMessage(update);
      }, 200);
    }),
    // `id`, when given (from a message or a test), is a request id; the palette gives none.
    vscode.commands.registerCommand("bynk.showRequestTiming", (id?: unknown, compareId?: unknown) =>
      show(typeof id === "string" ? id : undefined, typeof compareId === "string" ? compareId : undefined),
    ),
    // Not in package.json: what the open page was given, for the integration tests.
    vscode.commands.registerCommand("bynk._requestTiming", () => (shown ? snapshot(shown) : undefined)),
  );
}

function snapshot(payload: TimingPayload): TimingSnapshot {
  const comparison = payload.compare ? buildComparison(payload.source, payload.compare) : undefined;
  return {
    requestId: payload.source.trace.id,
    route: payload.source.trace.route,
    timeline: comparison ? comparison.a : buildTimeline(payload.source),
    ...(comparison ? { comparison } : {}),
    choices: payload.choices.map((c) => c.id),
  };
}
