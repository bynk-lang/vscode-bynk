// #191: Bynk notebooks, handler cells: the pure part. No `vscode` import.
//
// A handler cell is ordinary Bynk source, marked by `// @handler`: `stub` lines,
// then a typed call the way a unit-tier case calls a handler by its surface
// (ADR 0205), with the actor it runs as:
//
//     // @handler
//     stub Mailer.send(_) returns true
//     let r <- api.POST("/todos", Todo { title: "buy milk", done: false }) by User(UserId.unsafe("bob"))
//
// `bynk eval` returns the value of the snippet's last expression, and an
// `HttpResult` has no wire shape to return (bynk v0.639.1: "the snippet ran, but
// its value, of type `HttpResult[Item]`, has no wire shape to report"; asked of
// the toolchain in bynk-lang/bynk#3700). So when
// the cell's last statement is the call, this module appends a `match` that
// turns the response into a `String` of JSON, `{"variant": "Created",
// "payload": …}`, which `decodeResponse` reads back. A cell whose last statement
// is something else (a `match` of the user's own, a field of the response) is
// run as written and shown as an expression is.
//
// `trace(Cap.op)` records are not shown: a snippet can read them (`trace(Cap.op)
// .length()` is a value) but cannot return the list, whose element type
// (`__Cap_op_Call`) has no wire shape either (bynk-lang/bynk#3699, #3700).

import { HTTP_VARIANTS } from "./scenarioPromoteCore";
import { analyseCell, renderValue } from "./notebookCore";

const HTTP_METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
/** The last statement as a call to a service's HTTP surface, bound or bare. */
const HTTP_CALL = new RegExp(`^(?:let\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(?::[^<]*?)?<-\\s*)?[A-Za-z_][A-Za-z0-9_]*\\.(?:${HTTP_METHODS})\\s*\\(`);
/** What a bare call is bound to, so the response can be read. */
const BOUND = "response__";

export interface HandlerCell {
  /** What the response is bound to; undefined when the cell ends in something else. */
  response?: string;
  /** Zero-based line of a bare call that was given a binding (its columns shift). */
  rewritten?: number;
  /** Zero-based line the appended `match` starts on: a diagnostic at or after it
   *  is in the extension's own code, not the user's. */
  appendedFrom?: number;
}

/** The source to send in place of the cell's own, and what it did to it.
 *  When the last statement is an HTTP call, the response is observed: a bare
 *  call is bound to `response__` (on the same line, so every line stays where
 *  it was) and a `match` over the response follows. Any other cell is
 *  returned as written. */
export function handlerSource(source: string): { text: string; cell: HandlerCell } {
  const cell = analyseCell(source);
  // The `expect` lines (#209) after the call are checks on it, not the cell's
  // last statement: the call is the last statement that isn't one.
  const tail = cell.body[cell.body.length - 1];
  const last = [...cell.body].reverse().find((s) => !/^expect\b/.test(s.text));
  if (!last || !tail) return { text: source, cell: {} };
  const m = HTTP_CALL.exec(last.text.trimStart());
  if (!m) return { text: source, cell: {} };
  const lines = source.split("\n");
  let name = m[1];
  let rewritten: number | undefined;
  if (name === undefined) {
    name = BOUND;
    lines[last.start] = `let ${BOUND} <- ${lines[last.start]}`;
    rewritten = last.start;
  }
  // Up to the end of the last statement (the `expect`s after the call included):
  // lines after it (comments) stay out of the way.
  const head = lines.slice(0, tail.end + 1).join("\n");
  return { text: `${head}\n${observe(name)}`, cell: { response: name, rewritten, appendedFrom: tail.end + 1 } };
}

/** A `match` that answers `{"variant": …, "payload": …}` as JSON text for each
 *  `HttpResult` variant a case can name. A variant with a tuple payload (`Raw`,
 *  `Streaming`, …) has no payload to show: it falls to the last arm, which
 *  answers `{"variant": null}`. */
export function observe(name: string): string {
  const arms: string[] = [];
  for (const [variant, info] of Object.entries(HTTP_VARIANTS)) {
    if (info.payload === "tuple") continue;
    arms.push(info.payload === "none" ? `  ${variant} => "{\\"variant\\":\\"${variant}\\"}",` : `  ${variant}(p) => "{\\"variant\\":\\"${variant}\\",\\"payload\\":\\(Json.encode(p))}",`);
  }
  arms.push('  _ => "{\\"variant\\":null}",');
  return `match ${name} {\n${arms.join("\n")}\n}`;
}

export interface Response {
  /** The `HttpResult` variant, or null for one this cell cannot show (a raw or streamed body). */
  variant: string | null;
  /** The status the variant carries. */
  status?: number;
  /** Whether the variant carries a payload (`NoContent` and `NotFound` don't). */
  hasPayload: boolean;
  payload?: unknown;
}

/** The response from the value `bynk eval` returned for an observed call: a
 *  `String` of JSON. `undefined` when it is not that. */
export function decodeResponse(value: unknown): Response | undefined {
  if (typeof value !== "string") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.variant === null) return { variant: null, hasPayload: false };
  if (typeof o.variant !== "string") return undefined;
  const info = HTTP_VARIANTS[o.variant];
  return { variant: o.variant, status: info?.status, hasPayload: "payload" in o, payload: o.payload };
}

/** The response as Bynk writes it: `Created({ done: false, title: "buy milk" })`,
 *  `NoContent`, then the status line. */
export function renderResponse(r: Response): string {
  if (r.variant === null) return "A response this cell cannot show";
  const body = r.hasPayload ? `${r.variant}(${r.payload === null ? "()" : renderValue(r.payload)})` : r.variant;
  return `${body}\n: HttpResult${r.status !== undefined ? ` · ${r.status}` : ""}`;
}

/** The response as the cell's `application/json` output. */
export function responseJson(r: Response): unknown {
  return { variant: r.variant, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.hasPayload ? { payload: r.payload } : {}) };
}

/** The unit has no unit-tier suite for `--suite` to build the snippet into:
 *  none at all, or only of another tier. The two errors `bynk eval` gives
 *  (v0.639.1, `bynk/src/cli.rs`). */
export function noUnitSuite(message: string): boolean {
  return /has no unit suite|there is no suite for/.test(message);
}

/** What a handler cell's output says about the suite it ran in. */
export function suiteNote(unit: string, usedSuite: boolean, hasStubs: boolean): string {
  if (!usedSuite) return `Ran without a suite: \`${unit}\` has no unit-tier suite, so only this cell's \`stub\`s apply.`;
  return `Ran inside the unit-tier suite of \`${unit}\` (\`--suite\`): its \`stub\`s, \`fn\`s and fixtures apply.${hasStubs ? " Where the suite stubs the same operation as a `stub` in this cell, the suite's stub is the one that answers." : ""}`;
}

/** The cell with `call` added: `// @handler` first when it is not a handler cell
 *  already, the call after what is there. Undefined when the cell is another
 *  kind (a refined-type cell), which a call would not belong in. */
export function withCall(source: string, call: string, kind: "expression" | "handler"): string {
  const directive = kind === "handler" ? [] : ["// @handler"];
  const body = source.replace(/\s+$/, "");
  // A name the cell has not bound already: `response`, then `response2`, …
  const taken = new Set([...source.matchAll(/\blet\s+(response\d*)\b/g)].map((m) => m[1]));
  let name = "response";
  for (let n = 2; taken.has(name); n++) name = `response${n}`;
  if (body === "") return [...directive, "// Add a `stub Cap.op(_) returns …` line above the call for each capability the handler uses.", `let ${name} <- ${call}`, ""].join("\n");
  const lines = kind === "handler" ? body : [...directive, body].join("\n");
  return `${lines}\nlet ${name} <- ${call}\n`;
}
