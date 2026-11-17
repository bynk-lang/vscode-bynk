// #143: the editor's store of request traces from the running `bynk dev
// --trace-events` session. `devServer.ts` records each `request` event here;
// the sequence diagram asks for the traces that belong on its handler.
//
// Traces live in memory, newest first per handler, and go with the window:
// they are never logged or written out (a route can carry an id or a token).

import * as vscode from "vscode";

import { isInside } from "./pathInside";
import {
  newestTraceTarget,
  type RequestTrace,
  toTraceView,
  TraceStore,
  type TraceView,
  traceRelevant,
} from "./requestTraceCore";
import type { SequenceModel } from "./webview/types";

const store = new TraceStore();
const changed = new vscode.EventEmitter<void>();

/** Fires when a trace arrives or the store is cleared. */
export const onDidChangeRequestTraces = changed.event;

export function recordRequestTrace(trace: RequestTrace, root: vscode.Uri): void {
  store.add(trace);
  sessionRoot = root;
  changed.fire();
}

export function clearRequestTraces(): void {
  store.clear();
  changed.fire();
}

/** The project the traces' paths are relative to. */
let sessionRoot: vscode.Uri | undefined;

/** A path as the driver writes it (project-relative, or absolute for a frame)
 *  as a document URI, or `undefined` for one that leaves the project. */
function resolve(file: string): string | undefined {
  if (!sessionRoot) return undefined;
  const root = sessionRoot.fsPath;
  const full = vscode.Uri.joinPath(sessionRoot, ...file.split(/[\\/]/).filter((p) => p !== "")).fsPath;
  const target = /^([/\\]|[A-Za-z]:)/.test(file) ? file : full;
  return isInside(root, target) ? vscode.Uri.file(target).toString() : undefined;
}

function view(trace: RequestTrace): TraceView {
  return toTraceView(trace, resolve, (id) => store.byId(id));
}

/** The traces that belong on the diagram of `model` in `uri`, newest first. */
export function tracesFor(model: SequenceModel, uri: string): TraceView[] {
  return store
    .all()
    .map(view)
    .filter((t) => traceRelevant(model, uri, t));
}

/** Where **Bynk: Show Last Request Trace** goes for the newest trace. */
export function latestTraceTarget(): ReturnType<typeof newestTraceTarget> {
  return newestTraceTarget(store.all().slice(0, 1).map(view));
}

let intent = 0;
/** #143: the user asked to see a trace (Show trace, Show Last Request Trace):
 *  the page follows the latest request again, whatever it had picked. */
export function bumpTraceIntent(): number {
  return ++intent;
}

export function traceIntent(): number {
  return intent;
}

/** Every stored trace, newest first (a test seam). */
export function allTraceViews(): TraceView[] {
  return store.all().map(view);
}
