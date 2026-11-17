// #149: the pure part of request scenarios, the `.bynk-http` files. No `vscode`
// import: the unit tests compile against it. `scenario.ts` is the editor side
// (diagnostics, CodeLens, the run command, "Save to scenario").
//
// A scenario is an ordered list of HTTP requests, one `###` block each, which
// diffs a line at a time and keeps the body as raw JSON, exactly as Send
// Request sends it:
//
//     @context shop
//
//     ### create
//     POST /items
//     Content-Type: application/json
//
//     { "name": "widget", "qty": 2 }
//
//     ? status == 201
//     ? body.id exists
//
//     ### fetch
//     GET /items/{{create.body.id}}
//     ? body.name == "widget"
//
// * `@context <unit>` names the context that serves the route: a file-level
//   default before the first step, and an override per step, before its
//   request line. Without one, the route alone must identify the handler.
// * `{{step.status}}`, `{{step.body.a.b[0]}}`, `{{step.header.location}}` read
//   an earlier step's response; `{{env.NAME}}` reads a process environment
//   variable. Either can appear in the path, header values and body.
// * `? <subject> <op> [<json>]` expects something of the response. Subjects
//   are `status`, `body.<path>` and `header <name>`; operators are `==`,
//   `!=`, `exists`, `absent` and `contains`. A value is always JSON.

import type { WcHttpMethod, WcModel, WcRef } from "./webview/wireContractTypes";

// ---------------------------------------------------------------------------
// The file

export interface Problem {
  /** Zero-based line, and the columns within it (the whole line by default). */
  line: number;
  start: number;
  end: number;
  message: string;
  severity: "error" | "warning";
}

export type Subject =
  | { kind: "status" }
  | { kind: "body"; path: PathSeg[]; text: string }
  | { kind: "header"; name: string };

export type Op = "==" | "!=" | "exists" | "absent" | "contains";

export interface Expectation {
  line: number;
  subject: Subject;
  op: Op;
  /** The JSON value, for the operators that take one. */
  value?: unknown;
}

export type PathSeg = string | number;

export interface Step {
  name: string;
  /** The `###` line. */
  line: number;
  /** The `@context` that applies to this step (its own, else the file's). */
  context?: string;
  /** Whether this step names its own `@context`. */
  ownContext: boolean;
  method: WcHttpMethod;
  path: string;
  /** The request line. */
  requestLine: number;
  headers: { name: string; value: string; line: number }[];
  /** The body text as written (without the blank line that precedes it), and
   *  the line it starts on. */
  body?: { text: string; line: number };
  expects: Expectation[];
  /** The last line of the block, for a lens range and edits. */
  endLine: number;
}

export interface Scenario {
  /** The file-level `@context`, if any. */
  context?: string;
  steps: Step[];
  problems: Problem[];
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function problem(line: number, message: string, severity: Problem["severity"] = "error", start = 0, end = Number.MAX_SAFE_INTEGER): Problem {
  return { line, start, end, message, severity };
}

/** Parse a scenario file. It never throws: what is wrong is in `problems`
 *  (syntax only; `validateStep` checks against the wire contract). */
export function parseScenario(text: string): Scenario {
  const lines = text.split(/\r?\n/);
  const scenario: Scenario = { steps: [], problems: [] };
  const names = new Set<string>();

  type Phase = "preamble" | "stepHead" | "headers" | "body" | "expects";
  let phase: Phase = "preamble";
  let cur: Step | undefined;
  let bodyLines: { text: string; line: number }[] = [];

  const closeBody = (): void => {
    if (!cur) return;
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].text.trim() === "") bodyLines.pop();
    if (bodyLines.length > 0) {
      cur.body = { text: bodyLines.map((b) => b.text).join("\n"), line: bodyLines[0].line };
    }
    bodyLines = [];
  };
  const closeStep = (last: number): void => {
    if (!cur) return;
    if (phase === "body") closeBody();
    let end = last;
    while (end > cur.line && lines[end].trim() === "") end--;
    cur.endLine = end;
    if (cur.requestLine < 0) {
      scenario.problems.push(problem(cur.line, `Step \`${cur.name}\` has no request line (\`GET /path\`).`));
    }
    cur = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    const step = /^###\s*(.*)$/.exec(line);
    if (step) {
      closeStep(i - 1);
      const name = step[1].trim();
      if (!NAME.test(name)) {
        scenario.problems.push(problem(i, "A step needs a name: `### create` (letters, digits and `_`)."));
      } else if (names.has(name)) {
        scenario.problems.push(problem(i, `There is already a step named \`${name}\`.`));
      }
      names.add(name);
      cur = {
        name,
        line: i,
        ownContext: false,
        context: scenario.context,
        method: "GET",
        path: "",
        requestLine: -1,
        headers: [],
        expects: [],
        endLine: i,
      };
      scenario.steps.push(cur);
      phase = "stepHead";
      continue;
    }

    // `@context` before the first step is the file's; inside a step's head it
    // is the step's.
    const ctx = /^@context\s+(\S+)\s*$/.exec(line);
    if ((phase === "preamble" || phase === "stepHead") && line.startsWith("@context")) {
      if (!ctx) {
        scenario.problems.push(problem(i, "`@context` takes one context name: `@context shop`."));
      } else if (phase === "preamble") {
        scenario.context = ctx[1];
      } else if (cur) {
        cur.context = ctx[1];
        cur.ownContext = true;
      }
      continue;
    }

    if (phase === "preamble") {
      if (line !== "" && !line.startsWith("#")) {
        scenario.problems.push(problem(i, "Expected `### name` to start a step."));
      }
      continue;
    }
    if (!cur) continue;

    if (phase === "stepHead") {
      if (line === "" || line.startsWith("#")) continue;
      const m = /^([A-Za-z]+)\s+(\S+)\s*$/.exec(line);
      if (!m || !METHODS.includes(m[1])) {
        scenario.problems.push(problem(i, `Expected a request line: \`${METHODS.join("|")} /path\`.`));
        // Carry on as if it were the request line, so the rest still parses.
        cur.requestLine = i;
      } else {
        cur.method = m[1] as WcHttpMethod;
        cur.path = m[2];
        cur.requestLine = i;
        if (!cur.path.startsWith("/")) {
          scenario.problems.push(problem(i, "The path starts with `/`."));
        }
      }
      phase = "headers";
      continue;
    }

    if (phase === "headers") {
      if (line.startsWith("?")) {
        phase = "expects";
      } else if (line === "") {
        phase = "body";
        continue;
      } else if (line.startsWith("#")) {
        continue;
      } else {
        const h = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!h) {
          scenario.problems.push(problem(i, "Expected `Name: value`, a blank line then the body, or a `? expectation`."));
        } else {
          cur.headers.push({ name: h[1], value: h[2], line: i });
        }
        continue;
      }
    }

    if (phase === "body") {
      if (line.startsWith("? ") || line === "?") {
        closeBody();
        phase = "expects";
      } else {
        bodyLines.push({ text: raw, line: i });
        continue;
      }
    }

    if (phase === "expects") {
      if (line === "" || line.startsWith("#")) continue;
      if (!line.startsWith("?")) {
        scenario.problems.push(problem(i, "Only `? expectations` may follow a step's body."));
        continue;
      }
      const parsed = parseExpectation(line.slice(1).trim(), i);
      if ("error" in parsed) scenario.problems.push(problem(i, parsed.error));
      else cur.expects.push(parsed.expectation);
    }
  }
  closeStep(lines.length - 1);
  return scenario;
}

/** One `? …` line, without its `?`. */
export function parseExpectation(src: string, line: number): { expectation: Expectation } | { error: string } {
  const sm = /^(status|header\s+\S+|body(?:[.[]\S*)?)\s+(==|!=|exists|absent|contains)(?:\s+(.*))?$/.exec(src);
  if (!sm) {
    return { error: "Expected `? status == 200`, `? body.id exists` or `? header content-type contains \"json\"`." };
  }
  const subjectText = sm[1];
  const op = sm[2] as Op;
  const rest = (sm[3] ?? "").trim();
  let subject: Subject;
  if (subjectText === "status") {
    subject = { kind: "status" };
  } else if (subjectText.startsWith("header")) {
    subject = { kind: "header", name: subjectText.slice(6).trim().toLowerCase() };
  } else {
    const path = parsePath(subjectText.slice(4));
    if ("error" in path) return path;
    subject = { kind: "body", path: path.path, text: subjectText };
  }
  const takesValue = op === "==" || op === "!=" || op === "contains";
  if (!takesValue) {
    if (rest !== "") return { error: `\`${op}\` takes no value.` };
    if (subject.kind === "status") return { error: `\`status ${op}\` doesn't make sense: a response always has a status.` };
    return { expectation: { line, subject, op } };
  }
  if (rest === "") return { error: `\`${op}\` needs a JSON value: \`${subjectText} ${op} "text"\`.` };
  let value: unknown;
  try {
    value = JSON.parse(rest);
  } catch {
    return { error: `The value must be JSON (strings in double quotes): \`${rest}\` isn't.` };
  }
  if (subject.kind === "status" && (op === "contains" || typeof value !== "number")) {
    return { error: "A status is compared as a number: `? status == 201`." };
  }
  if (subject.kind === "header" && typeof value !== "string") {
    return { error: "A header is compared as a string: `? header content-type contains \"json\"`." };
  }
  return { expectation: { line, subject, op, value } };
}

/** `a.b[0].c`, with an optional leading `.`: the segments, or why not. */
export function parsePath(src: string): { path: PathSeg[] } | { error: string } {
  const path: PathSeg[] = [];
  let rest = src.startsWith(".") ? src.slice(1) : src;
  if (src === "") return { path };
  while (rest !== "") {
    const m = /^(?:\.?([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\])/.exec(rest);
    if (!m) return { error: `\`${src}\` isn't a path like \`a.b[0].c\`.` };
    path.push(m[1] !== undefined ? m[1] : Number(m[2]));
    rest = rest.slice(m[0].length);
  }
  return { path };
}

// ---------------------------------------------------------------------------
// Captures

export interface Ref {
  /** The text between `{{` and `}}`, trimmed. */
  text: string;
  /** Offsets of the whole `{{…}}` in the source string. */
  start: number;
  end: number;
}

/** The `{{…}}` references in a string. */
export function findRefs(text: string): Ref[] {
  return [...text.matchAll(/\{\{([^{}]*)\}\}/g)].map((m) => ({
    text: m[1].trim(),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

export type ParsedRef =
  | { kind: "env"; name: string }
  | { kind: "status"; step: string }
  | { kind: "body"; step: string; path: PathSeg[] }
  | { kind: "header"; step: string; name: string };

export function parseRef(text: string): ParsedRef | { error: string } {
  const env = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text);
  if (env) return { kind: "env", name: env[1] };
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\.(status|body|header)(.*)$/.exec(text);
  if (!m) return { error: `\`{{${text}}}\` isn't \`{{step.status}}\`, \`{{step.body.path}}\`, \`{{step.header.name}}\` or \`{{env.NAME}}\`.` };
  const step = m[1];
  const rest = m[3];
  if (m[2] === "status") {
    return rest === "" ? { kind: "status", step } : { error: `\`{{${text}}}\`: a status has no members.` };
  }
  if (m[2] === "header") {
    const h = /^\.([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/.exec(rest);
    return h ? { kind: "header", step, name: h[1].toLowerCase() } : { error: `\`{{${text}}}\` needs a header name: \`{{${step}.header.location}}\`.` };
  }
  const path = parsePath(rest);
  return "error" in path ? path : { kind: "body", step, path: path.path };
}

/** What a finished step offers to later ones. */
export interface Outcome {
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  /** The body text, as received. */
  body: string;
}

/** The value at `path` in `value`, or `undefined` if it isn't there. */
export function select(value: unknown, path: readonly PathSeg[]): unknown {
  let cur = value;
  for (const seg of path) {
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) return undefined;
      cur = cur[seg];
    } else {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

/** A captured value as text: a string as it is, anything else as JSON. */
function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** The environment's values that were substituted, to be kept out of output. */
export type Secrets = Map<string, string>;

export type Substitution = { text: string } | { unresolved: string };

/** `text` with every `{{…}}` replaced. The first reference that can't be
 *  resolved (a step that isn't done or has no such path, an unset variable) is
 *  returned instead, as written. Values from `env` are added to `secrets`. */
export function substitute(
  text: string,
  outcomes: ReadonlyMap<string, Outcome>,
  env: Readonly<Record<string, string | undefined>>,
  secrets: Secrets,
): Substitution {
  let out = "";
  let at = 0;
  for (const ref of findRefs(text)) {
    out += text.slice(at, ref.start);
    at = ref.end;
    const parsed = parseRef(ref.text);
    if ("error" in parsed) return { unresolved: ref.text };
    let value: string | undefined;
    switch (parsed.kind) {
      case "env": {
        const v = env[parsed.name];
        if (v !== undefined) {
          value = v;
          if (v !== "") secrets.set(v, parsed.name);
        }
        break;
      }
      case "status": {
        const o = outcomes.get(parsed.step);
        if (o) value = String(o.status);
        break;
      }
      case "header": {
        const h = outcomes.get(parsed.step)?.headers[parsed.name];
        if (h !== undefined) value = h;
        break;
      }
      case "body": {
        const o = outcomes.get(parsed.step);
        const json = o && parseJson(o.body);
        const v = json ? select(json.value, parsed.path) : undefined;
        if (v !== undefined) value = asText(v);
        break;
      }
    }
    if (value === undefined) return { unresolved: ref.text };
    out += value;
  }
  return { text: out + text.slice(at) };
}

/** `text` with the environment values in `secrets` hidden. */
export function redact(text: string, secrets: Secrets): string {
  let out = text;
  // Longest first, so a value that contains another is hidden whole.
  for (const [value, name] of [...secrets].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(value).join(`{{env.${name}}}`);
  }
  return out;
}

/** Whether a step's request mentions a `{{…}}` at all. */
function stepTexts(step: Step): string[] {
  return [step.path, ...step.headers.map((h) => h.value), ...(step.body ? [step.body.text] : [])];
}

/** The steps whose responses `step` reads, by name (those that exist or not). */
export function stepDependencies(step: Step): string[] {
  const deps = new Set<string>();
  for (const t of stepTexts(step)) {
    for (const ref of findRefs(t)) {
      const p = parseRef(ref.text);
      if (!("error" in p) && p.kind !== "env") deps.add(p.step);
    }
  }
  return [...deps];
}

/** The steps to run to run `target` alone: it, and what it (transitively)
 *  reads, in file order. */
export function stepsNeededFor(steps: readonly Step[], target: string): Set<string> {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const needed = new Set<string>();
  const visit = (name: string): void => {
    if (needed.has(name)) return;
    const s = byName.get(name);
    if (!s) return;
    needed.add(name);
    for (const d of stepDependencies(s)) visit(d);
  };
  visit(target);
  return needed;
}

// ---------------------------------------------------------------------------
// Expectations

export interface Check {
  line: number;
  ok: boolean;
  /** What was expected and, if it failed, what was found. */
  message: string;
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "nothing" : s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/** Check `outcome` against a step's expectations. */
export function checkExpectations(expects: readonly Expectation[], outcome: Outcome): Check[] {
  const json = parseJson(outcome.body);
  return expects.map((e) => {
    const label = e.subject.kind === "status" ? "status" : e.subject.kind === "header" ? `header ${e.subject.name}` : e.subject.text;
    const want = e.value === undefined ? `${label} ${e.op}` : `${label} ${e.op} ${show(e.value)}`;
    let actual: unknown;
    let present = true;
    if (e.subject.kind === "status") actual = outcome.status;
    else if (e.subject.kind === "header") {
      actual = outcome.headers[e.subject.name];
      present = actual !== undefined;
    } else {
      actual = json ? select(json.value, e.subject.path) : undefined;
      present = actual !== undefined;
      if (!json && e.subject.path.length === 0) {
        actual = outcome.body;
        present = true;
      }
    }
    let ok: boolean;
    switch (e.op) {
      case "exists":
        ok = present;
        break;
      case "absent":
        ok = !present;
        break;
      case "==":
        ok = present && deepEqual(actual, e.value);
        break;
      case "!=":
        ok = present && !deepEqual(actual, e.value);
        break;
      case "contains":
        ok = present && contains(actual, e.value);
        break;
    }
    return {
      line: e.line,
      ok,
      message: ok ? want : `${want}, but ${present ? `found ${show(actual)}` : "there is nothing there"}`,
    };
  });
}

function contains(actual: unknown, want: unknown): boolean {
  if (typeof actual === "string") return typeof want === "string" && actual.includes(want);
  if (Array.isArray(actual)) return actual.some((v) => deepEqual(v, want));
  if (actual !== null && typeof actual === "object" && typeof want === "string") {
    return Object.prototype.hasOwnProperty.call(actual, want);
  }
  return false;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// ---------------------------------------------------------------------------
// Running

/** What a step sends: the host adds the base URL of the context's dev server. */
export interface Prepared {
  /** `http://localhost:PORT`, or why the request can't go. */
  base: string;
  /** The media type to send a body as, unless a header sets one. */
  contentType: string;
}

export interface Sent {
  method: string;
  url: string;
  status: number;
  statusText: string;
  ms: number;
  headers: [string, string][];
  body: string;
}

export interface RunHost {
  /** Where `step` goes, or why it can't. */
  prepare(step: Step): Prepared | { error: string };
  send(request: { method: string; url: string; headers: [string, string][]; body?: string }): Promise<Sent | { error: string }>;
  env: Readonly<Record<string, string | undefined>>;
  /** Variables whose values are hidden from every result even when no step
   *  mentions them, such as the secrets a deployed target declares. */
  redactEnv?: readonly string[];
  cancelled(): boolean;
}

export type StepState = "passed" | "failed" | "skipped" | "error";

export interface StepResult {
  step: string;
  state: StepState;
  /** Why it was skipped or couldn't be sent, or the failing checks. */
  message?: string;
  checks: Check[];
  /** `GET http://…/items/1`, with environment values hidden. */
  request?: string;
  status?: number;
  ms?: number;
  /** The response body shown (hidden values redacted), cut at `BODY_LIMIT`. */
  body?: string;
}

export const BODY_LIMIT = 4000;

/** Run `only` (every step when undefined), in order, sending each through
 *  `host`. A step that reads an unresolved capture, or a step that failed or
 *  was skipped, is skipped and not sent; the run continues past a failure, so
 *  the steps that don't depend on it still run. Values from `env` never appear
 *  in a result. */
export async function runSteps(steps: readonly Step[], host: RunHost, only?: ReadonlySet<string>): Promise<StepResult[]> {
  const outcomes = new Map<string, Outcome>();
  const results: StepResult[] = [];
  for (const step of steps) {
    if (only && !only.has(step.name)) continue;
    if (host.cancelled()) {
      results.push({ step: step.name, state: "skipped", message: "Cancelled.", checks: [] });
      continue;
    }
    results.push(await runStep(step, host, outcomes));
  }
  return results;
}

async function runStep(step: Step, host: RunHost, outcomes: Map<string, Outcome>): Promise<StepResult> {
  const secrets: Secrets = new Map();
  for (const name of host.redactEnv ?? []) {
    const v = host.env[name];
    if (v) secrets.set(v, name);
  }
  const skip = (message: string): StepResult => ({ step: step.name, state: "skipped", message: redact(message, secrets), checks: [] });
  const fail = (message: string, request?: string): StepResult => ({
    step: step.name,
    state: "error",
    message: redact(message, secrets),
    checks: [],
    request: request === undefined ? undefined : redact(request, secrets),
  });

  const sub = (text: string): Substitution => substitute(text, outcomes, host.env, secrets);
  const path = sub(step.path);
  if ("unresolved" in path) return skip(unresolvedMessage(path.unresolved));
  const headerLines: [string, string][] = [];
  for (const h of step.headers) {
    const v = sub(h.value);
    if ("unresolved" in v) return skip(unresolvedMessage(v.unresolved));
    headerLines.push([h.name, v.text]);
  }
  let body: string | undefined;
  if (step.body) {
    const b = sub(step.body.text);
    if ("unresolved" in b) return skip(unresolvedMessage(b.unresolved));
    body = b.text;
  }
  const prepared = host.prepare(step);
  if ("error" in prepared) return fail(prepared.error);
  const bad = headerLines.find(([, v]) => /[^\t\x20-\x7e\x80-\xff]/.test(v));
  if (bad) return fail(`The ${bad[0]} header's value has a character a header can't carry.`);
  if (body !== undefined && !headerLines.some(([k]) => k.toLowerCase() === "content-type")) {
    headerLines.push(["Content-Type", prepared.contentType]);
  }
  const url = prepared.base.replace(/\/+$/, "") + path.text;
  const sent = await host.send({ method: step.method, url, headers: headerLines, body });
  const requestText = `${step.method} ${url}`;
  if ("error" in sent) return fail(sent.error, requestText);

  const outcome: Outcome = {
    status: sent.status,
    headers: Object.fromEntries(sent.headers.map(([k, v]) => [k.toLowerCase(), v])),
    body: sent.body,
  };
  const checks = checkExpectations(step.expects, outcome);
  const failed = checks.filter((c) => !c.ok);
  const result: StepResult = {
    step: step.name,
    state: failed.length > 0 ? "failed" : "passed",
    message: failed.length > 0 ? redact(failed.map((c) => c.message).join("\n"), secrets) : undefined,
    checks: checks.map((c) => ({ ...c, message: redact(c.message, secrets) })),
    request: redact(requestText, secrets),
    status: sent.status,
    ms: sent.ms,
    body: redact(sent.body.length > BODY_LIMIT ? `${sent.body.slice(0, BODY_LIMIT)}…` : sent.body, secrets),
  };
  // A failed step offers nothing to later ones: they are skipped, not sent
  // with what a broken response happened to say.
  if (result.state === "passed") outcomes.set(step.name, outcome);
  return result;
}

function unresolvedMessage(ref: string): string {
  return `skipped: unresolved capture \`${ref}\``;
}

// ---------------------------------------------------------------------------
// The wire contract

/** What a route's wire contract says about the request. */
export interface RouteInfo {
  unit: string;
  method: WcHttpMethod;
  /** As declared, `/items/:id`. */
  path: string;
  model: Pick<WcModel, "envelope" | "types" | "instantiations" | "success">;
  /** The service the handler is in, what a test case addresses. */
  service?: string;
  /** The statuses the handler can answer, from the contract. */
  responses?: WcModel["responses"];
  /** The actors the handler's header names (`by u: User`): what a case may run as. */
  actors?: string[];
  /** Each actor's identity type, from its declaration (`actor User { …, identity = UserId }`). */
  identities?: Record<string, string>;
}

/** Whether a scenario path (its `{{…}}` segments stand for anything) is a
 *  request for `route`'s path. */
export function pathMatches(route: string, scenarioPath: string): boolean {
  const strip = (p: string): string => p.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const a = strip(route).split("/");
  const b = strip(scenarioPath).split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) => (seg.startsWith(":") ? b[i] !== "" : seg === b[i]));
}

export type Resolved = { route: RouteInfo } | { error: string; severity?: Problem["severity"] };

/** The one route a step is for: its method and path, in its context if it
 *  names one. A route several contexts serve, with none named, is an error
 *  that lists them: a scenario never guesses. */
export function resolveRoute(routes: readonly RouteInfo[], step: Pick<Step, "method" | "path" | "context">): Resolved {
  const byRoute = routes.filter((r) => r.method === step.method && pathMatches(r.path, step.path));
  // The most specific route wins within a context: `/items/new` over `/items/:id`.
  const best = (rs: RouteInfo[]): RouteInfo[] => {
    const literal = (r: RouteInfo): number => r.path.split("/").filter((s) => !s.startsWith(":")).length;
    const top = Math.max(...rs.map(literal));
    return rs.filter((r) => literal(r) === top);
  };
  if (byRoute.length === 0) {
    return { error: `No handler serves \`${step.method} ${step.path}\`${step.context ? ` in ${step.context}` : ""}.` };
  }
  const inContext = step.context ? byRoute.filter((r) => unitMatches(r.unit, step.context!)) : byRoute;
  if (inContext.length === 0) {
    return { error: `\`${step.method} ${step.path}\` is not served by ${step.context}; it is served by ${[...new Set(byRoute.map((r) => r.unit))].join(", ")}.` };
  }
  const cands = best(inContext);
  const units = [...new Set(cands.map((r) => r.unit))];
  if (units.length > 1) {
    return { error: `\`${step.method} ${step.path}\` is served by ${units.join(", ")}. Name one with \`@context\`.` };
  }
  return { route: cands[0] };
}

/** A context named in dotted (`a.b`) or worker-dir (`a-b`) form. */
export function unitMatches(unit: string, named: string): boolean {
  return unit === named || unit.replace(/\./g, "-") === named.replace(/\./g, "-");
}

/** The problems with a step as written, against its route's contract, and
 *  against the steps before it. `names` are the steps before this one. */
export function validateStep(
  step: Step,
  resolved: Resolved | undefined,
  before: ReadonlySet<string>,
  all: ReadonlySet<string>,
  /** The earlier steps and the routes they resolved to, to check what a capture reads (#160). */
  earlier: ReadonlyMap<string, EarlierStep> = new Map(),
): Problem[] {
  const out: Problem[] = [];
  const add = (line: number, message: string, severity: Problem["severity"] = "error"): void => {
    out.push(problem(line, message, severity));
  };

  // Captures: every reference names an earlier step.
  const checkRefs = (text: string, line: number): void => {
    for (const ref of findRefs(text)) {
      const p = parseRef(ref.text);
      if ("error" in p) add(line, p.error);
      else if (p.kind !== "env" && !before.has(p.step)) {
        add(line, all.has(p.step) ? `\`${p.step}\` runs after this step, so \`{{${ref.text}}}\` has nothing yet.` : `There is no earlier step named \`${p.step}\`.`);
      } else if (p.kind === "body") {
        const issue = captureIssue(p, earlier);
        if (issue) add(line, `\`{{${ref.text}}}\`: ${issue}`, "warning");
      }
    }
  };
  checkRefs(step.path, step.requestLine);
  for (const h of step.headers) checkRefs(h.value, h.line);
  if (step.body) {
    for (let i = 0; i < step.body.text.split("\n").length; i++) {
      checkRefs(step.body.text.split("\n")[i], step.body.line + i);
    }
  }
  for (const seg of step.path.split("/")) {
    if (seg.startsWith(":")) add(step.requestLine, `Fill in the path parameter \`${seg}\`.`, "warning");
  }

  if (!resolved) return out;
  if ("error" in resolved) {
    add(step.requestLine, resolved.error, resolved.severity ?? "error");
    return out;
  }
  const { envelope, types, instantiations } = resolved.route.model;
  const params = envelope.kind === "Keyed" ? envelope.params : envelope.kind === "Bare" ? [{ name: envelope.param, shape: envelope.shape }] : [];
  out.push(...checkResponseExpectations(step, resolved.route));
  out.push(...checkPathCaptures(step, resolved.route, params, earlier));
  if (envelope.kind === "Raw") {
    if (!step.body) add(step.requestLine, `\`${step.method} ${resolved.route.path}\` takes a ${envelope.contentType} body.`);
    return out;
  }
  const bodyParam = params.find((p) => p.name === "body");
  if (!bodyParam) {
    if (step.body) add(step.body.line, `\`${step.method} ${resolved.route.path}\` takes no body.`);
    return out;
  }
  if (!step.body) {
    add(step.requestLine, `\`${step.method} ${resolved.route.path}\` takes a JSON body.`);
    return out;
  }
  // Unquoted captures stand for any value; mask them so the rest parses. Each
  // marker is numbered, so the type of what it reads can be checked against
  // the field it lands in (#160).
  const captures: { text: string; line: number }[] = [];
  const masked = step.body.text.replace(/\{\{[^{}]*\}\}/g, (m, off: number, s: string) => {
    if (insideString(s, off)) return m;
    captures.push({ text: m.slice(2, -2).trim(), line: step.body!.line + s.slice(0, off).split("\n").length - 1 });
    return `"${WILDCARD}${captures.length - 1}__"`;
  });
  const parsed = parseJson(masked);
  if (!parsed) {
    const err = (() => {
      try {
        JSON.parse(masked);
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    add(step.body.line, `The body isn't valid JSON: ${err}`);
    return out;
  }
  const env: Env = {
    types,
    instantiations,
    capture: (n, expected, where) => {
      const c = captures[n];
      const p = c && parseRef(c.text);
      if (!p || "error" in p || p.kind !== "body") return;
      const warning = captureFit(p, expected, { types, instantiations }, where, earlier, c.text);
      if (warning) add(c.line, warning, "warning");
    },
  };
  for (const issue of validateValue(parsed.value, bodyParam.shape, env, "body")) {
    add(step.body.line, issue);
  }
  return out;
}

const WILDCARD = "__bynk_capture__";

function insideString(src: string, offset: number): boolean {
  let inStr = false;
  for (let i = 0; i < offset; i++) {
    const c = src[i];
    if (c === "\\" && inStr) i++;
    else if (c === '"') inStr = !inStr;
  }
  return inStr;
}

type Env = Pick<WcModel, "types" | "instantiations"> & {
  /** Called where an unquoted capture (marker number `n`) stands for a value of `expected`. */
  capture?: (n: number, expected: WcRef, where: string) => void;
};

/** What is wrong with `value` as a `ref` on the wire, each as `where: what`. */
export function validateValue(value: unknown, ref: WcRef, env: Env, where: string, seen: ReadonlySet<string> = new Set()): string[] {
  if (typeof value === "string" && value.startsWith(WILDCARD)) {
    const n = /^__bynk_capture__(\d+)__$/.exec(value);
    if (n) env.capture?.(Number(n[1]), ref, where);
    return [];
  }
  const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`);
  const json = (want: string, v: unknown): string[] => {
    const ok =
      (want === "Number" && typeof v === "number") ||
      (want === "String" && typeof v === "string") ||
      (want === "Boolean" && typeof v === "boolean") ||
      (want === "Object" && v !== null && typeof v === "object" && !Array.isArray(v)) ||
      (want === "Array" && Array.isArray(v)) ||
      (want === "Null" && v === null);
    return ok ? [] : [`${where}: expected ${want.toLowerCase()}, found ${kind(v)}.`];
  };
  switch (ref.kind) {
    case "Base": {
      const bad = json(ref.json, value);
      if (bad.length === 0 && ref.guards.includes("Integral") && typeof value === "number" && !Number.isInteger(value)) {
        return [`${where}: expected an integer, found ${value}.`];
      }
      return bad;
    }
    case "Bytes":
      return json("String", value);
    case "Unit":
    case "Unchecked":
      return [];
    case "Named":
      return validateNamed(value, ref.name, env, where, seen);
    case "Inst": {
      const inst = env.instantiations.find((i) => i.key === ref.key);
      switch (inst?.kind) {
        case "ListInst": {
          const bad = json("Array", value);
          if (bad.length > 0) return bad;
          return (value as unknown[]).flatMap((v, i) => validateValue(v, inst.elem, env, `${where}[${i}]`, seen));
        }
        case "MapInst": {
          // On the wire a map is an array of `[key, value]` entries.
          if (!Array.isArray(value)) return json("Array", value);
          return value.flatMap((e, i) =>
            Array.isArray(e) && e.length === 2
              ? validateValue(e[0], inst.mapKey, env, `${where}[${i}][0]`, seen).concat(validateValue(e[1], inst.val, env, `${where}[${i}][1]`, seen))
              : [`${where}[${i}]: expected a [key, value] pair.`],
          );
        }
        case "OptionInst":
          return validateTagged(value, where, { Some: [["value", inst.inner]], None: [] }, env, seen);
        case "ResultInst":
          return validateTagged(value, where, { Ok: [["value", inst.ok]], Err: [["error", inst.err]] }, env, seen);
        case "RecordInst":
        case "SumInst":
          return validateNamed(value, inst.name, env, where, seen);
        default:
          return [];
      }
    }
  }
}

function validateTagged(value: unknown, where: string, alts: Record<string, [string, WcRef][]>, env: Env, seen: ReadonlySet<string>): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${where}: expected an object with kind ${Object.keys(alts).map((k) => `"${k}"`).join(" or ")}.`];
  }
  const obj = value as Record<string, unknown>;
  const tag = obj.kind;
  if (typeof tag !== "string" || !(tag in alts)) {
    return [`${where}: kind must be ${Object.keys(alts).map((k) => `"${k}"`).join(" or ")}, found ${JSON.stringify(tag) ?? "nothing"}.`];
  }
  return alts[tag].flatMap(([name, shape]) =>
    name in obj ? validateValue(obj[name], shape, env, `${where}.${name}`, seen) : [`${where}: ${tag} needs "${name}".`],
  );
}

function validateNamed(value: unknown, name: string, env: Env, where: string, seen: ReadonlySet<string>): string[] {
  const type = env.types.find((t) => t.name === name);
  if (!type) return [];
  // A recursive type is checked one level at a time, not unrolled.
  if (seen.has(name) && (value === null || typeof value !== "object")) return [];
  const inner = new Set(seen).add(name);
  const body = type.body;
  const scalar = (json: string): string[] => validateValue(value, { kind: "Base", base: "String", json: json as never, guards: [], expected: { kind: "Json", json: json as never } }, env, where, inner);
  switch (body.kind) {
    case "Scalar": {
      const bad = scalar(body.json);
      if (bad.length === 0 && body.baseGuards.includes("Integral") && typeof value === "number" && !Number.isInteger(value)) {
        return [`${where}: expected an integer, found ${value}.`];
      }
      return bad;
    }
    case "Record":
      return validateFields(value, body.fields, env, where, inner, name);
    case "Sum": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return [`${where}: expected a ${name} object with "${body.wireDiscriminant}".`];
      }
      const tag = (value as Record<string, unknown>)[body.wireDiscriminant];
      const variant = body.variants.find((v) => v.name === tag);
      if (!variant) {
        return [`${where}: "${body.wireDiscriminant}" must be ${body.variants.map((v) => `"${v.name}"`).join(", ")}, found ${JSON.stringify(tag) ?? "nothing"}.`];
      }
      return validateFields(value, variant.payload, env, where, inner, name, body.wireDiscriminant);
    }
  }
}

function validateFields(
  value: unknown,
  fields: readonly { name: string; shape: WcRef; default: string | null }[],
  env: Env,
  where: string,
  seen: ReadonlySet<string>,
  typeName: string,
  discriminant?: string,
): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [`${where}: expected a ${typeName} object, found ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}.`];
  }
  const obj = value as Record<string, unknown>;
  const out: string[] = [];
  for (const f of fields) {
    if (!(f.name in obj)) {
      if (f.default === null) out.push(`${where}: missing "${f.name}".`);
    } else {
      out.push(...validateValue(obj[f.name], f.shape, env, `${where}.${f.name}`, seen));
    }
  }
  const known = new Set(fields.map((f) => f.name));
  if (discriminant) known.add(discriminant);
  for (const k of Object.keys(obj)) if (!known.has(k)) out.push(`${where}: "${k}" isn't a field of ${typeName}.`);
  return out;
}

// ---------------------------------------------------------------------------
// What a response carries (#160)
//
// Every diagnostic in this section is a warning: the contract says what a
// handler declares, not what a running service answers, so an uncertain
// reading must never show as a false error.

/** An earlier step, and the route it resolved to (when the server could say). */
export interface EarlierStep {
  step: Step;
  route?: RouteInfo;
}

/** The status a step expects, from its first `? status == N`. */
export function expectedStatus(step: Pick<Step, "expects">): number | undefined {
  const e = step.expects.find((x) => x.subject.kind === "status" && x.op === "==" && typeof x.value === "number");
  return e ? (e.value as number) : undefined;
}

/** What a route's answer carries, for the checks below. */
export type ResponseShape =
  /** A value of this type, JSON-encoded. */
  | { kind: "value"; ref: WcRef }
  /** `{ "error": String }`. */
  | { kind: "message" }
  /** Raw, a stream, a redirect, nothing, or not known: not checked. */
  | { kind: "skip" };

const SKIP: ResponseShape = { kind: "skip" };

/** The shape a route answers `status` with, or, with no status, its declared
 *  success. The rule agreed on #160: every value variant carries the one `T`;
 *  a message variant carries only `error`; raw, a redirect, no body and a
 *  status the route does not name are skipped, and so is a status whose
 *  answers differ in kind. The boundary's own rejections (`BoundaryImplicit`)
 *  have no body described, so they never decide. */
export function responseShape(route: Pick<RouteInfo, "model" | "responses">, status?: number): ResponseShape {
  if (status === undefined) {
    const ref = route.model.success;
    return ref ? { kind: "value", ref } : SKIP;
  }
  const answers = (route.responses ?? []).filter((r) => r.status === status && r.origin.kind !== "BoundaryImplicit");
  if (answers.length === 0) return SKIP;
  // `body` is v0.633.9; `payload` (a value's `T`) is v0.633.4. An older server has neither.
  const bodies = answers.map((a) => a.body ?? (a.payload ? ({ kind: "Value", ref: a.payload } as const) : null));
  const first = bodies[0];
  if (first?.kind === "Value" && bodies.every((b) => b?.kind === "Value")) return { kind: "value", ref: first.ref };
  if (bodies.every((b) => b?.kind === "Message")) return { kind: "message" };
  return SKIP;
}

const STRING_REF: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };

type Fields = readonly { name: string; shape: WcRef }[];

/** How a ref looks on the wire, as far as a path is concerned. */
type Look =
  | { kind: "record"; fields: Fields }
  | { kind: "sum"; discriminant: string; fields: Fields }
  | { kind: "list"; elem: WcRef }
  | { kind: "map" }
  | { kind: "option"; inner: WcRef }
  | { kind: "result"; ok: WcRef; err: WcRef }
  | { kind: "scalar"; name: string; json: string; base: string; integral: boolean }
  | { kind: "unknown" };

type TypeEnv = Pick<WcModel, "types" | "instantiations">;

function look(ref: WcRef, env: TypeEnv): Look {
  switch (ref.kind) {
    case "Base":
      return { kind: "scalar", name: ref.base, json: ref.json, base: ref.base, integral: ref.guards.includes("Integral") };
    case "Bytes":
      return { kind: "scalar", name: "Bytes", json: "String", base: "Bytes", integral: false };
    case "Named": {
      const t = env.types.find((x) => x.name === ref.name);
      if (!t) return { kind: "unknown" };
      const b = t.body;
      if (b.kind === "Scalar") return { kind: "scalar", name: ref.name, json: b.json, base: b.base, integral: b.baseGuards.includes("Integral") };
      if (b.kind === "Record") return { kind: "record", fields: b.fields };
      return { kind: "sum", discriminant: b.wireDiscriminant, fields: b.variants.flatMap((v) => v.payload) };
    }
    case "Inst": {
      const inst = env.instantiations.find((i) => i.key === ref.key);
      // A generic record or sum is left alone: its fields are in terms of
      // type parameters this walk does not substitute.
      if (inst?.kind === "ListInst") return { kind: "list", elem: inst.elem };
      if (inst?.kind === "MapInst") return { kind: "map" };
      if (inst?.kind === "OptionInst") return { kind: "option", inner: inst.inner };
      if (inst?.kind === "ResultInst") return { kind: "result", ok: inst.ok, err: inst.err };
      return { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

/** The JSON kind a shape is on the wire, when it can be told. */
function jsonKind(l: Look): string | undefined {
  switch (l.kind) {
    case "scalar":
      return l.json;
    case "record":
    case "sum":
    case "option":
    case "result":
      return "Object";
    case "list":
    case "map":
      return "Array";
    default:
      return undefined;
  }
}

function describeRef(ref: WcRef, l: Look): string {
  if (ref.kind === "Named") return `\`${ref.name}\``;
  if (l.kind === "scalar") return `\`${l.name}\``;
  return l.kind === "list" ? "a list" : l.kind === "map" ? "a map" : l.kind === "option" ? "an Option" : l.kind === "result" ? "a Result" : "that value";
}

/** Walk `path` down `ref`. `ref` is what the path ends on, when that is
 *  known; `issue` says where it names something that isn't there; neither
 *  means the path leaves what the contract describes. */
export function walkPath(ref: WcRef, path: readonly PathSeg[], env: TypeEnv): { ref?: WcRef; issue?: string } {
  let cur = ref;
  for (const seg of path) {
    const l = look(cur, env);
    if (l.kind === "unknown") return {};
    const noField = { issue: `${describeRef(cur, l)} has no field \`${String(seg)}\`` };
    if (typeof seg === "number") {
      if (l.kind === "map") return {};
      if (l.kind !== "list") return { issue: `${describeRef(cur, l)} is not a list, so \`[${seg}]\` names nothing` };
      cur = l.elem;
      continue;
    }
    switch (l.kind) {
      case "record":
      case "sum": {
        const f = l.fields.find((x) => x.name === seg);
        if (f) cur = f.shape;
        else if (l.kind === "sum" && seg === l.discriminant) cur = STRING_REF;
        else return noField;
        break;
      }
      // An Option is `{ kind: "Some", value }` or `{ kind: "None" }`; a Result, `Ok(value)` or `Err(error)`.
      case "option":
        if (seg === "value") cur = l.inner;
        else if (seg === "kind") cur = STRING_REF;
        else return noField;
        break;
      case "result":
        if (seg === "value") cur = l.ok;
        else if (seg === "error") cur = l.err;
        else if (seg === "kind") cur = STRING_REF;
        else return noField;
        break;
      default:
        return noField;
    }
  }
  return { ref: cur };
}

/** What `path` finds in what a route answers `status` with. */
export function checkResponsePath(route: Pick<RouteInfo, "model" | "responses">, status: number | undefined, path: readonly PathSeg[]): { ref?: WcRef; issue?: string } {
  const shape = responseShape(route, status);
  if (shape.kind === "skip") return {};
  if (shape.kind === "message") {
    if (path.length === 0) return {};
    if (path[0] !== "error") return { issue: `an error answer carries only \`error\`, not \`${String(path[0])}\`` };
    return path.length === 1 ? { ref: STRING_REF } : { issue: "`error` is a String, which has no members" };
  }
  return walkPath(shape.ref, path, route.model);
}

/** What a field is, for spelling an expectation about it in a suite (#160):
 *  a String can be searched with `contains`; an Option may be absent; the rest
 *  are always there when the answer has them. `undefined` when not known. */
export function fieldKind(ref: WcRef, env: TypeEnv): "string" | "option" | "required" | undefined {
  const l = look(ref, env);
  if (l.kind === "unknown") return undefined;
  if (l.kind === "option") return "option";
  return l.kind === "scalar" && l.json === "String" ? "string" : "required";
}

function answerOf(route: Pick<RouteInfo, "method" | "path">, status: number | undefined): string {
  return `\`${route.method} ${route.path}\` answers ${status === undefined ? "its declared success" : String(status)}`;
}

/** Why a `{{step.body.path}}` names nothing in what `step` answers. */
function captureIssue(p: { step: string; path: PathSeg[] }, earlier: ReadonlyMap<string, EarlierStep>): string | undefined {
  const e = earlier.get(p.step);
  if (!e?.route) return undefined;
  const status = expectedStatus(e.step);
  const r = checkResponsePath(e.route, status, p.path);
  return r.issue ? `${r.issue} (${answerOf(e.route, status)}).` : undefined;
}

/** Whether a capture's value can stand where `expected` is wanted: its JSON
 *  kind must match, and a Float can't fill an integer. Anything not known is
 *  left alone. The message is a warning. */
function captureFit(
  p: { step: string; path: PathSeg[] },
  expected: WcRef,
  env: TypeEnv,
  where: string,
  earlier: ReadonlyMap<string, EarlierStep>,
  text: string,
): string | undefined {
  const e = earlier.get(p.step);
  if (!e?.route) return undefined;
  const got = checkResponsePath(e.route, expectedStatus(e.step), p.path).ref;
  if (!got) return undefined;
  const a = look(got, env);
  const b = look(expected, env);
  const ka = jsonKind(a);
  const kb = jsonKind(b);
  const name = a.kind === "scalar" ? a.name : (ka ?? "a value").toLowerCase();
  if (ka && kb && ka !== kb) return `${where}: \`{{${text}}}\` is ${name} (${ka.toLowerCase()}), but ${kb.toLowerCase()} is expected here.`;
  if (a.kind === "scalar" && b.kind === "scalar" && a.base === "Float" && b.integral) {
    return `${where}: \`{{${text}}}\` is a Float, but an integer is expected here.`;
  }
  return undefined;
}

/** A step's own `? body…` expectations, against what its route answers. */
function checkResponseExpectations(step: Step, route: RouteInfo): Problem[] {
  const out: Problem[] = [];
  const status = expectedStatus(step);
  for (const e of step.expects) {
    if (e.subject.kind !== "body") continue;
    const r = checkResponsePath(route, status, e.subject.path);
    const subject = `\`? ${e.subject.text}\``;
    if (r.issue) {
      out.push(problem(e.line, `${subject}: ${r.issue} (${answerOf(route, status)}).`, "warning"));
    } else if (r.ref && (e.op === "==" || e.op === "!=") && e.value !== undefined) {
      for (const issue of validateValue(e.value, r.ref, route.model, e.subject.text)) out.push(problem(e.line, `${subject}: ${issue}`, "warning"));
    }
  }
  return out;
}

/** A path parameter filled by a capture alone (`/items/{{create.body.id}}`),
 *  against the parameter's type. */
function checkPathCaptures(step: Step, route: RouteInfo, params: Fields, earlier: ReadonlyMap<string, EarlierStep>): Problem[] {
  const out: Problem[] = [];
  const pattern = route.path.split("/");
  const given = step.path.split(/[?#]/, 1)[0].split("/");
  pattern.forEach((seg, i) => {
    if (!seg.startsWith(":") || given[i] === undefined) return;
    const param = params.find((p) => p.name === seg.slice(1));
    const refs = findRefs(given[i]);
    if (!param || refs.length !== 1 || refs[0].start !== 0 || refs[0].end !== given[i].length) return;
    const p = parseRef(refs[0].text);
    if ("error" in p || p.kind !== "body") return;
    const w = captureFit(p, param.shape, route.model, `path parameter \`${seg}\``, earlier, refs[0].text);
    if (w) out.push(problem(step.requestLine, w, "warning"));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Writing

/** Headers whose values are credentials: saved as `{{env.NAME}}`, so a token
 *  is never committed. */
export function isSensitiveHeader(name: string): boolean {
  return /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name) || /(token|secret|api-?key|password|auth)/i.test(name);
}

export interface SaveSpec {
  /** The context's unit. */
  unit: string;
  method: WcHttpMethod;
  /** The route with its path parameters filled in. A parameter left empty
   *  stays as `:name`. */
  path: string;
  /** `Name: value` lines (comments and blanks are dropped). */
  headers: string;
  body?: string;
  /** The status of the response being saved, to expect. */
  status?: number;
}

/** A step name from the route: `POST /items/:id` is `post_items_id`, made
 *  unique among `taken`. */
export function stepNameFor(method: string, path: string, taken: ReadonlySet<string>): string {
  const slug = path
    .split(/[?#]/, 1)[0]
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = `${method.toLowerCase()}${slug ? `_${slug}` : ""}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  return name;
}

/** The step as text, for appending to a scenario file; and the environment
 *  variables the save replaced credentials with. */
export function formatStep(spec: SaveSpec, name: string, fileContext: string | undefined): { text: string; env: string[] } {
  const lines = [`### ${name}`];
  if (spec.unit !== fileContext) lines.push(`@context ${spec.unit}`);
  lines.push(`${spec.method} ${spec.path}`);
  const env: string[] = [];
  for (const raw of spec.headers.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([^:\s]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    if (isSensitiveHeader(m[1]) && findRefs(m[2]).length === 0) {
      const variable = m[1].toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      env.push(variable);
      lines.push(`${m[1]}: {{env.${variable}}}`);
    } else {
      lines.push(`${m[1]}: ${m[2]}`);
    }
  }
  if (spec.body !== undefined && spec.body.trim() !== "") {
    lines.push("", spec.body.replace(/\s+$/, ""));
  }
  if (spec.status !== undefined) {
    if (spec.body !== undefined && spec.body.trim() !== "") lines.push("");
    lines.push(`? status == ${spec.status}`);
  }
  return { text: lines.join("\n") + "\n", env };
}

/** `existing` (a scenario file's text, possibly empty) with the step added;
 *  the new step's first line, and the name it was given. */
export function appendStep(existing: string, spec: SaveSpec): { text: string; line: number; name: string; env: string[] } {
  const parsed = parseScenario(existing);
  const taken = new Set(parsed.steps.map((s) => s.name));
  const name = stepNameFor(spec.method, spec.path, taken);
  const formatted = formatStep(spec, name, existing.trim() === "" ? spec.unit : parsed.context);
  let head = existing;
  if (existing.trim() === "") {
    head = `@context ${spec.unit}\n\n`;
  } else {
    head = existing.replace(/\s+$/, "") + "\n\n";
  }
  return { text: head + formatted.text, line: head.split("\n").length - 1, name, env: formatted.env };
}
