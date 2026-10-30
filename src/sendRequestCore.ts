// #67: the pure part of "Bynk: Send Request". No `vscode` import: the unit
// tests compile against it, and the panel's own bundle (`webview/sendRequest.ts`)
// imports it too, so the page previews the request the host will send.
//
// The model is the `bynk/wireContract` answer for the handler at the cursor
// (#855): it already carries the route (`kind: Http`), the handler's
// parameters (the envelope) and the boundary types, so the form needs no
// `bynk openapi` run. An HTTP handler's parameters are of three kinds (the
// Book's HTTP chapter, `bynk.http.extra_param`): a `:name` path segment's
// value, the JSON `body`, or `headers: RequestHeaders`, which the router fills
// from the request's own headers. There are no query parameters.

import type { DevPhase, ServedContext } from "./devEvents";
import type {
  WcHttpMethod,
  WcJsonKind,
  WcModel,
  WcRef,
  Range,
} from "./webview/wireContractTypes";

/** What the form asks for: the route's path parameters, in path order, and
 *  the body, if the handler takes one. */
export interface RouteForm {
  method: WcHttpMethod;
  /** The route as declared, `/items/:id`. */
  path: string;
  pathParams: string[];
  /** A JSON body pre-filled with a skeleton of its type; a `@raw` route's
   *  body is sent as typed, under its declared media type. */
  body: { kind: "json"; skeleton: string } | { kind: "raw"; contentType: string } | null;
  /** The handler reads the request's headers (`headers: RequestHeaders`). */
  readsHeaders: boolean;
}

/** The form for an HTTP handler's model; `undefined` for any other handler. */
export function routeForm(model: WcModel): RouteForm | undefined {
  if (model.kind.kind !== "Http") return undefined;
  const { method, path } = model.kind;
  const env = model.envelope;
  const params =
    env.kind === "Keyed" ? env.params : env.kind === "Bare" ? [{ name: env.param, shape: env.shape }] : [];
  let body: RouteForm["body"] = null;
  if (env.kind === "Raw") {
    body = { kind: "raw", contentType: env.contentType };
  } else {
    const p = params.find((q) => q.name === "body");
    if (p) body = { kind: "json", skeleton: JSON.stringify(skeleton(p.shape, model), null, 2) };
  }
  return {
    method,
    path,
    pathParams: pathParamNames(path),
    body,
    readsHeaders: params.some((p) => p.name === "headers"),
  };
}

/** The `:name` segments of a route, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
}

/** A value of `ref`'s wire shape to start editing from: empty strings, zeros,
 *  `false`, empty lists and maps, `None`, and a sum's first variant. A
 *  refinement is not satisfied (`""` for a `NonEmpty` string): the boundary's
 *  400 says what it wants, as it would for any client. A recursive reference
 *  is `null`, so the skeleton stays finite. */
export function skeleton(
  ref: WcRef,
  model: Pick<WcModel, "types" | "instantiations">,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  switch (ref.kind) {
    case "Base":
      return jsonDefault(ref.json);
    case "Bytes":
      return ""; // base64
    case "Unit":
    case "Unchecked":
      return null;
    case "Named":
      return named(ref.name, model, seen);
    case "Inst": {
      const inst = model.instantiations.find((i) => i.key === ref.key);
      switch (inst?.kind) {
        case "ListInst":
          return [];
        case "MapInst":
          return {};
        case "OptionInst":
          return { kind: "None" };
        case "RecordInst":
        case "SumInst":
          return named(inst.name, model, seen);
        default:
          return null;
      }
    }
  }
}

function named(name: string, model: Pick<WcModel, "types" | "instantiations">, seen: ReadonlySet<string>): unknown {
  const type = model.types.find((t) => t.name === name);
  if (!type || seen.has(name)) return null;
  const inner = new Set(seen).add(name);
  const body = type.body;
  switch (body.kind) {
    case "Scalar":
      return jsonDefault(body.json);
    case "Record":
      return Object.fromEntries(body.fields.map((f) => [f.name, skeleton(f.shape, model, inner)]));
    case "Sum": {
      const first = body.variants[0];
      if (!first) return null;
      const out: Record<string, unknown> = { [body.wireDiscriminant]: first.name };
      for (const f of first.payload) out[f.name] = skeleton(f.shape, model, inner);
      return out;
    }
  }
}

function jsonDefault(json: WcJsonKind): unknown {
  switch (json) {
    case "Number":
      return 0;
    case "String":
      return "";
    case "Boolean":
      return false;
    case "Object":
      return {};
    case "Array":
      return [];
    case "Null":
      return null;
  }
}

/** The route with its path parameters filled in, each percent-encoded as one
 *  segment; the names left empty, if any. */
export function fillPath(
  path: string,
  values: Readonly<Record<string, string>>,
): { path: string } | { missing: string[] } {
  const missing: string[] = [];
  const filled = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const v = values[name] ?? "";
    if (v === "") missing.push(name);
    return encodeURIComponent(v);
  });
  return missing.length > 0 ? { missing } : { path: filled };
}

/** Headers Node's `fetch` refuses to send (undici's `UND_ERR_INVALID_ARG` /
 *  `UND_ERR_NOT_SUPPORTED`): it manages the framing itself. */
const UNSENDABLE_HEADERS = new Set(["transfer-encoding", "keep-alive", "upgrade", "expect"]);

/** `Name: value` lines as header pairs. Blank lines and `#` comments are
 *  skipped; any other line that is not a header, or is one `fetch` would
 *  refuse, is an error naming the line, so it is not reported later as the
 *  dev server being unreachable. */
export function parseHeaders(text: string): { headers: [string, string][] } | { error: string } {
  const headers: [string, string][] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return { error: `Header line ${i + 1} isn't Name: value.` };
    if (UNSENDABLE_HEADERS.has(m[1].toLowerCase())) {
      return { error: `Header line ${i + 1}: ${m[1]} can't be set; the request's framing is managed for you.` };
    }
    // A header value is Latin-1 octets, without control characters (tab aside).
    if (/[^\t\x20-\x7e\x80-\xff]/.test(m[2])) {
      return { error: `Header line ${i + 1}: the value has a character a header can't carry (control or beyond U+00FF).` };
    }
    headers.push([m[1], m[2]]);
  }
  return { headers };
}

/** What the person typed into the form. */
export interface SendInput {
  path: Record<string, string>;
  headers: string;
  body: string;
}

export interface HttpRequestSpec {
  method: WcHttpMethod;
  url: string;
  headers: [string, string][];
  body?: string;
}

/** The request the form describes, sent to `base` (a dev context's URL), or
 *  what is wrong with the form. A JSON body must parse, and is sent as typed
 *  (not re-serialised), with `Content-Type: application/json` unless the
 *  headers set one. */
export function buildRequest(
  form: RouteForm,
  base: string,
  input: SendInput,
): { request: HttpRequestSpec } | { error: string } {
  const filled = fillPath(form.path, input.path);
  if ("missing" in filled) {
    return { error: `Fill in ${filled.missing.map((n) => `:${n}`).join(", ")}.` };
  }
  const parsed = parseHeaders(input.headers);
  if ("error" in parsed) return parsed;
  const headers = parsed.headers;
  const request: HttpRequestSpec = { method: form.method, url: joinUrl(base, filled.path), headers };
  if (form.body) {
    if (form.body.kind === "json") {
      try {
        JSON.parse(input.body);
      } catch (e) {
        return { error: `The body isn't valid JSON: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const contentType =
      form.body.kind === "json"
        ? "application/json"
        : form.body.contentType === "*/*"
          ? "application/octet-stream"
          : form.body.contentType;
    if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", contentType]);
    request.body = input.body;
  }
  return { request };
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

/** Where a handler's request would go: its context's dev server, or why
 *  there is none. A `bynk dev` context is named in its worker-dir form (`a-b`
 *  for context `a.b`, `ServedContext.name`). */
export type DevTarget =
  | { kind: "ready"; url: string; note?: string }
  | { kind: "starting" }
  | { kind: "stopped" }
  | { kind: "notServed"; served: string[] };

export function devTarget(
  unit: string,
  state: { phase: DevPhase; contexts: readonly ServedContext[]; ready: boolean } | undefined,
): DevTarget {
  if (!state || state.phase === "stopped") return { kind: "stopped" };
  if (!state.ready) return { kind: "starting" };
  const worker = unit.replace(/\./g, "-");
  const ctx = state.contexts.find((c) => c.name === worker || c.name === unit);
  if (!ctx) return { kind: "notServed", served: state.contexts.map((c) => c.name) };
  // A rebuild in flight, or one that failed, leaves the last good build
  // serving: requests still go, but may not reflect the latest edit.
  if (state.phase === "rebuilding") return { kind: "ready", url: ctx.url, note: "Rebuilding: this may answer from the previous build." };
  if (state.phase === "failed") return { kind: "ready", url: ctx.url, note: "The last rebuild failed: this answers from the previous build." };
  return { kind: "ready", url: ctx.url };
}

/** What the panel shows: the model's route, where it would go, and the
 *  handler's location for click-to-code. */
export interface SrPayload {
  uri: string;
  /** The route's identity across refreshes (`unit METHOD /path`), which the
   *  page keys its form drafts and the host checks a send against. */
  key: string;
  unit: string;
  service: string;
  range: Range;
  form: RouteForm;
  target: DevTarget;
}

export function routeKey(unit: string, form: Pick<RouteForm, "method" | "path">): string {
  return `${unit} ${form.method} ${form.path}`;
}

/** A finished send, as the page shows it. */
export type SrResult =
  | {
      kind: "response";
      method: string;
      url: string;
      status: number;
      statusText: string;
      ms: number;
      headers: [string, string][];
      body: string;
      /** The body was JSON and is shown pretty-printed. */
      json: boolean;
      /** Why the body shown is not the whole body (cut at the size limit, or
       *  still streaming when the time limit came). */
      partial?: string;
    }
  | { kind: "error"; message: string; method?: string; url?: string };

/** Host → page. `id` is the page's own number for the send, so a result for
 *  an older send of the same route is not taken for the latest one's. */
export type SrHostMessage =
  | { type: "sending"; key: string; id: number }
  | { type: "result"; key: string; id: number; result: SrResult };

/** Page → host, beyond the live view's own messages. Each route has at most
 *  one request in flight: a new send to it replaces the last, a send to
 *  another route leaves it be. */
export type SrPageMessage =
  | { type: "send"; key: string; id: number; input: SendInput }
  | { type: "cancel"; key: string }
  | { type: "startDev" };

/** The response body as shown: pretty-printed when it is JSON (by its
 *  content type, or by parsing as an object or array). */
export function formatBody(contentType: string | null, text: string): { body: string; json: boolean } {
  const looksJson = /\bjson\b/i.test(contentType ?? "") || /^\s*[[{]/.test(text);
  if (looksJson && text.trim() !== "") {
    try {
      return { body: JSON.stringify(JSON.parse(text), null, 2), json: true };
    } catch {
      // not JSON after all
    }
  }
  return { body: text, json: false };
}

/** Whether a handler starting at `lines[0]` is an HTTP one (`on GET("/x")`).
 *  The document symbols name every handler `call`, so the CodeLens reads the
 *  header; annotations (`@cache(…)`) may come first. */
export function isHttpHandlerHeader(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (/^\s*on\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/.test(line)) return true;
    if (!/^\s*(@|\/\/|$)/.test(line)) return false;
  }
  return false;
}
