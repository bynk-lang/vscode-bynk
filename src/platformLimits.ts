// #225: the platform-limits wiring. `bynk.platform.plan` chooses which column of
// the limits table applies (`platformLimitsCore.ts`); an Information diagnostic
// from source "bynk limits" marks a handler whose payload may pass a platform
// limit (`payloadHintsCore.ts`, from `bynk/wireContract`). The request timing
// diagram's CPU note (`cpuNoteCore.ts`) reads the same plan.
//
// Nothing here is guessed: a handler with no model fact behind it gets no
// diagnostic, and `bynk.platform.limitHints` turns them all off. The subrequest
// warnings wait on bynk-lang/bynk#3791 (repeated calls on the sequence model).

import * as vscode from "vscode";

import { payloadHints } from "./payloadHintsCore";
import { toPlan, type Plan } from "./platformLimitsCore";
import { handlerSymbols } from "./refreshScheduler";
import type { ViewRefresh } from "./viewRefresh";
import { requestWireContract } from "./wireContract";

export const LIMITS_SOURCE = "bynk limits";

/** The plan the account is on, from `bynk.platform.plan` (the lower limits by default). */
export function currentPlan(): Plan {
  return toPlan(vscode.workspace.getConfiguration("bynk").get("platform.plan"));
}

function hintsEnabled(): boolean {
  return vscode.workspace.getConfiguration("bynk").get<boolean>("platform.limitHints", true);
}

const DEBOUNCE_MS = 400;

export function registerPlatformLimits(context: vscode.ExtensionContext, hub: ViewRefresh): void {
  const collection = vscode.languages.createDiagnosticCollection(LIMITS_SOURCE);
  /** The last document version and plan a document was analysed at. */
  const done = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const analyse = async (doc: vscode.TextDocument): Promise<void> => {
    if (doc.languageId !== "bynk") return;
    const key = doc.uri.toString();
    if (!hintsEnabled()) {
      collection.delete(doc.uri);
      done.delete(key);
      return;
    }
    const plan = currentPlan();
    const stamp = `${doc.version}:${plan}`;
    if (done.get(key) === stamp) return;
    const client = await hub.whenClient(0);
    if (!client) return;
    const diagnostics: vscode.Diagnostic[] = [];
    try {
      for (const h of handlerSymbols(await hub.documentSymbols(doc))) {
        const start = h.symbol.selectionRange.start;
        const payload = await requestWireContract(client, { uri: key, position: { line: start.line, character: start.character } });
        if (!payload) continue;
        for (const hint of payloadHints(payload.model, plan)) {
          const range = new vscode.Range(start.line, start.character, h.symbol.selectionRange.end.line, h.symbol.selectionRange.end.character);
          const d = new vscode.Diagnostic(range, hint.message, vscode.DiagnosticSeverity.Information);
          d.source = LIMITS_SOURCE;
          d.code = `limits.${hint.limit}`;
          diagnostics.push(d);
        }
      }
    } catch {
      // The server cannot answer yet (or is restarting): leave what is shown, and ask again at the next change.
      return;
    }
    // A newer edit has superseded this analysis.
    if (doc.version !== vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)?.version) return;
    collection.set(doc.uri, diagnostics);
    done.set(key, stamp);
  };

  const schedule = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    const pending = timers.get(key);
    if (pending) clearTimeout(pending);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void analyse(doc);
      }, DEBOUNCE_MS),
    );
  };
  const all = (): void => {
    for (const doc of vscode.workspace.textDocuments) schedule(doc);
  };

  context.subscriptions.push(
    collection,
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      collection.delete(doc.uri);
      done.delete(doc.uri.toString());
    }),
    hub.onDidRefresh(() => all()),
    hub.onDidStartClient(() => {
      done.clear();
      all();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bynk.platform")) all();
    }),
  );
  all();
}
