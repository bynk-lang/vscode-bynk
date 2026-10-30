// @webview-entry
// #67: the Send Request panel's page (`out/sendRequest.js`). Runs in the
// webview, so no `vscode` import: it draws the form for the `SrPayload` the
// host embeds as `window.__BYNK_SEND_REQUEST__`, posts what was typed when
// Send is pressed, and shows the `result` the host posts back. The host builds
// and sends the request itself (`sendRequest.ts`).
//
// A refresh (an edit, the dev server starting) re-renders through the live
// view, so the form keeps what was typed: drafts are kept per route, the
// headers per context (an `Authorization` header is usually the same for all
// of a context's routes), in the webview state beside the target. A refresh of
// the same route with the same form only redraws the target line, so typing
// is not interrupted.

import { fillPath, joinUrl, type SrHostMessage, type SrPayload, type SrResult } from "../sendRequestCore";
import { loadPageState, savePageState, startLiveView, type VsCodeApi } from "./live";

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

interface Draft {
  path: Record<string, string>;
  /** Unset until the body is edited, so a changed type's skeleton shows. */
  body?: string;
}

interface PageState {
  drafts: Record<string, Draft>;
  headers: Record<string, string>;
}

const state: PageState = readState();
const results = new Map<string, SrResult>();
let sendingKey: string | undefined;
let shown: { payload: SrPayload; shape: string } | undefined;

function readState(): PageState {
  const s = loadPageState(api) as Partial<PageState> | undefined;
  return {
    drafts: s?.drafts && typeof s.drafts === "object" ? s.drafts : {},
    headers: s?.headers && typeof s.headers === "object" ? s.headers : {},
  };
}

function draft(key: string): Draft {
  return (state.drafts[key] ??= { path: {} });
}

function save(): void {
  savePageState(api, state);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  e.append(...children);
  return e;
}

function card(title: string, ...children: Node[]): HTMLElement {
  return el("section", { className: "sr-card" }, el("h2", { text: title }), ...children);
}

function render(root: HTMLElement, payload: SrPayload | null): void {
  if (!payload) {
    shown = undefined;
    root.textContent = 'Place the cursor on an HTTP handler (on GET("/…")) to send it a request.';
    return;
  }
  const shape = JSON.stringify([payload.key, payload.form]);
  if (shown && shown.shape === shape && root.querySelector("#sr-form")) {
    // Same route, same form: leave the inputs (and the focus) alone.
    shown = { payload, shape };
    renderTarget();
    return;
  }
  shown = { payload, shape };
  const { form, key } = payload;
  const d = draft(key);
  root.textContent = "";

  const h1 = el("h1", {}, el("span", { className: "sr-method", text: form.method }), el("span", { text: form.path }));
  h1.title = "Go to the handler";
  h1.addEventListener("click", () => api.postMessage({ type: "reveal", uri: payload.uri, range: payload.range }));
  root.append(h1, el("p", { className: "sr-muted", text: `${payload.service} in ${payload.unit}` }));

  const formEl = el("div");
  formEl.id = "sr-form";

  if (form.pathParams.length > 0) {
    const rows = form.pathParams.map((name) => {
      const input = el("input");
      input.value = d.path[name] ?? "";
      input.dataset.param = name;
      input.addEventListener("input", () => {
        d.path[name] = input.value;
        save();
        renderUrl();
      });
      return el("label", { className: "sr-param" }, el("span", { text: `:${name}` }), input);
    });
    formEl.append(card("Path", ...rows));
  }

  const headers = el("textarea");
  headers.id = "sr-headers";
  headers.rows = 3;
  headers.placeholder = "Authorization: Bearer …";
  headers.value = state.headers[payload.unit] ?? "";
  headers.addEventListener("input", () => {
    state.headers[payload.unit] = headers.value;
    save();
  });
  const headerNote = form.readsHeaders
    ? [el("p", { className: "sr-muted", text: "This handler reads the request's headers. One header per line, as Name: value." })]
    : [el("p", { className: "sr-muted", text: "One header per line, as Name: value. Shared by this context's routes." })];
  formEl.append(card("Headers", headers, ...headerNote));

  if (form.body) {
    const body = el("textarea");
    body.id = "sr-body";
    const skeleton = form.body.kind === "json" ? form.body.skeleton : "";
    body.value = d.body ?? skeleton;
    body.rows = Math.min(20, Math.max(4, body.value.split("\n").length + 1));
    body.addEventListener("input", () => {
      d.body = body.value;
      save();
    });
    const extra: Node[] = [];
    if (form.body.kind === "raw") {
      extra.push(el("p", { className: "sr-muted", text: `Sent as typed, as ${form.body.contentType}.` }));
    } else {
      const reset = el("button", { className: "sr-secondary", text: "Reset to skeleton" });
      reset.addEventListener("click", () => {
        delete d.body;
        body.value = skeleton;
        save();
      });
      extra.push(el("div", { className: "sr-actions" }, reset));
    }
    formEl.append(card("Body", body, ...extra));
  }

  const send = el("button", { text: "Send" });
  send.id = "sr-send";
  send.title = "Send (Ctrl+Enter)";
  send.addEventListener("click", sendNow);
  const cancel = el("button", { className: "sr-secondary", text: "Cancel" });
  cancel.id = "sr-cancel";
  cancel.addEventListener("click", () => api.postMessage({ type: "cancel" }));
  const url = el("span", { className: "sr-url" });
  url.id = "sr-url";
  formEl.append(el("div", { className: "sr-actions" }, send, cancel, url));

  const target = el("div");
  target.id = "sr-target";
  const response = el("div");
  response.id = "sr-response";
  root.append(target, formEl, response);
  renderTarget();
  renderResult();
}

/** Where the request goes, or why it can't, and the Send button's state. */
function renderTarget(): void {
  const t = document.getElementById("sr-target");
  if (!t || !shown) return;
  const target = shown.payload.target;
  t.textContent = "";
  switch (target.kind) {
    case "ready":
      if (target.note) t.append(el("p", { className: "sr-note", text: target.note }));
      break;
    case "stopped": {
      const start = el("button", { text: "Start Dev Server" });
      start.addEventListener("click", () => api.postMessage({ type: "startDev" }));
      t.append(card("Dev server", el("p", { text: "Requests go to the dev server, which isn't running." }), start));
      break;
    }
    case "starting":
      t.append(card("Dev server", el("p", { text: "The dev server is starting…" })));
      break;
    case "notServed":
      t.append(
        card(
          "Dev server",
          el("p", {
            text: `The dev server isn't serving ${shown.payload.unit}${
              target.served.length > 0 ? ` (it serves ${target.served.join(", ")})` : ""
            }. Restart it with that context.`,
          }),
        ),
      );
      break;
  }
  renderUrl();
  renderButtons();
}

function renderUrl(): void {
  const u = document.getElementById("sr-url");
  if (!u || !shown) return;
  const { form, target } = shown.payload;
  const filled = fillPath(form.path, draft(shown.payload.key).path);
  const path = "path" in filled ? filled.path : form.path;
  u.textContent = `${form.method} ${target.kind === "ready" ? joinUrl(target.url, path) : path}`;
}

function renderButtons(): void {
  const send = document.getElementById("sr-send") as HTMLButtonElement | null;
  const cancel = document.getElementById("sr-cancel") as HTMLButtonElement | null;
  if (!send || !cancel || !shown) return;
  const sending = sendingKey === shown.payload.key;
  send.disabled = sending || shown.payload.target.kind !== "ready";
  cancel.hidden = !sending;
}

function sendNow(): void {
  if (!shown || shown.payload.target.kind !== "ready") return;
  const { key, unit } = shown.payload;
  const d = draft(key);
  const body = (document.getElementById("sr-body") as HTMLTextAreaElement | null)?.value ?? "";
  api.postMessage({ type: "send", key, input: { path: { ...d.path }, headers: state.headers[unit] ?? "", body } });
}

function renderResult(): void {
  const r = document.getElementById("sr-response");
  if (!r || !shown) return;
  r.textContent = "";
  if (sendingKey === shown.payload.key) {
    r.append(card("Response", el("p", { className: "sr-muted", text: "Sending…" })));
    return;
  }
  const result = results.get(shown.payload.key);
  if (!result) return;
  if (result.kind === "error") {
    const lines: Node[] = [el("p", { className: "sr-error", text: result.message })];
    if (result.url) lines.push(el("p", { className: "sr-muted", text: `${result.method ?? ""} ${result.url}` }));
    r.append(card("Response", ...lines));
    return;
  }
  const ok = result.status >= 200 && result.status < 400;
  const status = el("span", {
    className: `sr-status ${ok ? "ok" : "fail"}`,
    text: `${result.status}${result.statusText ? ` ${result.statusText}` : ""}`,
  });
  const meta = el("span", { className: "sr-muted", text: ` · ${result.ms} ms · ${result.method} ${result.url}` });
  const table = el("table", { className: "sr-headers" });
  for (const [k, v] of result.headers) table.append(el("tr", {}, el("td", { text: k }), el("td", { text: v })));
  const headers = el("details", {}, el("summary", { text: `Headers (${result.headers.length})` }), table);
  const parts: Node[] = [el("p", {}, status, meta), headers];
  if (result.body !== "") parts.push(el("pre", { text: result.body }));
  else parts.push(el("p", { className: "sr-muted", text: "Empty body." }));
  if (result.truncated) parts.push(el("p", { className: "sr-note", text: "Showing the first 1 MiB of the body." }));
  r.append(card("Response", ...parts));
}

window.addEventListener("message", (event: MessageEvent<SrHostMessage>) => {
  const msg = event.data;
  if (msg?.type === "sending") {
    sendingKey = msg.key;
    results.delete(msg.key);
  } else if (msg?.type === "result") {
    if (sendingKey === msg.key) sendingKey = undefined;
    results.set(msg.key, msg.result);
  } else {
    return;
  }
  if (shown?.payload.key === msg.key) {
    renderButtons();
    renderResult();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendNow();
  }
});

startLiveView<SrPayload>(api, "__BYNK_SEND_REQUEST__", render);
