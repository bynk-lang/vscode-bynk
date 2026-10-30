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
import { registerHandlerLens } from "./viewsCodeLens";
import { requestWireContract } from "./wireContract";

/** How long a request may take before it is abandoned: before the response
 *  starts, an error; while its body is still arriving (a stream), what came. */
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
  /** The payload the page shows, which a send is checked against and built from. */
  let shown: SrPayload | null = null;
  /** The request in flight for each route. */
  const inflight = new Map<string, AbortController>();

  const start = (key: string, id: number, input: SendInput, post: (m: SrHostMessage) => void): Promise<void> => {
    inflight.get(key)?.abort();
    const abort = new AbortController();
    inflight.set(key, abort);
    return send(shown, key, id, input, abort, post).finally(() => {
      if (inflight.get(key) === abort) inflight.delete(key);
    });
  };

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
      request: requestPayload,
      onRender: (payload) => {
        shown = payload;
      },
      missMessage: 'Bynk: place the cursor on an HTTP handler, such as on GET("/…"), to send it a request.',
      onMessage: (message, post) => {
        const m = message as SrPageMessage;
        switch (m.type) {
          case "send":
            if (typeof m.key === "string" && typeof m.id === "number") void start(m.key, m.id, m.input, post);
            break;
          case "cancel":
            if (typeof m.key === "string") inflight.get(m.key)?.abort();
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
    { dispose: () => inflight.forEach((a) => a.abort()) },
    // Where a request goes follows the dev server. Only the target changes,
    // so recompute it on the shown payload rather than re-request the model.
    onDidChangeDevServer(() => view.repost((p) => ({ ...p, target: devTarget(p.unit, devServerState()) }))),
    // Test seam (not contributed): send `input` for the shown route as the
    // page's Send would, resolving to what the page would be posted.
    vscode.commands.registerCommand("bynk._sendRequestSend", (input: SendInput) => {
      return new Promise<SrResult>((resolve) => {
        void start(shown?.key ?? "", 0, input, (m) => {
          if (m.type === "result") resolve(m.result);
        });
      });
    }),
    vscode.commands.registerCommand("bynk._sendRequestPayload", () => shown),
    vscode.commands.registerCommand("bynk.sendRequest", (uriArg?: unknown, positionArg?: unknown) => {
      const target = commandTarget(uriArg, positionArg, true);
      if (!target) {
        void vscode.window.showErrorMessage("Bynk: Send Request needs a .bynk file open.");
        return;
      }
      return view.show(target);
    }),
  );
  // On by default, unlike the `Wire contract` lens: it is only on `from http`
  // handlers, and it is the way in.
  registerHandlerLens(context, hub, {
    setting: "sendRequest.codeLens",
    enabledByDefault: true,
    title: "Send request",
    tooltip: "Send this handler a request on the dev server",
    command: "bynk.sendRequest",
    filter: (document, h) => isHttpHandler(document, h.symbol.range),
  });
  return view;
}

/** Whether the handler whose symbol spans `range` is an HTTP one: its header
 *  (`on GET("/x")`), past any annotations and comments, says so. */
export function isHttpHandler(
  document: vscode.TextDocument,
  range: { start: { line: number }; end: { line: number } },
): boolean {
  const last = Math.min(range.end.line, document.lineCount - 1);
  const lines: string[] = [];
  for (let l = range.start.line; l <= last; l++) lines.push(document.lineAt(l).text);
  return isHttpHandlerHeader(lines);
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
  id: number,
  input: SendInput,
  abort: AbortController,
  post: (message: SrHostMessage) => void,
): Promise<void> {
  const fail = (message: string, method?: string, url?: string): void =>
    post({ type: "result", key, id, result: { kind: "error", message, method, url } });
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
  post({ type: "sending", key, id });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, TIMEOUT_MS);
  const started = Date.now();
  try {
    // `manual`: a redirect is the answer to show, not one to follow.
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, redirect: "manual", signal: abort.signal });
    } catch (e) {
      if (abort.signal.aborted) fail(timedOut ? `No response after ${TIMEOUT_MS / 1000} s.` : "Cancelled.", method, url);
      else fail(fetchFailure(url, e), method, url);
      return;
    }
    const read = await readBody(res, () => abort.signal.aborted);
    if (abort.signal.aborted && !timedOut) {
      fail("Cancelled.", method, url);
      return;
    }
    const contentType = res.headers.get("content-type");
    const partial = read.cut
      ? `Showing the first ${MAX_BODY_BYTES / 1024 / 1024} MiB of the body.`
      : timedOut
        ? `The body was still arriving after ${TIMEOUT_MS / 1000} s; this is what came.`
        : undefined;
    const text = isTextual(contentType)
      ? new TextDecoder().decode(read.bytes, { stream: partial !== undefined })
      : `(${read.bytes.length}${partial ? "+" : ""} bytes of ${contentType}, not shown)`;
    const { body: shownBody, json } = partial ? { body: text, json: false } : formatBody(contentType, text);
    const result: SrResult = {
      kind: "response",
      method,
      url,
      status: res.status,
      statusText: res.statusText,
      ms: Date.now() - started,
      headers: [...res.headers.entries()],
      body: shownBody,
      json,
      partial,
    };
    post({ type: "result", key, id, result });
  } catch (e) {
    fail(`The response broke off: ${e instanceof Error ? e.message : String(e)}`, method, url);
  } finally {
    clearTimeout(timer);
  }
}

/** Read at most `MAX_BODY_BYTES` of the body, then stop (and cancel the
 *  stream): a large download is not held whole, and a stream that never ends
 *  yields what came before the request was aborted. */
async function readBody(res: Response, aborted: () => boolean): Promise<{ bytes: Uint8Array; cut: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), cut: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        cut = true;
        break;
      }
    }
  } catch (e) {
    if (!aborted()) throw e;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, MAX_BODY_BYTES));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, bytes.length - at);
    bytes.set(part, at);
    at += part.length;
    if (at === bytes.length) break;
  }
  return { bytes, cut };
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

/** Why `fetch` rejected. Node's fetch hides the reason in `cause`: a socket
 *  error (`ECONNREFUSED`) means the server was not reached, but undici's own
 *  codes (`UND_ERR_*`), or none, mean the request itself was refused before
 *  anything was sent. */
function fetchFailure(url: string, e: unknown): string {
  const cause = (e as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  if (code && !code.startsWith("UND_ERR_")) return `Could not reach ${url}: ${code}`;
  const detail = typeof cause?.message === "string" ? cause.message : e instanceof Error ? e.message : String(e);
  return `The request couldn't be sent as written: ${detail}`;
}
