// #67: "Bynk: Send Request", a request runner for the `from http` handler at
// the cursor. A `LivePanel` like the wire contract (#855), on the same
// `bynk/wireContract` request: the model carries the route, the handler's
// parameters and the boundary types, which is everything the form needs, so
// there is no `bynk openapi` run and no compiler change (the issue's open
// question). `sendRequestCore.ts` turns the model into the form.
//
// The request goes to the handler's context as `bynk dev` serves it
// (`devServer.ts`), and is sent from the extension host, not the webview: the
// webview's CSP stays as it is, CORS does not apply, and the host only ever
// sends to a URL the dev server reported, never one the page names. The page
// posts what was typed; the host rebuilds the request from its own copy of
// the model.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { devServerState, onDidChangeDevServer } from "./devServer";
import { commandTarget, LivePanel, type ViewTarget } from "./livePanel";
import { handlerSymbols } from "./refreshScheduler";
import {
  buildRequest,
  devTarget,
  formatBody,
  isHttpHandlerHeader,
  routeForm,
  routeKey,
  type SendInput,
  type SrHostMessage,
  type SrPageMessage,
  type SrPayload,
  type SrResult,
} from "./sendRequestCore";
import type { ViewRefresh } from "./viewRefresh";
import { requestWireContract } from "./wireContract";

/** How long a request may take before it is abandoned. */
const TIMEOUT_MS = 30_000;
/** The most of a response body the panel shows. */
const MAX_BODY_BYTES = 1024 * 1024;

const SR_CSS = `
  h1 { display: flex; align-items: baseline; gap: 8px; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); font-size: 1.2em; }
  .sr-method { font-weight: bold; color: var(--vscode-symbolIcon-methodForeground, var(--vscode-textLink-foreground)); }
  .sr-muted { color: var(--vscode-descriptionForeground); }
  .sr-note { color: var(--vscode-editorWarning-foreground); }
  .sr-error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  section.sr-card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 12px; margin: 12px 0; }
  section.sr-card > h2 { margin: 0 0 8px; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; color: var(--vscode-descriptionForeground); }
  label.sr-param { display: grid; grid-template-columns: max-content 1fr; gap: 8px; align-items: center; margin: 4px 0; font-family: var(--vscode-editor-font-family, monospace); }
  input, textarea { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 4px 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); }
  textarea { resize: vertical; }
  input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .sr-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
  .sr-url { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.sr-secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  .sr-status { font-family: var(--vscode-editor-font-family, monospace); font-weight: bold; }
  .sr-status.ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .sr-status.fail { color: var(--vscode-errorForeground); }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow-x: auto; border-radius: 3px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); }
  table.sr-headers { border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
  table.sr-headers td { padding: 1px 8px 1px 0; vertical-align: top; }
  details > summary { cursor: pointer; }
`;

export function registerSendRequest(context: vscode.ExtensionContext, hub: ViewRefresh): LivePanel<SrPayload> {
  /** The latest payload, which a send is checked against and built from. */
  let current: SrPayload | null = null;
  let inflight: AbortController | undefined;

  const view = new LivePanel<SrPayload>(
    context,
    {
      viewType: "bynkSendRequest",
      commandLabel: "Send Request",
      script: "sendRequest.js",
      globalName: "__BYNK_SEND_REQUEST__",
      bodyCss: SR_CSS,
      followsCursor: true,
      title: (p) => (p ? `Send ${p.form.method} ${p.form.path}` : "Bynk Send Request"),
      request: async (client, target) => {
        const payload = await requestPayload(client, target);
        if (payload) current = payload;
        return payload;
      },
      missMessage: 'Bynk: place the cursor on an HTTP handler, such as on GET("/…"), to send it a request.',
      onMessage: (message, post) => {
        const m = message as SrPageMessage;
        switch (m.type) {
          case "send":
            inflight?.abort();
            inflight = new AbortController();
            void send(current, m.key, m.input, inflight, post);
            break;
          case "cancel":
            inflight?.abort();
            break;
          case "startDev":
            void vscode.commands.executeCommand("bynk.startDevServer");
            break;
        }
      },
    },
    hub,
  );
  context.subscriptions.push(
    view,
    { dispose: () => inflight?.abort() },
    // Where a request goes follows the dev server: re-pull so the page's
    // target line and Send button keep up. An unchanged payload is not re-sent.
    onDidChangeDevServer(() => void view.refresh()),
    // Test seam (not contributed): send `input` for the shown route as the
    // page's Send would, resolving to what the page would be posted.
    vscode.commands.registerCommand("bynk._sendRequestSend", (input: SendInput) => {
      const abort = new AbortController();
      return new Promise<SrResult>((resolve) => {
        void send(current, current?.key ?? "", input, abort, (m) => {
          if (m.type === "result") resolve(m.result);
        });
      });
    }),
    vscode.commands.registerCommand("bynk._sendRequestPayload", () => current),
    vscode.commands.registerCommand("bynk.sendRequest", (uriArg?: unknown, positionArg?: unknown) => {
      const target = commandTarget(uriArg, positionArg, true);
      if (!target) {
        void vscode.window.showErrorMessage("Bynk: Send Request needs a .bynk file open.");
        return;
      }
      return view.show(target);
    }),
  );
  registerCodeLens(context, hub);
  return view;
}

async function requestPayload(client: LanguageClient, target: ViewTarget): Promise<SrPayload | null> {
  const wc = await requestWireContract(client, target);
  if (!wc) return null;
  const form = routeForm(wc.model);
  if (!form) return null;
  const { unit, service, range } = wc.model;
  return {
    uri: wc.uri,
    key: routeKey(unit, form),
    unit,
    service,
    range,
    form,
    target: devTarget(unit, devServerState()),
  };
}

/** Send what the page typed for `key`, and post the outcome back. */
async function send(
  payload: SrPayload | null,
  key: string,
  input: SendInput,
  abort: AbortController,
  post: (message: SrHostMessage) => void,
): Promise<void> {
  const fail = (message: string, method?: string, url?: string): void =>
    post({ type: "result", key, result: { kind: "error", message, method, url } });
  if (!payload || payload.key !== key) {
    fail("This handler's route changed. Check the form and send again.");
    return;
  }
  // Where it goes is decided now, not from the payload the page last saw.
  const target = devTarget(payload.unit, devServerState());
  if (target.kind !== "ready") {
    fail(targetProblem(payload.unit, target.kind));
    return;
  }
  const built = buildRequest(payload.form, target.url, sanitize(input));
  if ("error" in built) {
    fail(built.error);
    return;
  }
  const { method, url, headers, body } = built.request;
  post({ type: "sending", key });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, TIMEOUT_MS);
  const started = Date.now();
  try {
    // `manual`: a redirect is the answer to show, not one to follow.
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: abort.signal });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ms = Date.now() - started;
    const contentType = res.headers.get("content-type");
    const truncated = bytes.length > MAX_BODY_BYTES;
    const shown = truncated ? bytes.subarray(0, MAX_BODY_BYTES) : bytes;
    const text = isTextual(contentType)
      ? new TextDecoder().decode(shown)
      : `(${bytes.length} bytes of ${contentType}, not shown)`;
    const { body: formatted, json } = truncated ? { body: text, json: false } : formatBody(contentType, text);
    const result: SrResult = {
      kind: "response",
      method,
      url,
      status: res.status,
      statusText: res.statusText,
      ms,
      headers: [...res.headers.entries()],
      body: formatted,
      json,
      truncated,
    };
    post({ type: "result", key, result });
  } catch (e) {
    if (abort.signal.aborted) {
      fail(timedOut ? `No response after ${TIMEOUT_MS / 1000} s.` : "Cancelled.", method, url);
    } else {
      fail(`Could not reach ${url}: ${networkReason(e)}`, method, url);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** The page's input is untrusted shape: keep only strings. */
function sanitize(input: SendInput): SendInput {
  const path: Record<string, string> = {};
  if (input?.path && typeof input.path === "object") {
    for (const [k, v] of Object.entries(input.path)) if (typeof v === "string") path[k] = v;
  }
  return {
    path,
    headers: typeof input?.headers === "string" ? input.headers : "",
    body: typeof input?.body === "string" ? input.body : "",
  };
}

function targetProblem(unit: string, kind: "stopped" | "starting" | "notServed"): string {
  switch (kind) {
    case "stopped":
      return "The dev server isn't running. Start it (Bynk: Start Dev Server) and send again.";
    case "starting":
      return "The dev server is still starting. Send again once it's ready.";
    case "notServed":
      return `The dev server isn't serving ${unit}. Restart it with that context.`;
  }
}

function isTextual(contentType: string | null): boolean {
  if (!contentType) return true;
  return /^text\/|json|xml|javascript|x-www-form-urlencoded/i.test(contentType);
}

/** Node's fetch hides the socket error in `cause` (`ECONNREFUSED`). */
function networkReason(e: unknown): string {
  const cause = (e as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return e instanceof Error ? e.message : String(e);
}

// A `Send request` CodeLens above each HTTP handler, behind
// `bynk.sendRequest.codeLens`. Unlike the opt-in `Wire contract` lens it is
// on by default: it is only on `from http` handlers, and it is the way in.
function codeLensEnabled(): boolean {
  return vscode.workspace.getConfiguration("bynk").get<boolean>("sendRequest.codeLens", true);
}

class SendRequestCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly hub: ViewRefresh) {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bynk.sendRequest.codeLens")) this.emitter.fire();
    });
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!codeLensEnabled()) return [];
    const uri = document.uri.toString();
    const lenses: vscode.CodeLens[] = [];
    for (const h of handlerSymbols(await this.hub.documentSymbols(document))) {
      const first = h.symbol.range.start.line;
      const last = Math.min(h.symbol.range.end.line, first + 8, document.lineCount - 1);
      const lines: string[] = [];
      for (let l = first; l <= last; l++) lines.push(document.lineAt(l).text);
      if (!isHttpHandlerHeader(lines)) continue;
      const start = h.symbol.selectionRange.start;
      lenses.push(
        new vscode.CodeLens(new vscode.Range(start.line, start.character, start.line, start.character), {
          title: "Send request",
          tooltip: "Send this handler a request on the dev server",
          command: "bynk.sendRequest",
          arguments: [uri, { line: start.line, character: start.character }],
        }),
      );
    }
    return lenses;
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

function registerCodeLens(context: vscode.ExtensionContext, hub: ViewRefresh): void {
  const provider = new SendRequestCodeLensProvider(hub);
  context.subscriptions.push(provider, vscode.languages.registerCodeLensProvider({ language: "bynk" }, provider));
}
