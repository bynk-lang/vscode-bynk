// #158: promote a request scenario (`.bynk-http`) to a `system`-tier test suite.
// A dependency-free companion to `scenarioCore.ts` (no `vscode` import), so the
// unit tests compile against it directly.
//
// What a `system` case can express (bynk v0.614.0, testing.md):
//   - a call: `api.PUT("/items/:id", "abc", Item { name: "x", qty: 2 }) by Visitor`,
//     the path being the route PATTERN and the arguments typed values, not JSON;
//   - the outcome, typed by the handler: `let Created(item) <- … else { … }` binds
//     the payload of a variant, which is how a value is carried between calls;
//   - a status, only as the variant that carries it (`Created`, `NotFound`, …);
//   - credentials as the case's `by <Actor>`, never a header (a literal
//     `Authorization` is refused on purpose);
//   - extra request headers as a trailing `RequestHeaders.of([...])`;
//   - NOT response headers (`HttpResult` has only `withCookie`, `clearCookie` and
//     `cookies()`), apart from a redirect's `Location`, which is the payload of
//     `Found(url)` and its kin.
//
// Everything a scenario says that this cannot express is listed, never dropped
// silently, and a step that cannot be a call is left out with the steps that read
// it. The suite is a one-way copy.

import {
  checkResponsePath,
  fieldKind,
  findRefs,
  parseRef,
  stepDependencies,
  type Resolved,
  type Scenario,
  type Step,
  type Expectation,
  type PathSeg,
  type HandlerInfo,
  type RouteInfo,
} from "./scenarioCore";
import type { WcRef } from "./webview/wireContractTypes";

// ---------------------------------------------------------------------------
// The HttpResult vocabulary (bynk-syntax/src/ast.rs, `HTTP_VARIANTS`)

type Payload = "none" | "value" | "message" | "location" | "tuple";

/** Each variant, its status and what it carries. A tuple payload (`Raw`,
 *  `Streaming`, …) is something a scenario cannot name. */
export const HTTP_VARIANTS: Readonly<Record<string, { status: number; payload: Payload }>> = {
  Ok: { status: 200, payload: "value" },
  Streaming: { status: 200, payload: "tuple" },
  Raw: { status: 200, payload: "tuple" },
  RawTagged: { status: 200, payload: "tuple" },
  RawStreamed: { status: 200, payload: "tuple" },
  RawCreated: { status: 201, payload: "tuple" },
  Created: { status: 201, payload: "value" },
  Accepted: { status: 202, payload: "value" },
  NoContent: { status: 204, payload: "none" },
  MovedPermanently: { status: 301, payload: "location" },
  Found: { status: 302, payload: "location" },
  SeeOther: { status: 303, payload: "location" },
  TemporaryRedirect: { status: 307, payload: "location" },
  PermanentRedirect: { status: 308, payload: "location" },
  BadRequest: { status: 400, payload: "message" },
  Unauthorized: { status: 401, payload: "none" },
  Forbidden: { status: 403, payload: "none" },
  NotFound: { status: 404, payload: "none" },
  MethodNotAllowed: { status: 405, payload: "none" },
  NotAcceptable: { status: 406, payload: "none" },
  RequestTimeout: { status: 408, payload: "none" },
  Conflict: { status: 409, payload: "message" },
  Gone: { status: 410, payload: "none" },
  LengthRequired: { status: 411, payload: "none" },
  PayloadTooLarge: { status: 413, payload: "message" },
  UnsupportedMediaType: { status: 415, payload: "message" },
  UnprocessableEntity: { status: 422, payload: "message" },
  TooManyRequests: { status: 429, payload: "message" },
  UnavailableForLegalReasons: { status: 451, payload: "message" },
  ServerError: { status: 500, payload: "message" },
  NotImplemented: { status: 501, payload: "message" },
  BadGateway: { status: 502, payload: "message" },
  ServiceUnavailable: { status: 503, payload: "message" },
  GatewayTimeout: { status: 504, payload: "message" },
};

// ---------------------------------------------------------------------------
// Inputs and outputs

/** A route as promotion needs it: `RouteInfo`, plus what the handler's
 *  contract and header say. */
export type PromoteRoute = RouteInfo;

export interface PromoteOptions {
  /** What names the case and the header comment: the scenario file's name. */
  name: string;
  /** `by …` clause text for a step (`Visitor`, `User("ada")`), or none. The
   *  host decides it, since a credential is an actor and the actor is a
   *  choice. */
  actorFor(step: Step, route: PromoteRoute): string | undefined;
  /** The one-line statement of that choice, for the summary and the header. */
  actorRule: string;
}

/** One thing a scenario said that the suite does not. */
export interface Unsupported {
  step: string;
  /** Zero-based line in the scenario. */
  line: number;
  /** What was said, as written. */
  what: string;
  why: string;
}

export interface Promoted {
  ok: true;
  /** The unit the suite targets. */
  unit: string;
  text: string;
  /** Steps in the scenario, and how many became calls. */
  steps: number;
  generated: number;
  /** Expectations in the scenario, and how many became assertions. */
  expectations: number;
  expressed: number;
  unsupported: Unsupported[];
  runsAs: string;
}

export interface Refused {
  ok: false;
  reason: string;
  unsupported: Unsupported[];
}

export type PromoteResult = Promoted | Refused;

// ---------------------------------------------------------------------------
// Literals

type Lit = { text: string } | { why: string };

const PLACEHOLDER = /^__bynk_capture_(\d+)__$/;

/** Everything the typed literals need to know about the route. */
interface LitEnv {
  types: PromoteRoute["model"]["types"];
  instantiations: PromoteRoute["model"]["instantiations"];
  /** A capture, as the expression that reads it. */
  captures: readonly string[];
  /** Turn a quoted string with `{{…}}` in it into an interpolation. */
  interpolate(text: string): Lit;
  /** A value known to satisfy a refined type (#229), by the type's name: what
   *  `sampleOf` writes for it in place of its base type's placeholder, which a
   *  predicate may refuse. */
  valid?: ReadonlyMap<string, string | number>;
}

const quote = (s: string): string => JSON.stringify(s);

function hasControl(s: string): boolean {
  return /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s);
}

function stringLit(s: string): Lit {
  return hasControl(s) ? { why: "a string with a control character" } : { text: quote(s) };
}

/** A JSON value as a Bynk value of wire type `ref`. */
export function literal(value: unknown, ref: WcRef, env: LitEnv): Lit {
  if (typeof value === "string") {
    const m = PLACEHOLDER.exec(value);
    if (m) return { text: env.captures[Number(m[1])] };
    if (findRefs(value).length > 0) return env.interpolate(value);
  }
  switch (ref.kind) {
    case "Base":
      return baseLit(value, ref.base);
    case "Named":
      return namedLit(value, ref.name, env);
    case "Inst": {
      const inst = env.instantiations.find((i) => i.key === ref.key);
      if (inst?.kind === "ListInst") {
        if (!Array.isArray(value)) return { why: "a list needs a JSON array" };
        const items: string[] = [];
        for (const v of value) {
          const l = literal(v, inst.elem, env);
          if ("why" in l) return l;
          items.push(l.text);
        }
        return { text: `[${items.join(", ")}]` };
      }
      if (inst?.kind === "OptionInst") {
        const o = value as { kind?: unknown; value?: unknown } | null;
        if (o && o.kind === "None") return { text: "None" };
        if (o && o.kind === "Some") {
          const l = literal(o.value, inst.inner, env);
          return "why" in l ? l : { text: `Some(${l.text})` };
        }
        return { why: "an option needs {\"kind\": \"Some\"|\"None\"}" };
      }
      return { why: "a map, a result or a generic type has no literal here" };
    }
    default:
      return { why: "this value has no literal form" };
  }
}

function baseLit(value: unknown, base: string): Lit {
  switch (base) {
    case "String":
      return typeof value === "string" ? stringLit(value) : { why: "a string was expected" };
    case "Int":
      return typeof value === "number" && Number.isInteger(value) ? { text: String(value) } : { why: "an integer was expected" };
    case "Float":
      return typeof value === "number" ? { text: Number.isInteger(value) ? `${value}.0` : String(value) } : { why: "a number was expected" };
    case "Bool":
      return typeof value === "boolean" ? { text: String(value) } : { why: "a boolean was expected" };
    default:
      return { why: `a ${base} has no literal here` };
  }
}

function namedLit(value: unknown, name: string, env: LitEnv): Lit {
  const type = env.types.find((t) => t.name === name);
  if (!type) return { why: `the type ${name} is not in the contract` };
  const body = type.body;
  if (body.kind === "Scalar") {
    const base = baseLit(value, body.base);
    if ("why" in base) return base;
    // An opaque type has only `.unsafe`; a refined one takes the literal, which
    // the compiler admits against its predicates.
    return { text: body.opaque ? `${name}.unsafe(${base.text})` : base.text };
  }
  if (body.kind === "Record") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { why: `${name} needs a JSON object` };
    const obj = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const f of body.fields) {
      if (!(f.name in obj)) {
        if (f.default === null) return { why: `${name} needs "${f.name}"` };
        continue;
      }
      const l = literal(obj[f.name], f.shape, env);
      if ("why" in l) return { why: `${name}.${f.name}: ${l.why}` };
      fields.push(`${f.name}: ${l.text}`);
    }
    return { text: `${name} { ${fields.join(", ")} }` };
  }
  return { why: `${name} is a sum type, which has no literal here` };
}

// ---------------------------------------------------------------------------
// Captures

/** What a step's response can offer a later one. */
interface Offer {
  /** The variable the payload is bound to, or undefined when not bound. */
  variable?: string;
  payload: Payload;
}

function esc(s: string): string {
  return quote(s).slice(1, -1);
}

/** The expression for a body path under a payload variable: `item.a.b`. A
 *  numeric segment (a list index) has no spelling here. */
function pathExpr(variable: string, path: readonly PathSeg[]): string | undefined {
  let out = variable;
  for (const seg of path) {
    if (typeof seg !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)) return undefined;
    out += `.${seg}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The suite

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Made {
  lines: string[];
  offer: Offer;
  expressed: number;
}

/** Turn `scenario`, whose steps are resolved to `resolved`, into a `system`
 *  suite. Refuses when no step can be a call, or when the steps span contexts
 *  (a suite targets one). */
export function promote(scenario: Scenario, resolved: readonly (Resolved | undefined)[], opts: PromoteOptions): PromoteResult {
  const unsupported: Unsupported[] = [];
  const steps = scenario.steps;
  const total = steps.reduce((n, s) => n + s.expects.length, 0);
  const note = (s: Step, line: number, what: string, why: string): void => {
    unsupported.push({ step: s.name, line, what, why });
  };

  // Every step needs its route, and the routes one context.
  const routes: (PromoteRoute | undefined)[] = steps.map((s, i) => {
    const r = resolved[i];
    if (!r) return undefined;
    if ("error" in r) {
      note(s, s.requestLine, `${s.method} ${s.path}`, r.error);
      return undefined;
    }
    return r.route as PromoteRoute;
  });
  const units = [...new Set(routes.filter((r): r is PromoteRoute => !!r).map((r) => r.unit))];
  if (units.length === 0) return { ok: false, reason: "No step resolves to a route, so there is nothing to call.", unsupported };
  if (units.length > 1) {
    return {
      ok: false,
      reason: `A system suite targets one context, and this scenario spans ${units.join(" and ")}. Split it into one scenario per context.`,
      unsupported,
    };
  }
  const unit = units[0];

  // The steps whose answer a later step reads.
  const readLater = new Set(steps.flatMap((s) => stepDependencies(s)));
  const offers = new Map<string, Offer>();
  const skipped = new Set<string>();
  const body: string[] = [];
  let expressed = 0;
  let generated = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const route = routes[i];
    const blockedBy = stepDependencies(step).find((d) => skipped.has(d));
    if (blockedBy) {
      skipped.add(step.name);
      note(step, step.requestLine, `${step.method} ${step.path}`, `reads \`${blockedBy}\`, which is not in the suite`);
      continue;
    }
    if (!route) {
      skipped.add(step.name);
      continue;
    }
    const made = makeStep(step, route, offers, opts, readLater.has(step.name), (line, what, why) => note(step, line, what, why));
    if ("skip" in made) {
      skipped.add(step.name);
      note(step, step.requestLine, `${step.method} ${step.path}`, made.skip);
      continue;
    }
    generated++;
    expressed += made.expressed;
    offers.set(step.name, made.offer);
    body.push(...made.lines);
  }

  if (generated === 0) return { ok: false, reason: "No step could be written as a call.", unsupported };

  const head = [
    `// Promoted from ${opts.name} by Bynk: Promote Scenario to Test Suite.`,
    "// A one-way copy: edits here are not carried back to the scenario, and the scenario",
    "// is not regenerated from this suite.",
    `// ${opts.actorRule}`,
  ];
  if (unsupported.length > 0 || expressed < total) {
    head.push("//", `// Not expressed (${total - expressed} of ${total} expectation${total === 1 ? "" : "s"}, ${steps.length - generated} of ${steps.length} step${steps.length === 1 ? "" : "s"} left out):`);
    for (const u of unsupported) head.push(`//   - ${u.step} (line ${u.line + 1}): ${oneLine(u.what)}: ${oneLine(u.why)}`);
  }
  const caseName = opts.name.replace(/^.*[\\/]/, "").replace(/\.bynk-http$/, "");
  const text = [
    ...head,
    `suite ${unit} as system {`,
    `\tcase ${quote(caseName)} {`,
    ...body.slice(0, body.at(-1) === "" ? -1 : undefined).map((l) => (l === "" ? "" : `\t\t${l}`)),
    "\t}",
    "}",
    "",
  ].join("\n");
  return { ok: true, unit, text, steps: steps.length, generated, expectations: total, expressed, unsupported, runsAs: opts.actorRule };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The step as a call and its assertions, or why it cannot be one. */
function makeStep(
  step: Step,
  route: PromoteRoute,
  offers: ReadonlyMap<string, Offer>,
  opts: PromoteOptions,
  readLater: boolean,
  report: (line: number, what: string, why: string) => void,
): Made | { skip: string } {
  if (!route.service) return { skip: "the language server did not name the service that serves it" };
  if (!IDENT.test(step.name)) return { skip: "its name is not an identifier" };
  const env = route.model.envelope;
  if (env.kind === "Raw") return { skip: `it sends a raw ${env.contentType} body, which a suite cannot spell as JSON` };
  const params = env.kind === "Keyed" ? env.params : env.kind === "Bare" ? [{ name: env.param, shape: env.shape }] : [];

  // Captures a request mentions: each becomes the expression that reads it.
  const captureExprs: string[] = [];
  const captureOf = (ref: string): Lit => {
    const p = parseRef(ref);
    if ("error" in p) return { why: p.error };
    if (p.kind === "env") return { why: "an environment value is never written into a suite (credentials are the case's `by` actor)" };
    if (p.kind === "status") return { why: "a status can't be read as a value, only matched as a variant" };
    const offer = offers.get(p.step);
    if (!offer) return { why: `\`${p.step}\` is not in the suite` };
    if (p.kind === "header") {
      if (p.name.toLowerCase() === "location" && offer.payload === "location" && offer.variable) return { text: offer.variable };
      return { why: `a ${p.name} header can't be read; only a redirect's Location is, as its payload` };
    }
    if (offer.payload !== "value" && offer.payload !== "message") return { why: `\`${p.step}\`'s answer carries no body` };
    if (!offer.variable) return { why: `\`${p.step}\` did not bind its response` };
    if (offer.payload === "message") return p.path.length === 1 && p.path[0] === "error" ? { text: offer.variable } : { why: "an error message carries only `error`" };
    const e = pathExpr(offer.variable, p.path);
    return e ? { text: e } : { why: "a list index has no spelling in a case" };
  };
  const interpolate = (text: string): Lit => {
    let out = "";
    let at = 0;
    for (const r of findRefs(text)) {
      out += esc(text.slice(at, r.start));
      at = r.end;
      const c = captureOf(r.text);
      if ("why" in c) return c;
      out += `\\(${c.text})`;
    }
    out += esc(text.slice(at));
    return hasControl(text) ? { why: "a string with a control character" } : { text: `"${out}"` };
  };
  const litEnv: LitEnv = { types: route.model.types, instantiations: route.model.instantiations, captures: captureExprs, interpolate };

  // Path parameters, from the route pattern against the path as written.
  const [pathOnly, query] = splitQuery(step.path);
  if (query !== undefined) return { skip: "it sends a query string, which a suite passes as a typed `query` value" };
  const pattern = route.path.split("/");
  const given = pathOnly.split("/");
  const pathValues = new Map<string, string>();
  pattern.forEach((seg, k) => {
    if (seg.startsWith(":")) pathValues.set(seg.slice(1), given[k] ?? "");
  });

  const args: string[] = [quote(route.path)];
  const headersParam = params.find((p) => p.name === "headers");
  const extra: string[] = [];
  for (const h of step.headers) {
    const lower = h.name.toLowerCase();
    if (lower === "content-type") continue;
    if (/^(authorization|proxy-authorization|cookie)$/.test(lower) || /(token|secret|api-?key|password|auth)/.test(lower)) {
      continue;
    }
    if (findRefs(h.value).some((r) => r.text.startsWith("env."))) return { skip: `the ${h.name} header reads the environment, which a suite never does` };
    const v = findRefs(h.value).length > 0 ? interpolate(h.value) : { text: quote(h.value) };
    if ("why" in v) return { skip: `the ${h.name} header: ${v.why}` };
    // `RequestHeaders.of` takes "name: value" lines.
    extra.push(findRefs(h.value).length > 0 ? `"${esc(`${h.name}: `)}${v.text.slice(1)}` : quote(`${h.name}: ${h.value}`));
  }

  let sentBody = false;
  for (const p of params) {
    if (pathValues.has(p.name)) {
      const raw = pathValues.get(p.name) ?? "";
      const refs = findRefs(raw);
      let l: Lit;
      if (refs.length === 1 && refs[0].start === 0 && refs[0].end === raw.length) {
        l = captureOf(refs[0].text);
      } else if (refs.length > 0) {
        l = interpolate(raw);
      } else {
        l = literal(coerce(raw, p.shape, litEnv), p.shape, litEnv);
      }
      if ("why" in l) return { skip: `the path parameter \`${p.name}\`: ${l.why}` };
      args.push(l.text);
    } else if (p.name === "body") {
      if (!step.body) return { skip: "the route takes a body and the step sends none" };
      const parsed = parseBody(step.body.text, captureExprs.length);
      if ("error" in parsed) return { skip: `the body: ${parsed.error}` };
      const holders: string[] = [];
      for (const r of parsed.refs) {
        const c = captureOf(r);
        if ("why" in c) return { skip: `the body: ${c.why}` };
        holders.push(c.text);
      }
      captureExprs.push(...holders);
      const l = literal(parsed.value, p.shape, litEnv);
      if ("why" in l) return { skip: `the body: ${l.why}` };
      args.push(l.text);
      sentBody = true;
    } else if (p.name === "headers") {
      args.push(`RequestHeaders.of([${extra.join(", ")}])`);
    } else {
      return { skip: `the route's \`${p.name}\` parameter has no counterpart in a request line` };
    }
  }
  if (step.body && !sentBody) return { skip: "the step sends a body the route does not take" };
  if (!headersParam && extra.length > 0) args.push(`RequestHeaders.of([${extra.join(", ")}])`);

  // The outcome: the variant a status expectation names, else the declared
  // success; its payload is bound when something reads it.
  const status = step.expects.find((e) => e.subject.kind === "status" && e.op === "==");
  const variantPick = status ? variantFor(route, Number(status.value)) : undefined;
  if (status && variantPick && "why" in variantPick) report(status.line, `? status == ${String(status.value)}`, variantPick.why);
  const variant = variantPick && "name" in variantPick ? variantPick.name : status ? undefined : "Ok";
  const info = variant ? HTTP_VARIANTS[variant] : undefined;
  const payload: Payload = info ? info.payload : "none";

  const lines: string[] = [`// ${step.name}: ${step.method} ${step.path}`];
  const asActor = opts.actorFor(step, route);
  const by = asActor ? ` by ${asActor}` : "";
  const call = `${route.service}.${step.method}(${args.join(", ")})${by}`;

  const variable = `v_${step.name}`;
  let expressed = 0;
  const checks: string[] = [];
  let needsPayload = false;
  for (const e of step.expects) {
    // A status that named no variant was reported above.
    if (e === status && !variant) continue;
    const out = assertion(e, variable, variant, payload, status === e, route, status ? Number(status.value) : undefined);
    if ("why" in out) {
      report(e.line, describe(e), out.why);
      continue;
    }
    expressed++;
    if (out.payload) needsPayload = true;
    if (out.text) checks.push(out.text);
  }
  // A later step reads this one's payload through its capture expressions.
  const bindable = payload === "value" || payload === "message" || payload === "location";
  const bind = bindable && (needsPayload || readLater);

  // With no status expectation the declared success is only matched when its
  // payload is read: otherwise the step asserts nothing about the answer.
  if (!status && !bind) {
    lines.push(`let r_${step.name} <- ${call}`);
  } else if (variant && info && info.payload !== "tuple") {
    // A bare variant name is a binding, not a pattern: qualify it.
    const pattern = bind ? `${variant}(${variable})` : bindable ? `${variant}(_)` : `HttpResult.${variant}`;
    lines.push(`let ${pattern} <- ${call} else { expect false }`);
  } else if (variant && info) {
    return { skip: `it answers ${variant}, which carries a raw body` };
  } else {
    lines.push(`let r_${step.name} <- ${call}`);
  }
  lines.push(...checks);
  lines.push("");
  return { lines, offer: { variable: bind ? variable : undefined, payload }, expressed };
}

function describe(e: Expectation): string {
  const s = e.subject;
  const left = s.kind === "status" ? "status" : s.kind === "header" ? `header ${s.name}` : `body${s.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("")}`;
  const right = e.op === "exists" || e.op === "absent" ? "" : ` ${JSON.stringify(e.value)}`;
  return `? ${left} ${e.op}${right}`;
}

type Assertion = { text?: string; payload: boolean } | { why: string };

/** One expectation as an assertion on the bound outcome. */
function assertion(e: Expectation, variable: string, variant: string | undefined, payload: Payload, isStatus: boolean, route: PromoteRoute, status: number | undefined): Assertion {
  const s = e.subject;
  if (s.kind === "status") {
    // The status became the pattern of the `let`; it is the assertion.
    if (isStatus && variant) return { payload: false };
    return { why: e.op === "==" ? "no single HttpResult variant answers that status" : "only `status ==` has a variant to match" };
  }
  if (s.kind === "header") {
    if (s.name.toLowerCase() === "location" && payload === "location" && (e.op === "==" || e.op === "contains")) {
      const v = e.value;
      if (typeof v !== "string" || hasControl(v)) return { why: "a Location is compared with a string" };
      return { payload: true, text: e.op === "==" ? `expect ${variable} == ${quote(v)}` : `expect ${variable}.contains(${quote(v)})` };
    }
    return { why: s.name.toLowerCase() === "set-cookie" ? "only the names of the cookies a result sets are readable (`.cookies()`), not the header" : `a test cannot read a ${s.name} response header (HttpResult has only withCookie, clearCookie and cookies())` };
  }
  // A body expectation.
  if (payload === "none") return { why: "the answer carries no body" };
  if (payload === "location") return { why: "a redirect's answer is its Location, not a body" };
  // These need the field's type, which the contract carries for a value
  // response since bynk-lang/bynk#3609 (v0.633.4); an older server leaves them listed.
  if (e.op === "exists" || e.op === "absent" || e.op === "contains") return typedAssertion(e, s.path, variable, payload, route, status);
  const target = payload === "message" ? (s.path.length === 1 && s.path[0] === "error" ? variable : undefined) : pathExpr(variable, s.path);
  if (!target) return { why: "that path has no typed spelling (a list index, or a message's other fields)" };
  const v = e.value;
  const lit: string | undefined =
    typeof v === "string" ? (hasControl(v) ? undefined : quote(v)) : typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(v)) : typeof v === "boolean" ? String(v) : undefined;
  if (lit === undefined) return { why: "only a string, number or boolean can be compared without the field's type" };
  return { payload: true, text: `expect ${target} ${e.op === "==" ? "==" : "!="} ${lit}` };
}

/** `exists`, `absent` and `contains` on a body field, spelt by the field's type (#160). */
function typedAssertion(e: Expectation, path: readonly PathSeg[], variable: string, payload: Payload, route: PromoteRoute, status: number | undefined): Assertion {
  if (payload !== "value") return { why: "an error message carries only `error`, a String, and its presence is the variant" };
  const target = pathExpr(variable, path);
  if (!target) return { why: "that path has no typed spelling (a list index)" };
  const found = checkResponsePath(route, status, path);
  if (!found.ref) return { why: found.issue ? `${found.issue}, so there is nothing to assert` : `\`${e.op}\` has no typed spelling: the field's type is not in the contract` };
  // Only a path of record fields is read directly in a suite: a field of one sum
  // variant, or what is inside a `Some`, `Ok` or `Err`, is matched, not selected.
  if (!found.plain) return { why: "a field reached through a sum variant, an Option, a Result or a list can't be read directly in a suite" };
  const kind = fieldKind(found.ref, route.model);
  if (e.op === "contains") {
    const v = e.value;
    if (kind !== "string") return { why: "`contains` is spelt only for a String field (a list's `contains` is not)" };
    if (typeof v !== "string" || hasControl(v)) return { why: "`contains` takes a string" };
    return { payload: true, text: `expect ${target}.contains(${quote(v)})` };
  }
  if (kind === "option") return { why: "an Option field is `Some` or `None` in a suite, which a body's `exists` does not tell apart" };
  if (kind !== "required" && kind !== "string") return { why: `\`${e.op}\` has no typed spelling: the field's type is not in the contract` };
  // A field the type requires is always there, so `exists` holds by the type
  // and `absent` can never hold.
  if (e.op === "absent") return { why: "the field is required by its type, so it is never absent" };
  return { text: `// ${describe(e)}: ${target} is required by its type`, payload: false };
}

/** The variant a route answers with for `status`, or why none can be chosen. */
export function variantFor(route: PromoteRoute, status: number): { name: string } | { why: string } {
  const answers = (route.responses ?? []).filter((r) => r.status === status);
  if (!route.responses) return { why: "the language server did not give the route's responses" };
  if (answers.length === 0) return { why: `the route does not answer ${status}` };
  const named = answers.filter((r) => r.variant in HTTP_VARIANTS && r.origin.kind !== "BoundaryImplicit");
  if (named.length === 0) return { why: `${status} is the boundary's own rejection (${answers[0].variant}), which a suite matches as an HttpOutcome, not a variant` };
  const declared = named.filter((r) => r.origin.kind === "DeclaredSuccess");
  const pick = declared.length === 1 ? declared : named;
  const names = [...new Set(pick.map((r) => r.variant))];
  if (names.length > 1) return { why: `${status} is answered by ${names.join(" and ")}; naming one would be a guess` };
  return { name: names[0] };
}

function splitQuery(path: string): [string, string | undefined] {
  const i = path.indexOf("?");
  return i < 0 ? [path, undefined] : [path.slice(0, i), path.slice(i + 1)];
}

/** A path segment as the JSON value for its parameter's type. */
function coerce(raw: string, ref: WcRef, env: LitEnv): unknown {
  const base = ref.kind === "Base" ? ref.base : ref.kind === "Named" ? scalarBase(ref.name, env) : undefined;
  if (base === "Int" && /^-?\d+$/.test(raw)) return Number(raw);
  if (base === "Bool" && (raw === "true" || raw === "false")) return raw === "true";
  return raw;
}

function scalarBase(name: string, env: LitEnv): string | undefined {
  const t = env.types.find((x) => x.name === name);
  return t && t.body.kind === "Scalar" ? t.body.base : undefined;
}

/** A body's JSON with each unquoted `{{…}}` swapped for a placeholder string,
 *  numbered from `first`, and the references in order. */
function parseBody(text: string, first: number): { value: unknown; refs: string[] } | { error: string } {
  const refs: string[] = [];
  const masked = text.replace(/\{\{([^{}]*)\}\}/g, (m: string, inner: string, off: number, s: string) => {
    if (inString(s, off)) return m;
    refs.push(inner.trim());
    return `"__bynk_capture_${first + refs.length - 1}__"`;
  });
  try {
    return { value: JSON.parse(masked), refs };
  } catch (e) {
    return { error: `it isn't valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
}

function inString(src: string, offset: number): boolean {
  let inStr = false;
  for (let i = 0; i < offset; i++) {
    const c = src[i];
    if (c === "\\" && inStr) i++;
    else if (c === '"') inStr = !inStr;
  }
  return inStr;
}

// ---------------------------------------------------------------------------
// Telling the user

/** The summary shown before anything is written. */
export function summarise(p: Promoted): string {
  const lines = [
    `${p.generated} of ${p.steps} step${p.steps === 1 ? "" : "s"} became calls, and ${p.expressed} of ${p.expectations} expectation${p.expectations === 1 ? "" : "s"} became assertions.`,
    p.runsAs,
  ];
  if (p.unsupported.length > 0) {
    lines.push(`${p.unsupported.length} thing${p.unsupported.length === 1 ? "" : "s"} could not be expressed, and are listed at the top of the suite:`);
    for (const u of p.unsupported.slice(0, 8)) lines.push(`• ${u.step}: ${oneLine(u.what)} — ${oneLine(u.why)}`);
    if (p.unsupported.length > 8) lines.push(`• …and ${p.unsupported.length - 8} more`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// A typed call with placeholder arguments (#191)
//
// A notebook's handler cell starts from the same call a promoted scenario
// writes (`api.PUT("/items/:id", "abc", Item { … }) by Visitor`), with sample
// arguments of the right types instead of a scenario's values.

type Sample = { value: unknown } | { why: string };

/** A JSON value of wire type `ref`, for `literal` to write: a placeholder to
 *  edit, not a value that is meant. */
function sampleOf(ref: WcRef, env: LitEnv, depth = 0): Sample {
  if (depth > 4) return { why: "a type that nests too deeply to sample" };
  switch (ref.kind) {
    case "Base":
      switch (ref.base) {
        case "String":
          return { value: "sample" };
        case "Int":
          return { value: 1 };
        case "Float":
          return { value: 1.5 };
        case "Bool":
          return { value: true };
        default:
          return { why: `a ${ref.base} has no literal here` };
      }
    case "Named": {
      const known = env.valid?.get(ref.name);
      if (known !== undefined) return { value: known };
      const t = env.types.find((x) => x.name === ref.name);
      if (!t) return { why: `the type ${ref.name} is not in the contract` };
      if (t.body.kind === "Scalar") return sampleOf({ kind: "Base", base: t.body.base, json: t.body.json, guards: [], expected: { kind: "Json", json: t.body.json } }, env, depth + 1);
      if (t.body.kind === "Sum") return { why: `${ref.name} is a sum type, which has no literal here` };
      const obj: Record<string, unknown> = {};
      for (const f of t.body.fields) {
        if (f.default !== null) continue;
        const s = sampleOf(f.shape, env, depth + 1);
        if ("why" in s) return { why: `${ref.name}.${f.name}: ${s.why}` };
        obj[f.name] = s.value;
      }
      return { value: obj };
    }
    case "Inst": {
      const inst = env.instantiations.find((i) => i.key === ref.key);
      if (inst?.kind === "ListInst") {
        const e = sampleOf(inst.elem, env, depth + 1);
        return "why" in e ? e : { value: [e.value] };
      }
      if (inst?.kind === "OptionInst") return { value: { kind: "None" } };
      return { why: "a map, a result or a generic type has no literal here" };
    }
    default:
      return { why: "this value has no literal form" };
  }
}

/** How a written call departs from the plain sample (#229). */
export interface CallVariation {
  /** A value that satisfies each refined type, by name, in place of the placeholder. */
  valid?: ReadonlyMap<string, string | number>;
  /** Replace the value at `path` (record field names) inside parameter `param`. */
  set?: { param: string; path: readonly string[]; value: string | number };
}

export function setAt(value: unknown, path: readonly string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const o = value as Record<string, unknown>;
  return { ...o, [path[0]]: setAt(o[path[0]], path.slice(1), replacement) };
}

export interface WrittenCall {
  /** `api.POST("/todos", Todo { … }) by Visitor`, on one line. */
  text: string;
  /** Arguments that could not be sampled: each is written as a `_` with a comment saying why, for the user to fill in. */
  holes: string[];
}

type WireModel = PromoteRoute["model"];

/** A JSON sample of wire type `ref`, with `valid` values for refined types (#229): the raw body of a scenario step. */
export function sampleJson(model: Pick<WireModel, "types" | "instantiations">, ref: WcRef, valid?: ReadonlyMap<string, string | number>): { value: unknown } | { why: string } {
  return sampleOf(ref, { types: model.types, instantiations: model.instantiations, captures: [], interpolate: () => ({ why: "no captures here" }), valid });
}

/** A sample argument for each of a handler's parameters, as source; the ones
 *  that could not be sampled are written as `_` with a comment, and listed. */
function sampleArgs(model: WireModel, params: readonly { name: string; shape: WcRef }[], skip: (name: string) => boolean = () => false, vary?: CallVariation): { args: string[]; holes: string[] } {
  const litEnv: LitEnv = { types: model.types, instantiations: model.instantiations, captures: [], interpolate: () => ({ why: "no captures here" }), valid: vary?.valid };
  const holes: string[] = [];
  const args: string[] = [];
  for (const p of params) {
    if (skip(p.name)) continue;
    let s = sampleOf(p.shape, litEnv);
    if (vary?.set && vary.set.param === p.name && !("why" in s)) s = { value: setAt(s.value, vary.set.path, vary.set.value) };
    const l = "why" in s ? s : literal(s.value, p.shape, litEnv);
    if ("why" in l) {
      holes.push(`\`${p.name}\`: ${l.why}`);
      args.push(`_ /* ${p.name}: ${l.why.replace(/\*\//g, "* /")} */`);
    } else {
      args.push(l.text);
    }
  }
  return { args, holes };
}

const paramsOf = (env: WireModel["envelope"]): { name: string; shape: WcRef }[] => (env.kind === "Keyed" ? env.params : env.kind === "Bare" ? [{ name: env.param, shape: env.shape }] : []);

/** The call a case writes for `route`, with a sample argument for each of the
 *  handler's parameters and `by` as its actor clause (none when undefined).
 *  `undefined` when the route cannot be called from a case: no service named,
 *  or a raw body. */
export function writeCall(route: PromoteRoute, by: string | undefined, vary?: CallVariation): WrittenCall | undefined {
  if (!route.service) return undefined;
  const env = route.model.envelope;
  if (env.kind === "Raw") return undefined;
  const pattern = new Set(route.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)));
  const args: string[] = [quote(route.path)];
  const holes: string[] = [];
  for (const p of paramsOf(env)) {
    if (p.name === "headers" && !pattern.has("headers")) {
      args.push("RequestHeaders.of([])");
      continue;
    }
    const got = sampleArgs(route.model, [p], undefined, vary);
    args.push(...got.args);
    holes.push(...got.holes);
  }
  return { text: `${route.service}.${route.method}(${args.join(", ")})${by ? ` by ${by}` : ""}`, holes };
}

/** The unit-tier call for a handler that is not an HTTP route (#213), at the
 *  address its kind has (`testing.md`): `svc.call(args)`, `svc.schedule("<expr>"
 *  [, at])`, `svc.message(msg)`, `svc.event(e)`. An event is delivered with the
 *  default envelope: the handler's `env` parameter is left to the case's runner
 *  (`svc.event(e, env)` would need an `EventEnvelope` the cell may not have in
 *  scope). `undefined` for a WebSocket handler, a raw body or an envelope with
 *  no sample to write. */
export function writeHandlerCall(h: HandlerInfo, by: string | undefined): WrittenCall | undefined {
  const env = h.model.envelope;
  if (h.kind === "websocket" || env.kind === "Raw") return undefined;
  let params = paramsOf(env);
  let verb: string;
  const lead: string[] = [];
  switch (h.kind) {
    case "call":
      verb = "call";
      break;
    case "cron":
      if (h.expr === undefined) return undefined;
      verb = "schedule";
      lead.push(quote(h.expr));
      break;
    case "queue":
      verb = "message";
      break;
    case "event":
      verb = "event";
      params = params.slice(0, 1);
      break;
  }
  const got = sampleArgs(h.model, params);
  return { text: `${h.service}.${verb}(${[...lead, ...got.args].join(", ")})${by ? ` by ${by}` : ""}`, holes: got.holes };
}

/** The `by` clause text for an actor a route admits: `Visitor`, `User("sample")`
 *  for a `String` identity, `User(UserId.unsafe("sample"))` for any other. */
export function actorClause(actor: string, identityType: string | undefined): string {
  if (actor === "Visitor") return "Visitor";
  if (!identityType || identityType === "String") return `${actor}("sample")`;
  if (identityType === "Int") return `${actor}(1)`;
  return `${actor}(${identityType}.unsafe("sample"))`;
}
