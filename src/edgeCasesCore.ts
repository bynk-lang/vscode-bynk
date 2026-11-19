// #229: Generate Edge Cases…, the pure part. No `vscode` import.
//
// A refined type states exactly what its boundary accepts. From the
// predicates `bynk/refinedTypeModel` reports (structured, `Predicate`), this
// derives the values worth trying at the edges: at and just past each bound,
// empty and one character, at and just past a length. It does NOT decide what
// the constructor does with them: every candidate is run through the real
// `Type.of(…)` (one `bynk eval`), and the accept or refuse written into a case
// is what the compiler answered, never a reading of the predicate here.
//
// What a notebook can run. `bynk eval` is a unit-tier case, and at the unit
// tier a call is typed: a value that breaks a refined type is a compile error
// (`bynk.refine.literal_violates`), and `Wire(…)`, the raw input that reaches
// the route's own boundary, is system-tier only (`bynk.test.wire_needs_system`,
// v0.639.1). So an accepted candidate is a handler cell (the typed call, the
// other fields held at a valid sample, the route's success asserted), and a
// refused one is asserted where the unit tier can reach it: the type's
// constructor answers `Err`.

import type { RefinedClause, RefinedModel } from "./webview/refinedTypes";
import type { WcRef, WcType } from "./webview/wireContractTypes";
import { HTTP_VARIANTS, sampleJson, setAt, type PromoteRoute } from "./scenarioPromoteCore";
import { formatStep, resolveRoute, type RouteInfo, type Step } from "./scenarioCore";
import type { Notebook, NbCell } from "./notebookCore";
import type { WcHttpMethod } from "./webview/wireContractTypes";
import type { SrPayload } from "./sendRequestCore";

// ---------------------------------------------------------------------------
// Which route (#233): one reference, whichever entry point names it

/** A route the command is asked for. `uri` is a file of the route's project (the
 *  handler's, or the scenario's): only the project root is taken from it. The
 *  route itself is looked up in the language server's listing of the project's
 *  handlers, so a reference that names nothing listed generates nothing. */
export interface EdgeCaseRoute {
  uri: string;
  unit: string;
  method: WcHttpMethod;
  path: string;
  service?: string;
}

const METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Whether a command argument is a route reference (rather than a file URI). */
export function isEdgeCaseRoute(v: unknown): v is EdgeCaseRoute {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.uri === "string" && typeof r.unit === "string" && typeof r.path === "string" && typeof r.method === "string" && METHODS.includes(r.method) && (r.service === undefined || typeof r.service === "string");
}

/** The listed route a reference names, exactly: the same unit, method, path and service. */
export function findRoute(routes: readonly RouteInfo[], ref: EdgeCaseRoute): RouteInfo | undefined {
  return routes.find((r) => r.unit === ref.unit && r.method === ref.method && r.path === ref.path && r.service === ref.service);
}

/** The route a scenario step is for, as a reference; none when it doesn't resolve. */
export function stepRoute(routes: readonly RouteInfo[], step: Pick<Step, "method" | "path" | "context">, uri: string): EdgeCaseRoute | undefined {
  const r = resolveRoute(routes, step);
  return "route" in r ? { uri, unit: r.route.unit, method: r.route.method, path: r.route.path, service: r.route.service } : undefined;
}

/** The route the Send Request panel is showing, as the host holds it (never what the
 *  page says): the page names it by `key`, which must be the shown route's. */
export function sendRequestRoute(shown: Pick<SrPayload, "key" | "uri" | "unit" | "service" | "form"> | null, key: unknown): EdgeCaseRoute | undefined {
  if (!shown || typeof key !== "string" || shown.key !== key) return undefined;
  return { uri: shown.uri, unit: shown.unit, method: shown.form.method, path: shown.form.path, service: shown.service };
}

// ---------------------------------------------------------------------------
// Candidates from predicates

export interface EdgeCandidate {
  /** The value as Bynk source: `101`, `"ab"`. */
  text: string;
  /** What it probes, for the cell's note. */
  why: string;
  /** A shorter form of `text` for a heading, when it is long. */
  shown: string;
}

export interface Candidates {
  candidates: EdgeCandidate[];
  /** Predicates no candidate was derived from, each with the reason. */
  leftOut: string[];
}

/** Longest string a length bound is probed with: a longer bound is left out. */
export const MAX_PROBE_LENGTH = 256;
/** How many of the explorer's examples a pattern contributes. */
const PATTERN_EXAMPLES = 3;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f\\u2028\\u2029]");
const hasControl = (s: string): boolean => CONTROL.test(s);

function stringCandidate(value: string, why: string): EdgeCandidate | undefined {
  if (hasControl(value)) return undefined;
  const text = JSON.stringify(value);
  const shown = value.length > 12 ? `${JSON.stringify(value.slice(0, 8))}… (${value.length} characters)` : text;
  return { text, why, shown };
}

function intCandidate(n: number, why: string): EdgeCandidate | undefined {
  if (!Number.isSafeInteger(n)) return undefined;
  return { text: String(n), why, shown: String(n) };
}

/** Boundary candidates for a refined type, from the predicates it reports. A
 *  predicate that is not understood, or a base the bounds are not derived for,
 *  is left out and said so. */
export function candidatesFor(model: Pick<RefinedModel, "base" | "clauses" | "examples">): Candidates {
  const out: EdgeCandidate[] = [];
  const leftOut: string[] = [];
  const add = (c: EdgeCandidate | undefined, clause: RefinedClause, fallback: string): void => {
    if (!c) {
      leftOut.push(`${clause.source}: ${fallback}`);
      return;
    }
    const seen = out.find((o) => o.text === c.text);
    if (seen) {
      if (!seen.why.split("; ").includes(c.why)) seen.why += `; ${c.why}`;
    } else out.push(c);
  };
  for (const clause of model.clauses) {
    const p = clause.predicate;
    if (!p || typeof p !== "object") {
      leftOut.push(`${clause.source}: the server sent no structured predicate for it`);
      continue;
    }
    if (model.base === "Float") {
      leftOut.push(`${clause.source}: a Float has no "just past the bound" to write exactly`);
      continue;
    }
    const isInt = model.base === "Int";
    switch (p.kind) {
      case "nonNegative":
        if (!isInt) break;
        add(intCandidate(-1, "just below zero"), clause, "no candidate");
        add(intCandidate(0, "zero, the lowest accepted"), clause, "no candidate");
        continue;
      case "positive":
        if (!isInt) break;
        add(intCandidate(0, "zero, just below the lowest accepted"), clause, "no candidate");
        add(intCandidate(1, "one, the lowest accepted"), clause, "no candidate");
        continue;
      case "range": {
        if (!isInt) break;
        if (!Number.isSafeInteger(p.min) || !Number.isSafeInteger(p.max)) {
          leftOut.push(`${clause.source}: a bound is too large to write exactly`);
          continue;
        }
        add(intCandidate(p.min - 1, "just below the minimum"), clause, "just below the minimum is out of range");
        add(intCandidate(p.min, "the minimum"), clause, "no candidate");
        add(intCandidate(p.max, "the maximum"), clause, "no candidate");
        add(intCandidate(p.max + 1, "just above the maximum"), clause, "just above the maximum is out of range");
        continue;
      }
      case "nonEmpty":
        if (isInt) break;
        add(stringCandidate("", "empty"), clause, "no candidate");
        add(stringCandidate("a", "one character"), clause, "no candidate");
        continue;
      case "minLength":
      case "maxLength":
      case "length": {
        if (isInt) break;
        const n = p.length;
        if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PROBE_LENGTH) {
          leftOut.push(`${clause.source}: a length over ${MAX_PROBE_LENGTH} is not probed`);
          continue;
        }
        const of = (len: number, why: string): void => {
          if (len >= 0) add(stringCandidate("a".repeat(len), why), clause, "no candidate");
        };
        if (p.kind !== "maxLength") {
          of(n - 1, `${n === 0 ? "" : "one "}short of the minimum length`);
          of(n, p.kind === "length" ? "exactly the length" : "the minimum length");
        }
        if (p.kind !== "minLength") {
          if (p.kind === "maxLength") of(n, "the maximum length");
          of(n + 1, "one past the maximum length");
        }
        continue;
      }
      case "matches": {
        if (isInt) break;
        const shown = model.examples.slice(0, PATTERN_EXAMPLES);
        if (shown.length === 0) leftOut.push(`${clause.source}: the explorer offered no example of the pattern`);
        for (const e of shown) add(stringCandidate(e, "an example of the pattern"), clause, "an example with a control character");
        continue;
      }
      default:
        leftOut.push(`${clause.source}: a condition this extension does not derive values from`);
        continue;
    }
    leftOut.push(`${clause.source}: does not apply to a ${model.base}`);
  }
  return { candidates: out, leftOut };
}

// ---------------------------------------------------------------------------
// The refined fields of a route's request

export interface RefinedField {
  /** The envelope parameter the value is in. */
  param: string;
  /** Record fields from the parameter to the value; empty when the parameter is the value. */
  path: string[];
  /** The refined type's name. */
  type: string;
  /** `body.pct`, as a heading says it. */
  label: string;
}

const DEPTH = 4;

/** The refined values a route's request takes, by where they are, and what was
 *  not looked into (a refined type inside a list, an option, a sum). */
export function refinedFields(model: Pick<PromoteRoute["model"], "envelope" | "types" | "instantiations">): { fields: RefinedField[]; leftOut: string[] } {
  const env = model.envelope;
  const params = env.kind === "Keyed" ? env.params : env.kind === "Bare" ? [{ name: env.param, shape: env.shape }] : [];
  const fields: RefinedField[] = [];
  const leftOut: string[] = [];
  const byName = new Map<string, WcType>(model.types.map((t) => [t.name, t]));

  const walk = (param: string, path: string[], ref: WcRef, depth: number): void => {
    const label = [param, ...path].join(".");
    if (ref.kind === "Inst") {
      const inst = model.instantiations.find((i) => i.key === ref.key);
      const inner = inst?.kind === "ListInst" ? inst.elem : inst?.kind === "OptionInst" ? inst.inner : undefined;
      if (inner && refines(inner, byName, model, 0)) leftOut.push(`\`${label}\`: a refined type inside a list or an option is not varied`);
      return;
    }
    if (ref.kind !== "Named") return;
    const t = byName.get(ref.name);
    if (!t) return;
    if (t.body.kind === "Scalar") {
      if (t.body.predicates.length === 0) return;
      if (t.body.opaque) leftOut.push(`\`${label}\`: ${t.name} is opaque, so it has no constructor to try values against`);
      else fields.push({ param, path, type: t.name, label });
      return;
    }
    if (t.body.kind === "Record") {
      if (depth >= DEPTH) {
        leftOut.push(`\`${label}\`: nested too deeply`);
        return;
      }
      for (const f of t.body.fields) walk(param, [...path, f.name], f.shape, depth + 1);
      return;
    }
    if (refines(ref, byName, model, 0)) leftOut.push(`\`${label}\`: a refined type inside a sum type is not varied`);
  };
  for (const p of params) walk(p.name, [], p.shape, 0);
  return { fields, leftOut };
}

/** Whether a refined scalar is anywhere inside `ref`. */
function refines(ref: WcRef, byName: ReadonlyMap<string, WcType>, model: Pick<PromoteRoute["model"], "instantiations">, depth: number): boolean {
  if (depth > DEPTH) return false;
  if (ref.kind === "Inst") {
    const inst = model.instantiations.find((i) => i.key === ref.key);
    const inner = inst?.kind === "ListInst" ? inst.elem : inst?.kind === "OptionInst" ? inst.inner : undefined;
    return inner !== undefined && refines(inner, byName, model, depth + 1);
  }
  if (ref.kind !== "Named") return false;
  const t = byName.get(ref.name);
  if (!t) return false;
  if (t.body.kind === "Scalar") return t.body.predicates.length > 0;
  if (t.body.kind === "Record") return t.body.fields.some((f) => refines(f.shape, byName, model, depth + 1));
  return t.body.variants.some((v) => v.payload.some((f) => refines(f.shape, byName, model, depth + 1)));
}

/** The type names of `fields`, once each, in order. */
export function typesOf(fields: readonly RefinedField[]): string[] {
  return [...new Set(fields.map((f) => f.type))];
}

// ---------------------------------------------------------------------------
// What the route answers

/** The line that asserts the route's success: the one 2xx variant the handler
 *  answers with. The contract lists the declared success (`Ok`, for a handler
 *  returning `HttpResult[T]`) beside the variants the handler body constructs
 *  (`Created`), so a constructed 2xx variant is preferred to the declared one;
 *  or why there is none to write (several, or a body a case cannot match). */
export function successLine(route: Pick<PromoteRoute, "responses">, binding: string): { line: string; variant: string } | { why: string } {
  if (!route.responses) return { why: "the language server did not give the route's responses" };
  const ok = route.responses.filter((r) => r.status >= 200 && r.status < 300);
  if (ok.length === 0) return { why: "the route declares no success response" };
  const constructed = ok.filter((r) => r.origin.kind === "Constructed");
  const names = [...new Set((constructed.length > 0 ? constructed : ok).map((r) => r.variant))];
  if (names.length > 1) return { why: `the route's success is ${names.join(" or ")}; naming one would be a guess` };
  const v = names[0];
  const info = HTTP_VARIANTS[v];
  if (!info || info.payload === "tuple") return { why: `the route's success (${v}) has no body a case can match` };
  return { variant: v, line: `expect ${binding} is ${v}${info.payload === "none" ? "" : "(_)"}` };
}

// ---------------------------------------------------------------------------
// The notebook

/** What the real constructor said of one candidate. */
export interface Verdict {
  candidate: EdgeCandidate;
  outcome: "accepted" | "refused";
  /** The refusal's message, from the `ValidationError`. */
  message?: string;
}

export interface TypeVerdicts {
  type: string;
  verdicts: Verdict[];
}

/** A candidate's source text as the value it stands for: a string's characters or a number. */
export function candidateValue(text: string): string | number {
  return text.startsWith('"') ? (JSON.parse(text) as string) : Number(text);
}

/** The explorer's examples tried beside the generated candidates, only to find a
 *  value the type accepts when no candidate is one: they get no case. Those that
 *  repeat a candidate, or that cannot be written as a literal, are left out. */
export function probesFor(model: Pick<RefinedModel, "base" | "examples">, candidates: readonly EdgeCandidate[], limit = 5): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  for (const e of model.examples.slice(0, limit)) {
    const c = model.base === "String" ? stringCandidate(e, "an example") : model.base === "Int" ? intCandidate(Number(e), "an example") : undefined;
    if (c && !candidates.some((x) => x.text === c.text)) out.push(c);
  }
  return out;
}

/** The numbered name of a file when `name` is taken: `a.bynknb`, `a-2.bynknb`, `a-3.bynknb`, … */
export function numberedName(name: string, n: number): string {
  return n <= 1 ? name : name.replace(/(\.[^.]+)$/, `-${n}$1`);
}

/** A value of the type the constructor accepted: what the other fields are held at. */
export function validSample(verdicts: readonly Verdict[]): string | number | undefined {
  const ok = verdicts.find((x) => x.outcome === "accepted");
  if (!ok) return undefined;
  return candidateValue(ok.candidate.text);
}

export interface EdgeCaseCell {
  field: RefinedField;
  verdict: Verdict;
}

/** The cells in the order they appear: each refined field, each of its type's candidates. */
export function edgeCaseCells(fields: readonly RefinedField[], byType: ReadonlyMap<string, TypeVerdicts>): EdgeCaseCell[] {
  const cells: EdgeCaseCell[] = [];
  for (const field of fields) for (const verdict of byType.get(field.type)?.verdicts ?? []) cells.push({ field, verdict });
  return cells;
}

export interface BuildInput {
  unit: string;
  /** `POST /discounts`. */
  route: string;
  /** The call for a cell: the field's candidate in place, the rest valid. `undefined` when it cannot be written. */
  call(field: RefinedField, text: string): string | undefined;
  /** The `expect` for a route's success, or why there is none. */
  success: { line: (binding: string) => string } | { why: string };
  fields: readonly RefinedField[];
  byType: ReadonlyMap<string, TypeVerdicts>;
  leftOut: readonly string[];
  /** The scenario written beside it for the refused values, if any. */
  scenario?: string;
}

const BINDING = "response";

/** The notebook: an introduction, then a heading and a cell per candidate. */
export function buildNotebook(input: BuildInput): { notebook: Notebook; cases: number; accepted: number; refused: number } {
  const cells: NbCell[] = [];
  const all = edgeCaseCells(input.fields, input.byType);
  const accepted = all.filter((c) => c.verdict.outcome === "accepted").length;
  const refused = all.length - accepted;
  // Kept short: the Markdown directly above the first case becomes its doc
  // comment when the notebook is promoted (#212).
  const intro = [
    `# Edge cases: ${input.route}`,
    "",
    `Boundary values for the route's refined fields, one case each, the other fields held at a valid value so a failure names one field. Whether a value is accepted was asked of the compiler (\`Type.of(…)\`), not read from the predicate. A refused value cannot be passed to a typed call, so its refusal is asserted on the constructor; the route's own refusal (\`Wire(…)\`) is for a \`system\` suite${input.scenario ? `, and is sent raw by \`${input.scenario}\` against \`bynk dev\`` : ""}.`,
  ];
  if ("why" in input.success) intro.push("", `The handler's answer is not asserted: ${input.success.why}.`);
  if (input.leftOut.length > 0) intro.push("", "Left out:", ...input.leftOut.map((l) => `- ${l}`));
  cells.push({ kind: "markdown", source: intro.join("\n") });

  for (const { field, verdict } of all) {
    const text = verdict.candidate.text;
    const heading = `${input.route}: ${field.label} = ${verdict.candidate.shown} (${verdict.outcome === "accepted" ? "accepted" : "refused"})`;
    const why = verdict.candidate.why;
    if (verdict.outcome === "accepted") {
      const call = input.call(field, text);
      if (!call) continue;
      cells.push({ kind: "markdown", source: `## ${heading}\n\n${field.type}: ${why}. The compiler accepts it, so the handler runs.` });
      const lines = ["// @handler", `let ${BINDING} <- ${call}`];
      if (!("why" in input.success)) lines.push(input.success.line(BINDING));
      cells.push({ kind: "code", source: lines.join("\n") });
    } else {
      cells.push({ kind: "markdown", source: `## ${heading}\n\n${field.type}: ${why}. The compiler refuses it${verdict.message ? ` (${verdict.message})` : ""}, so the route cannot take it.` });
      cells.push({ kind: "code", source: `expect ${field.type}.of(${text}) is Err(_)\n${field.type}.of(${text})` });
    }
  }
  return { notebook: { unit: input.unit, cells }, cases: all.length, accepted, refused };
}

/** A file name for the notebook: `edge-cases-POST-discounts.bynknb`. */
export function notebookFileName(method: string, path: string): string {
  const slug = path
    .split("/")
    .filter((s) => s !== "")
    .map((s) => s.replace(/^:/, "by-").replace(/[^A-Za-z0-9_-]/g, "-"))
    .join("-");
  return `edge-cases-${method}${slug ? `-${slug}` : ""}.bynknb`;
}

// ---------------------------------------------------------------------------
// The scenario: the route's own refusal

/** The status a refined violation gets at the HTTP boundary: a `400`
 *  `RefinementViolation` before the handler runs (the Bynk Book, http.md and
 *  encoding.md, v0.639.1). Documented, not observed here: the scenario is the
 *  one place the route's own refusal can be written, and it runs against
 *  `bynk dev`. */
export const BOUNDARY_STATUS = 400;

export interface ScenarioInput {
  unit: string;
  route: Pick<PromoteRoute, "method" | "path" | "model">;
  fields: readonly RefinedField[];
  byType: ReadonlyMap<string, TypeVerdicts>;
  valid: ReadonlyMap<string, string | number>;
  /** The actor the route needs a credential for: its header is the `AUTHORIZATION` variable. `undefined` for a Visitor. */
  credentialed: boolean;
}

const NO_BODY = new Set(["headers", "query", "cookies"]);

/** A `.bynk-http` scenario with a step for each REFUSED value, sending it raw
 *  (JSON bypasses the type) and expecting the boundary's `400`. Accepted values
 *  are the notebook's. `undefined` when no step can be written; what was left
 *  out is listed. */
export function buildScenario(input: ScenarioInput): { text: string; steps: number; leftOut: string[] } | undefined {
  const { route } = input;
  const env = route.model.envelope;
  const params = env.kind === "Keyed" ? env.params : env.kind === "Bare" ? [{ name: env.param, shape: env.shape }] : [];
  if (env.kind === "Raw") return undefined;
  const pattern = new Set(route.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)));
  const bodyParams = params.filter((p) => !pattern.has(p.name) && !NO_BODY.has(p.name));
  const bodyParam = bodyParams.length === 1 && route.method !== "GET" ? bodyParams[0] : undefined;
  const leftOut: string[] = [];
  const steps: string[] = [];
  const names = new Set<string>();
  // Every path parameter at a valid value, and the body at a sample.
  const pathValue = (name: string): string | undefined => {
    const p = params.find((x) => x.name === name);
    if (!p) return undefined;
    const s = sampleJson(route.model, p.shape, input.valid);
    return "value" in s && (typeof s.value === "string" || typeof s.value === "number") ? String(s.value) : undefined;
  };
  for (const field of input.fields) {
    const inPath = pattern.has(field.param);
    if (!inPath && field.param !== bodyParam?.name) {
      leftOut.push(`\`${field.label}\`: only a path parameter or the one body is sent raw`);
      continue;
    }
    for (const { candidate, outcome } of input.byType.get(field.type)?.verdicts ?? []) {
      if (outcome !== "refused") continue;
      const value = candidateValue(candidate.text);
      let path = route.path;
      let body: string | undefined;
      let missing = false;
      for (const name of pattern) {
        const v = name === field.param ? String(value) : pathValue(name);
        if (v === undefined || v === "") missing = true;
        else path = path.replace(`:${name}`, encodeURIComponent(v));
      }
      if (missing) {
        leftOut.push(`\`${field.label}\` = ${candidate.shown}: it cannot be a path segment`);
        continue;
      }
      if (bodyParam) {
        const sample = sampleJson(route.model, bodyParam.shape, input.valid);
        if ("why" in sample) {
          leftOut.push(`\`${field.label}\`: ${sample.why}`);
          continue;
        }
        body = JSON.stringify(field.param === bodyParam.name ? setAt(sample.value, field.path, value) : sample.value);
      }
      let name = `${field.label.replace(/[^A-Za-z0-9_]/g, "_")}_refused`;
      for (let n = 2; names.has(name); n++) name = `${field.label.replace(/[^A-Za-z0-9_]/g, "_")}_refused_${n}`;
      names.add(name);
      const headers = [body !== undefined ? "Content-Type: application/json" : "", input.credentialed ? "Authorization: Bearer token" : ""].filter((h) => h !== "").join("\n");
      steps.push(formatStep({ unit: input.unit, method: route.method, path, headers, body, status: BOUNDARY_STATUS }, name, input.unit).text);
    }
  }
  if (steps.length === 0) return undefined;
  return { text: `@context ${input.unit}\n\n${steps.join("\n")}`, steps: steps.length, leftOut };
}

/** A file name for the scenario: `edge-cases-POST-discounts.bynk-http`. */
export function scenarioFileName(method: string, path: string): string {
  return notebookFileName(method, path).replace(/\.bynknb$/, ".bynk-http");
}
