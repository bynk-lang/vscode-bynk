// #154: classify the wire-contract (`bynk/wireContract`) difference between two
// revisions of a handler as compatible or breaking. Dependency-free.
//
// The server classifies only `on call` service contracts, and only against the
// ledger's live copy (`bynk_check::contract_compat::check_call`, #2485); it has
// no request that takes a second tree. So this mirrors that classifier's rules
// over the `WcModel` of each revision, which is what the extension has:
//
//   - compatibility is about values on the wire: a record is an object keyed by
//     field name, an unknown key is ignored, a missing `Option` field is `None`,
//     a bare value is accepted where an `Option` is expected;
//   - a request flows caller -> callee and a response callee -> caller, and in
//     both the receiver must decode everything the sender can produce, so one
//     `flows(sender, receiver)` is asked of the request (before -> after) and of
//     the response (after -> before): "add an optional request field" is
//     compatible and "add a response variant" breaking from one definition;
//   - it errs towards breaking: a wrong "compatible" lets a breaking change
//     through, a wrong "breaking" only names a difference to look at.
//
// The rules are those of `bynk-check/src/contract_compat.rs` at bynk v0.614.0:
// `flows(sender, receiver)` and `check_call` there, which `flows`, `fields` and
// `classifyWire` below mirror, and whose tests (`request_optional_field_added_is_compatible`,
// `request_defaulted_field_added_is_compatible`,
// `request_field_removed_is_compatible_because_the_callee_ignores_it`,
// `request_refinement_narrowed_is_breaking`,
// `response_variant_added_is_breaking_and_removed_is_compatible`,
// `response_field_added_is_compatible`, …) the unit tests in
// `test/suite/wireDiffCore.unit.test.ts` are named after. When that file's
// rules change, update the test it maps to here.
//
// The response side of an HTTP handler is the server's own: `bynk/wireContract`
// carries the handler's `success` type (bynk#3609, v0.633.4), each response's
// `payload` and, from v0.633.9 (bynk#3632), its `body` (a value, a message, a
// redirect, raw bytes or a stream). Each response the two revisions share is
// compared by that body, the later revision sending and the earlier caller
// receiving, so a type used on both sides is checked in both directions.
//
// Two kinds of handler have no response shape in the model:
//   - an `on call` handler has a response, but `success` is HTTP-only
//     (bynk-lang/bynk#3687 asks for it to be filled for `on call` too). Until
//     then `WcModel.types` holds the request's and the response's boundary
//     types together, so its response is inferred as the types and
//     instantiations the request does not reach, and a type used on both sides
//     is checked as a request only (`WIRE_NOTE` says so). Replace that with
//     `success` when #3687 lands;
//   - a cron, event, message or websocket handler has no response at all, so
//     only its request side is classified.

import type { DiffEntry } from "./modelDiffCore";
import type { WcEnvelope, WcField, WcHttpResponse, WcInst, WcModel, WcRef, WcResponseBody, WcType } from "./webview/wireContractTypes";

export const WIRE_NOTE =
  "Each handler's wire contract in the two revisions is classified as a caller built against the earlier revision would meet the later one, by the language server's own rules for service contracts: breaking unless every value the sender can produce still decodes. For an HTTP handler each shared response is compared by the body the server reports for it (a value's type, a message, a redirect, raw bytes or a stream), the later revision's body against the earlier caller's, and a response that is new is breaking. The server does not yet report an `on call` handler's response type (bynk-lang/bynk#3687), so that response is inferred from the boundary types the request does not reach, and a type used on both sides is checked as a request only. A cron, event, message or websocket handler has no response, so only its request side applies. Where unsure, it says breaking.";

/** A handler's contract in one revision, and the working-tree file it is in. */
export interface WireHandler {
  model: WcModel;
  /** The document the model's `range` is against. */
  uri: string;
}

export interface WireVerdict {
  verdict: "compatible" | "breaking";
  /** Why it is breaking, one line per difference; empty when compatible. */
  reasons: string[];
}

/** What a handler is known by across revisions: its service, and its route (an
 *  HTTP handler's method and path) or else its symbol's name. */
export function wireHandlerKey(model: WcModel, symbolName: string): string {
  const k = model.kind;
  const what = k.kind === "Http" ? `${k.method} ${k.path}` : symbolName;
  return `${model.unit}.${model.service}: ${what}`;
}

// ---------------------------------------------------------------- shapes

type Node =
  | { k: "base"; base: string; preds: string[]; guards: string[]; opaque: boolean }
  | { k: "unit" }
  | { k: "bytes" }
  | { k: "unchecked"; reason: string }
  | { k: "option"; inner: WcRef }
  | { k: "list"; elem: WcRef }
  | { k: "map"; key: WcRef; val: WcRef }
  | { k: "result"; ok: WcRef; err: WcRef }
  | { k: "record"; name: string; fields: Field[]; args: WcRef[] }
  | { k: "sum"; name: string; variants: Array<{ name: string; fields: Field[] }>; args: WcRef[] }
  | { k: "unknown"; name: string };

interface Field {
  name: string;
  shape: WcRef;
  defaulted: boolean;
}

const fieldOf = (f: WcField): Field => ({ name: f.name, shape: f.shape, defaulted: f.default !== null });

/** One revision's handler contract, indexed for lookups. */
class Side {
  readonly types = new Map<string, WcType>();
  readonly insts = new Map<string, WcInst>();
  constructor(readonly model: WcModel) {
    for (const t of model.types) this.types.set(t.name, t);
    for (const i of model.instantiations) this.insts.set(i.key, i);
  }

  node(ref: WcRef): Node {
    switch (ref.kind) {
      case "Base":
        return { k: "base", base: ref.base, preds: [], guards: ref.guards, opaque: false };
      case "Bytes":
        return { k: "bytes" };
      case "Unit":
        return { k: "unit" };
      case "Unchecked":
        return { k: "unchecked", reason: ref.reason };
      case "Named":
        return this.named(ref.name, []);
      case "Inst": {
        const i = this.insts.get(ref.key);
        if (!i) return { k: "unknown", name: ref.key };
        switch (i.kind) {
          case "OptionInst":
            return { k: "option", inner: i.inner };
          case "ListInst":
            return { k: "list", elem: i.elem };
          case "MapInst":
            return { k: "map", key: i.mapKey, val: i.val };
          case "ResultInst":
            return { k: "result", ok: i.ok, err: i.err };
          case "RecordInst":
          case "SumInst":
            return this.named(i.name, i.args);
        }
      }
    }
  }

  private named(name: string, args: WcRef[]): Node {
    const t = this.types.get(name);
    if (!t) return { k: "unknown", name };
    const b = t.body;
    if (b.kind === "Scalar") {
      return { k: "base", base: b.base, preds: b.predicates, guards: b.baseGuards, opaque: b.opaque };
    }
    if (b.kind === "Record") return { k: "record", name, fields: b.fields.map(fieldOf), args };
    return { k: "sum", name, variants: b.variants.map((v) => ({ name: v.name, fields: v.payload.map(fieldOf) })), args };
  }

  /** Every named type and instantiation reachable from `refs`. */
  closure(refs: WcRef[]): { types: Set<string>; insts: Set<string> } {
    const types = new Set<string>();
    const insts = new Set<string>();
    const visit = (ref: WcRef): void => {
      if (ref.kind === "Named") {
        if (types.has(ref.name)) return;
        types.add(ref.name);
        const b = this.types.get(ref.name)?.body;
        if (b?.kind === "Record") b.fields.forEach((f) => visit(f.shape));
        if (b?.kind === "Sum") b.variants.forEach((v) => v.payload.forEach((f) => visit(f.shape)));
      } else if (ref.kind === "Inst") {
        if (insts.has(ref.key)) return;
        insts.add(ref.key);
        const i = this.insts.get(ref.key);
        if (!i) return;
        switch (i.kind) {
          case "OptionInst": visit(i.inner); break;
          case "ListInst": visit(i.elem); break;
          case "MapInst": visit(i.mapKey); visit(i.val); break;
          case "ResultInst": visit(i.ok); visit(i.err); break;
          case "RecordInst":
          case "SumInst":
            if (!types.has(i.name)) visit({ kind: "Named", name: i.name });
            i.args.forEach(visit);
            break;
        }
      }
    };
    refs.forEach(visit);
    return { types, insts };
  }
}

// ---------------------------------------------------------------- flows

interface Ctx {
  sender: Side;
  receiver: Side;
  out: string[];
  /** Named pairs already being compared, so a recursive type ends. */
  seen: Set<string>;
}

const bad = (c: Ctx, path: string, why: string): void => {
  c.out.push(`${path}: ${why}`);
};

const describe = (n: Node): string =>
  n.k === "record" || n.k === "sum" ? `${n.k} ${n.name}` : n.k === "unknown" ? n.name : n.k === "base" ? n.base : n.k;

/** Can the receiver decode everything the sender can produce? Appends a line to
 *  `c.out` for each way it cannot. */
function flows(c: Ctx, s: WcRef, r: WcRef, path: string): void {
  const sn = c.sender.node(s);
  const rn = c.receiver.node(r);
  if (rn.k === "option") {
    // A bare value is accepted where an `Option` is expected.
    if (sn.k === "option") flows(c, sn.inner, rn.inner, path);
    else flows(c, s, rn.inner, path);
    return;
  }
  if (sn.k === "option") return bad(c, path, "it may now be absent, and the receiver requires a value");
  if (sn.k === "unknown" || rn.k === "unknown") {
    if (sn.k !== rn.k || describe(sn) !== describe(rn)) bad(c, path, `${describe(sn)} → ${describe(rn)}`);
    return;
  }
  if (sn.k !== rn.k) return bad(c, path, `${describe(sn)} → ${describe(rn)}`);
  switch (sn.k) {
    case "unit":
    case "bytes":
      return;
    case "unchecked":
      if (sn.reason !== (rn as typeof sn).reason) bad(c, path, "its checked form changed");
      return;
    case "base": {
      const b = rn as typeof sn;
      if (sn.base !== b.base) return bad(c, path, `${sn.base} → ${b.base}`);
      // A refinement the receiver now enforces and the sender does not: opaque
      // predicates are not re-validated, so are not compared.
      if (!sn.opaque && !b.opaque) {
        const unmet = b.preds.filter((p) => !sn.preds.includes(p));
        if (unmet.length > 0) bad(c, path, `now requires ${unmet.join(", ")}`);
      }
      const guards = b.guards.filter((g) => !sn.guards.includes(g));
      if (guards.length > 0) bad(c, path, `now requires ${guards.join(", ")}`);
      return;
    }
    case "list":
      return flows(c, sn.elem, (rn as typeof sn).elem, `${path}[]`);
    case "map": {
      const b = rn as typeof sn;
      // A map's key must match exactly: equal in both directions.
      flows(c, sn.key, b.key, `${path}{key}`);
      flows({ ...c, sender: c.receiver, receiver: c.sender }, b.key, sn.key, `${path}{key}`);
      return flows(c, sn.val, b.val, `${path}{}`);
    }
    case "result": {
      const b = rn as typeof sn;
      flows(c, sn.ok, b.ok, `${path}.Ok`);
      return flows(c, sn.err, b.err, `${path}.Err`);
    }
    case "record": {
      const b = rn as typeof sn;
      if (!enter(c, sn.name, b.name)) return;
      fields(c, sn.fields, b.fields, path);
      return args(c, sn.args, b.args, path);
    }
    case "sum": {
      const b = rn as typeof sn;
      if (!enter(c, sn.name, b.name)) return;
      for (const v of sn.variants) {
        const rv = b.variants.find((x) => x.name === v.name);
        if (!rv) bad(c, path, `variant ${v.name} is not accepted`);
        else fields(c, v.fields, rv.fields, `${path}<${v.name}>`);
      }
      return args(c, sn.args, b.args, path);
    }
  }
}

/** Whether to descend into a named pair (not when it is already being compared). */
function enter(c: Ctx, s: string, r: string): boolean {
  const key = `${s}\0${r}`;
  if (c.seen.has(key)) return false;
  c.seen.add(key);
  return true;
}

function args(c: Ctx, s: WcRef[], r: WcRef[], path: string): void {
  if (s.length !== r.length) return bad(c, path, "its type arguments changed");
  s.forEach((x, i) => flows(c, x, r[i], `${path}<${i}>`));
}

/** Fields of the sender against the receiver's: each the receiver has must
 *  decode; one the sender lacks is fine only when the receiver treats it as
 *  optional or defaulted. An extra sender field is ignored. */
function fields(c: Ctx, s: Field[], r: Field[], path: string): void {
  for (const rf of r) {
    const sf = s.find((x) => x.name === rf.name);
    const at = `${path}.${rf.name}`;
    if (sf) flows(c, sf.shape, rf.shape, at);
    else if (!rf.defaulted && c.receiver.node(rf.shape).k !== "option") bad(c, at, "is now required");
  }
}

// ---------------------------------------------------------- the handler

/** The request as a record-like list of fields, or as one bare value. */
function requestParts(e: WcEnvelope): { fields: Field[] } | { bare: WcRef } | { raw: string } {
  switch (e.kind) {
    case "Empty":
      return { fields: [] };
    case "Keyed":
      return { fields: e.params.map((p) => ({ name: p.name, shape: p.shape, defaulted: false })) };
    case "Bare":
      return { bare: e.shape };
    case "Raw":
      return { raw: e.contentType };
  }
}

const requestRefs = (e: WcEnvelope): WcRef[] => {
  const p = requestParts(e);
  return "fields" in p ? p.fields.map((f) => f.shape) : "bare" in p ? [p.bare] : [];
};

/** The responses a handler declares; the boundary's own implicit ones follow
 *  from the request's shape, which is compared directly. */
const declared = (m: WcModel): Set<string> =>
  new Set(m.responses.filter((r) => r.origin.kind !== "BoundaryImplicit").map((r) => `${r.status} ${r.variant}`));

/** Classify the change from `before` to `after` of one handler's contract. */
export function classifyWire(before: WcModel, after: WcModel): WireVerdict {
  const reasons: string[] = [];
  const b = new Side(before);
  const a = new Side(after);
  if (JSON.stringify(before.kind) !== JSON.stringify(after.kind)) {
    reasons.push(`the handler's boundary changed (${before.kind.kind} → ${after.kind.kind})`);
  }

  // Request: the earlier caller sends, the later callee receives.
  const req = { sender: b, receiver: a, out: [] as string[], seen: new Set<string>() };
  const bp = requestParts(before.envelope);
  const ap = requestParts(after.envelope);
  if ("fields" in bp && "fields" in ap) fields(req, bp.fields, ap.fields, "request");
  else if ("bare" in bp && "bare" in ap) flows(req, bp.bare, ap.bare, "request");
  else if ("raw" in bp && "raw" in ap) {
    if (bp.raw !== ap.raw) req.out.push(`request: content type ${bp.raw} → ${ap.raw}`);
  } else req.out.push("request: its form changed");
  reasons.push(...req.out);

  // Response: the later callee sends, the earlier caller receives.
  const res = { sender: a, receiver: b, out: [] as string[], seen: new Set<string>() };
  if (before.kind.kind === "Http" && after.kind.kind === "Http") {
    // A server before v0.633.4 (bynk#3609) reports no response shape, not even a
    // `null` `success`: infer it as before, rather than compare nothing.
    if (before.success !== undefined && after.success !== undefined) httpResponses(res, before, after);
    else inferredResponse(res, before, after, b, a);
  } else if (before.kind.kind === "Call" && after.kind.kind === "Call") inferredResponse(res, before, after, b, a);
  reasons.push(...res.out);

  // A response the callers never saw is one they may not handle.
  const had = declared(before);
  for (const r of declared(after)) if (!had.has(r)) reasons.push(`response ${r}: a new response callers may not handle`);

  return { verdict: reasons.length > 0 ? "breaking" : "compatible", reasons };
}

const responseKey = (r: WcHttpResponse): string => `${r.status} ${r.variant}`;

/** The body a response carries: the server's `body` (v0.633.9), or for a
 *  server that sends only `payload` (v0.633.4) a value body; `null` for none. */
export function responseBody(r: WcHttpResponse): WcResponseBody | null {
  if (r.body !== undefined) return r.body;
  return r.payload ? { kind: "Value", ref: r.payload } : null;
}

/** An HTTP handler's responses, compared by what the server says each body is.
 *  A boundary-implicit response has no body to describe (the boundary shapes
 *  it), and a response only the earlier revision declared is one callers
 *  handle and never receive, which is compatible. */
function httpResponses(c: Ctx, before: WcModel, after: WcModel): void {
  const earlier = new Map(before.responses.map((r) => [responseKey(r), r]));
  for (const r of after.responses) {
    const prior = earlier.get(responseKey(r));
    if (!prior || r.origin.kind === "BoundaryImplicit" || prior.origin.kind === "BoundaryImplicit") continue;
    const at = `response ${responseKey(r)}`;
    const was = responseBody(prior);
    const now = responseBody(r);
    if (was?.kind !== now?.kind) {
      bad(c, at, `its body is ${now?.kind ?? "none"} where it was ${was?.kind ?? "none"}`);
    } else if (was?.kind === "Value" && now?.kind === "Value") {
      flows(c, now.ref, was.ref, at);
    } else if (was?.kind === "Redirect" && now?.kind === "Redirect" && was.header !== now.header) {
      bad(c, at, `the redirect is now in ${now.header}, not ${was.header}`);
    }
  }
}

/** An `on call` handler's response, which the model does not carry yet
 *  (bynk-lang/bynk#3687): the types and instantiations its request does not
 *  reach. A type used on both sides is checked as a request only. */
function inferredResponse(res: Ctx, before: WcModel, after: WcModel, b: Side, a: Side): void {
  const bReq = b.closure(requestRefs(before.envelope));
  const aReq = a.closure(requestRefs(after.envelope));
  for (const t of before.types) {
    if (bReq.types.has(t.name) || aReq.types.has(t.name)) continue;
    if (!a.types.has(t.name)) res.out.push(`response ${t.name}: is no longer part of the contract`);
    else flows(res, { kind: "Named", name: t.name }, { kind: "Named", name: t.name }, `response ${t.name}`);
  }
  for (const i of before.instantiations) {
    if (bReq.insts.has(i.key) || aReq.insts.has(i.key)) continue;
    if (!a.insts.has(i.key)) res.out.push(`response ${i.key}: is no longer part of the contract`);
    else flows(res, { kind: "Inst", key: i.key }, { kind: "Inst", key: i.key }, `response ${i.key}`);
  }
}

/** The contract without positions, with its lists in a fixed order, so two
 *  revisions' models compare by what they say rather than where they are. */
function canonical(m: WcModel): string {
  const drop = new Set(["loc", "range", "handlerLine"]);
  const sortBy = <T,>(xs: T[], key: (t: T) => string): T[] => [...xs].sort((x, y) => key(x).localeCompare(key(y)));
  return JSON.stringify(
    { ...m, types: sortBy(m.types, (t) => t.name), instantiations: sortBy(m.instantiations, (i) => i.key) },
    (k, v: unknown) => (drop.has(k) ? undefined : v),
  );
}

/** Handlers added, removed, or whose wire contract changed, with the verdict
 *  for each: an added handler is compatible, a removed one breaking. */
export function diffWire(before: Record<string, WireHandler>, after: Record<string, WireHandler>): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const [key, a] of Object.entries(after)) {
    const b = before[key];
    if (!b) {
      out.push({ change: "added", element: "handler", name: key, verdict: "compatible", loc: { uri: a.uri, range: a.model.range } });
      continue;
    }
    if (canonical(b.model) === canonical(a.model)) continue;
    const v = classifyWire(b.model, a.model);
    const hash = b.model.contract && a.model.contract && b.model.contract.hash !== a.model.contract.hash
      ? `contract ${b.model.contract.hash} → ${a.model.contract.hash}`
      : undefined;
    out.push({
      change: "changed",
      element: "handler",
      name: key,
      detail: v.reasons.length > 0 ? v.reasons.join("; ") : (hash ?? "a change that callers built against the earlier revision still accept"),
      verdict: v.verdict,
      loc: { uri: a.uri, range: a.model.range },
    });
  }
  for (const key of Object.keys(before)) {
    if (!after[key]) out.push({ change: "removed", element: "handler", name: key, detail: "callers of it will fail", verdict: "breaking", loc: null });
  }
  return out;
}

/** Where a boundary type travels in a handler's wire contract (#146): in the
 *  request, in a response, both, or neither. An HTTP handler's response is the
 *  server's own (`success` and each response's body); an `on call` handler's is
 *  inferred as the types the request does not reach (bynk-lang/bynk#3687); other
 *  handlers have no response. A name matches a type by `Name` or `unit.Name`. */
export function wireCarries(model: WcModel, name: string): { request: boolean; response: boolean } {
  const side = new Side(model);
  const is = (n: string): boolean => n === name || n.endsWith(`.${name}`);
  const request = [...side.closure(requestRefs(model.envelope)).types].some(is);
  let response = false;
  if (model.kind.kind === "Http") {
    const refs: WcRef[] = model.success ? [model.success] : [];
    for (const r of model.responses) {
      const body = responseBody(r);
      if (body?.kind === "Value") refs.push(body.ref);
    }
    response = [...side.closure(refs).types].some(is);
  } else if (model.kind.kind === "Call") {
    response = !request && model.types.some((t) => is(t.name));
  }
  return { request, response };
}
