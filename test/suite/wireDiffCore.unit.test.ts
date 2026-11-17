// Unit coverage for the wire-contract classification of "Bynk: Compare Model
// with…" (#154), over hand-built `WcModel`s.

import * as assert from "assert";

import { diffSnapshots, type ModelSnapshot } from "../../src/modelDiffCore";
import { renderModelDiffHtml } from "../../src/modelDiffHtml";
import { classifyWire, diffWire, wireHandlerKey, type WireHandler } from "../../src/wireDiffCore";
import type { WcBody, WcField, WcHttpResponse, WcInst, WcModel, WcRef, WcResponseBody, WcResponseOrigin } from "../../src/webview/wireContractTypes";

const rng = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
const STR: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
const INT: WcRef = { kind: "Base", base: "Int", json: "Number", guards: ["Integral"], expected: { kind: "Integer" } };
const named = (name: string): WcRef => ({ kind: "Named", name });
const inst = (key: string): WcRef => ({ kind: "Inst", key });
const field = (name: string, shape: WcRef, def: string | null = null): WcField => ({ name, shape, pathSegment: name, default: def });
const record = (name: string, fields: WcField[]) => ({
  name, codecSuffix: name, provenance: { kind: "Owned" as const }, body: { kind: "Record", fields } as WcBody, loc: null,
});
const scalar = (name: string, predicates: string[], opaque = false) => ({
  name, codecSuffix: name, provenance: { kind: "Owned" as const }, loc: null,
  body: { kind: "Scalar", base: "String", json: "String", opaque, predicates, baseGuards: [], revalidation: "ViaConstructor" } as WcBody,
});
const sum = (name: string, variants: string[]) => ({
  name, codecSuffix: name, provenance: { kind: "Owned" as const }, loc: null,
  body: { kind: "Sum", wireDiscriminant: "kind", memoryDiscriminant: "tag", variants: variants.map((v) => ({ name: v, payload: [] })) } as WcBody,
});

function handler(over: Partial<WcModel> = {}): WcModel {
  return {
    unit: "shop", service: "api", kind: { kind: "Http", method: "POST", path: "/orders" }, range: rng, handlerLine: 1,
    envelope: { kind: "Empty" }, contract: null, types: [], instantiations: [], recursive: [], responses: [], noCrossContext: null,
    ...over,
  };
}
const ok = (status: number, variant = "Ok", origin: WcResponseOrigin = { kind: "DeclaredSuccess" }) => ({ status, variant, origin });
const keyed = (...params: Array<[string, WcRef]>) => ({ kind: "Keyed" as const, params: params.map(([name, shape]) => ({ name, shape })) });
const verdict = (b: WcModel, a: WcModel) => classifyWire(b, a);

// Each test is named after the `bynk-check/src/contract_compat.rs` rule it mirrors
// (bynk v0.614.0), so a rule change there maps to the test to update.
describe("wire contract classification (#154)", () => {
  it("keys an HTTP handler by route and any other by its symbol", () => {
    assert.strictEqual(wireHandlerKey(handler(), "call"), "shop.api: POST /orders");
    assert.strictEqual(wireHandlerKey(handler({ kind: { kind: "Call" } }), "call place"), "shop.api: call place");
  });

  it("request_optional_field_added_is_compatible, and a required one added is breaking", () => {
    const base = handler({ envelope: keyed(["id", INT]) });
    assert.strictEqual(verdict(base, handler({ envelope: keyed(["id", INT], ["note", inst("Option[String]")]), instantiations: [{ kind: "OptionInst", key: "Option[String]", inner: STR }] })).verdict, "compatible");
    const req = verdict(base, handler({ envelope: keyed(["id", INT], ["note", STR]) }));
    assert.strictEqual(req.verdict, "breaking");
    assert.deepStrictEqual(req.reasons, ["request.note: is now required"]);
  });

  it("request_field_removed_is_compatible_because_the_callee_ignores_it", () => {
    assert.strictEqual(verdict(handler({ envelope: keyed(["id", INT], ["x", STR]) }), handler({ envelope: keyed(["id", INT]) })).verdict, "compatible");
  });

  it("request_refinement_widened_is_compatible, request_refinement_narrowed_is_breaking", () => {
    const withPred = (p: string[]) => handler({ envelope: keyed(["email", named("Email")]), types: [scalar("Email", p)] });
    const tight = verdict(withPred([]), withPred(["contains(\"@\")"]));
    assert.strictEqual(tight.verdict, "breaking");
    assert.match(tight.reasons[0], /request\.email: now requires contains/);
    assert.strictEqual(verdict(withPred(["contains(\"@\")"]), withPred([])).verdict, "compatible");
    // An opaque scalar's predicate is not re-validated at the boundary.
    assert.strictEqual(verdict(
      handler({ envelope: keyed(["e", named("E")]), types: [scalar("E", [], true)] }),
      handler({ envelope: keyed(["e", named("E")]), types: [scalar("E", ["p"], true)] }),
    ).verdict, "compatible");
  });

  it("treats a changed field type as breaking, and a bare value for an Option as fine", () => {
    assert.strictEqual(verdict(handler({ envelope: keyed(["id", INT]) }), handler({ envelope: keyed(["id", STR]) })).verdict, "breaking");
    const opt: WcInst = { kind: "OptionInst", key: "Option[Int]", inner: INT };
    assert.strictEqual(verdict(handler({ envelope: keyed(["id", INT]) }), handler({ envelope: keyed(["id", inst("Option[Int]")]), instantiations: [opt] })).verdict, "compatible");
    // The other way, the receiver now requires what could be absent.
    assert.strictEqual(verdict(handler({ envelope: keyed(["id", inst("Option[Int]")]), instantiations: [opt] }), handler({ envelope: keyed(["id", INT]) })).verdict, "breaking");
  });

  // An HTTP handler's response is the server's own shape (bynk#3609, #3632).
  const valueResponse = (ref: WcRef, status = 200, variant = "Ok"): WcHttpResponse => ({
    ...ok(status, variant), payload: ref, body: { kind: "Value", ref },
  });
  const http = (success: WcRef | null, types: WcModel["types"], responses: WcHttpResponse[] = success ? [valueResponse(success)] : [], over: Partial<WcModel> = {}) =>
    handler({ success, types, responses, envelope: keyed(["id", INT]), ...over });

  it("response_variant_added_is_breaking_and_removed_is_compatible, response_field_added_is_compatible", () => {
    const res = (variants: string[], extra: WcField[] = []) =>
      http(named("Status"), [sum("Status", variants), record("Out", [field("id", INT), ...extra])]);
    const added = verdict(res(["A"]), res(["A", "B"]));
    assert.strictEqual(added.verdict, "breaking");
    assert.deepStrictEqual(added.reasons, ["response 200 Ok: variant B is not accepted"]);
    assert.strictEqual(verdict(res(["A"]), res(["A"], [field("extra", STR)])).verdict, "compatible");
    // A response variant removed is something the caller already handles.
    assert.strictEqual(verdict(res(["A", "B"]), res(["A"])).verdict, "compatible");
    // An added field on the success type itself is ignored by the caller.
    const out = (fields: WcField[]) => http(named("Out"), [record("Out", fields)]);
    assert.strictEqual(verdict(out([field("id", INT)]), out([field("id", INT), field("extra", STR)])).verdict, "compatible");
  });

  it("treats a response field removed as breaking unless it was optional or defaulted", () => {
    const out = (fields: WcField[]) => http(named("Out"), [record("Out", fields)]);
    const gone = verdict(out([field("id", INT), field("n", STR)]), out([field("id", INT)]));
    assert.strictEqual(gone.verdict, "breaking");
    assert.deepStrictEqual(gone.reasons, ["response 200 Ok.n: is now required"]);
    assert.strictEqual(verdict(out([field("id", INT), field("n", STR, "\"\"")]), out([field("id", INT)])).verdict, "compatible");
  });

  it("compares a type the request and the response both use in both directions", () => {
    // Before, a type on both sides was checked as a request only: a removed
    // field was fine. As a response it is breaking.
    const both = (fields: WcField[]) =>
      http(named("Item"), [record("Item", fields)], undefined, { envelope: keyed(["item", named("Item")]) });
    const r = verdict(both([field("id", INT), field("n", STR)]), both([field("id", INT)]));
    assert.strictEqual(r.verdict, "breaking");
    assert.deepStrictEqual(r.reasons, ["response 200 Ok.n: is now required"]);
  });

  it("classifies each response by its own body", () => {
    const one = (r: WcHttpResponse) => http(null, [], [r]);
    const message = (status: number): WcHttpResponse => ({ ...ok(status, "Bad", { kind: "Constructed", range: rng }), payload: null, body: { kind: "Message" } });
    const redirect = (header: string): WcHttpResponse => ({ ...ok(302, "Found"), payload: null, body: { kind: "Redirect", header } });
    assert.strictEqual(verdict(one(message(400)), one(message(400))).verdict, "compatible");
    // The status and variant name the response; a body of another kind is a different contract.
    const changed = verdict(one(message(400)), one({ ...message(400), body: { kind: "Raw" } }));
    assert.deepStrictEqual(changed.reasons, ["response 400 Bad: its body is Raw where it was Message"]);
    assert.strictEqual(verdict(one(message(400)), one({ ...message(400), body: null })).verdict, "breaking");
    assert.deepStrictEqual(
      verdict(one(redirect("Location")), one(redirect("X-Next"))).reasons,
      ["response 302 Found: the redirect is now in X-Next, not Location"],
    );
    for (const kind of ["Raw", "Stream"] as const) {
      const body = { ...ok(200), payload: null, body: { kind } } as WcHttpResponse;
      assert.strictEqual(verdict(one(body), one(body)).verdict, "compatible", kind);
    }
  });

  it("reads the response type from an older server that sends only a payload, and skips the boundary's own responses", () => {
    const old = (ref: WcRef) => http(ref, [], [{ ...ok(200), payload: ref }]);
    assert.strictEqual(verdict(old(INT), old(STR)).verdict, "breaking");
    assert.strictEqual(verdict(old(INT), old(INT)).verdict, "compatible");
    const implicit = (body: WcResponseBody | null): WcHttpResponse => ({ ...ok(400, "Bad", { kind: "BoundaryImplicit", why: "decode" }), body });
    assert.strictEqual(verdict(http(null, [], [implicit(null)]), http(null, [], [implicit({ kind: "Message" })])).verdict, "compatible");
  });

  it("infers an HTTP handler's response from a server that reports none (before v0.633.4)", () => {
    // No `success`, `payload` or `body` anywhere: the response is the types the request does not reach.
    const old = (fields: WcField[]) => handler({ envelope: keyed(["id", INT]), types: [record("Out", fields)] });
    const gone = verdict(old([field("id", INT), field("n", STR)]), old([field("id", INT)]));
    assert.strictEqual(gone.verdict, "breaking");
    assert.deepStrictEqual(gone.reasons, ["response Out.n: is now required"]);
    assert.strictEqual(verdict(old([field("id", INT)]), old([field("id", INT), field("n", STR)])).verdict, "compatible");
  });

  it("applies only the request side to a handler with no response", () => {
    // A cron job's `types` are its request's; whatever else the model lists is no response.
    const cron = (types: WcModel["types"]) => handler({ kind: { kind: "Cron", expr: "* * * * *" }, types });
    assert.strictEqual(verdict(cron([record("Out", [field("id", INT), field("n", STR)])]), cron([record("Out", [field("id", INT)])])).verdict, "compatible");
    assert.strictEqual(verdict(cron([record("Out", [field("id", INT)])]), cron([])).verdict, "compatible");
  });

  it("still infers an `on call` handler's response, which the model does not carry (bynk#3687)", () => {
    const call = (variants: string[]) => handler({ kind: { kind: "Call" }, envelope: keyed(["id", INT]), types: [sum("Status", variants)] });
    const added = verdict(call(["A"]), call(["A", "B"]));
    assert.deepStrictEqual(added.reasons, ["response Status: variant B is not accepted"]);
    assert.strictEqual(verdict(call(["A", "B"]), call(["A"])).verdict, "compatible");
    const dropped = verdict(handler({ kind: { kind: "Call" }, types: [record("Out", [field("id", INT)])] }), handler({ kind: { kind: "Call" } }));
    assert.deepStrictEqual(dropped.reasons, ["response Out: is no longer part of the contract"]);
  });

  it("flags a declared response callers never saw, but not the boundary's own", () => {
    assert.strictEqual(verdict(handler({ responses: [ok(200)] }), handler({ responses: [ok(200), ok(404, "NotFound", { kind: "Constructed", range: rng })] })).verdict, "breaking");
    assert.strictEqual(verdict(handler({ responses: [ok(200)] }), handler({ responses: [ok(200), ok(400, "Bad", { kind: "BoundaryImplicit", why: "decode" })] })).verdict, "compatible");
  });

  it("ends on a recursive type", () => {
    const tree = (extra: WcField[]) => handler({ envelope: keyed(["t", named("Tree")]), types: [record("Tree", [field("kids", inst("List[Tree]")), ...extra])], instantiations: [{ kind: "ListInst", key: "List[Tree]", elem: named("Tree") }] });
    assert.strictEqual(verdict(tree([]), tree([])).verdict, "compatible");
    assert.strictEqual(verdict(tree([]), tree([field("must", STR)])).verdict, "breaking");
  });

  it("flags a changed content type, request form and boundary", () => {
    assert.strictEqual(verdict(handler({ envelope: { kind: "Raw", param: "b", contentType: "text/plain" } }), handler({ envelope: { kind: "Raw", param: "b", contentType: "text/csv" } })).verdict, "breaking");
    assert.strictEqual(verdict(handler({ envelope: { kind: "Bare", param: "b", shape: STR } }), handler({ envelope: keyed(["b", STR]) })).verdict, "breaking");
    assert.strictEqual(verdict(handler({ kind: { kind: "Cron", expr: "* * * * *" } }), handler({ kind: { kind: "Cron", expr: "0 * * * *" } })).verdict, "breaking");
  });
});

describe("wire contract diff entries (#154)", () => {
  const at = (m: WcModel, uri = "file:///w/a.bynk"): WireHandler => ({ model: m, uri });
  const ONE = handler({ envelope: keyed(["id", INT]) });

  it("reports added handlers compatible, removed ones breaking, and changed ones by verdict", () => {
    const before = { "shop.api: POST /orders": at(ONE), "shop.api: GET /gone": at(handler()) , "shop.api: GET /same": at(handler())};
    const after = {
      "shop.api: POST /orders": at(handler({ envelope: keyed(["id", INT], ["n", STR]) }), "file:///w/b.bynk"),
      "shop.api: GET /new": at(handler()),
      "shop.api: GET /same": at(handler({ range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } } })),
    };
    const entries = diffWire(before, after);
    assert.deepStrictEqual(entries.map((e) => `${e.change} ${e.name} ${e.verdict}`).sort(), [
      "added shop.api: GET /new compatible",
      "changed shop.api: POST /orders breaking",
      "removed shop.api: GET /gone breaking",
    ]);
    const changed = entries.find((e) => e.change === "changed")!;
    assert.strictEqual(changed.detail, "request.n: is now required");
    assert.strictEqual(changed.loc?.uri, "file:///w/b.bynk", "a changed handler links to the working tree");
    assert.strictEqual(entries.find((e) => e.change === "removed")!.loc, null);
  });

  it("is a section of the diff, unavailable when a revision's handlers were not read", () => {
    const snap = (wire?: Record<string, WireHandler>): ModelSnapshot => ({ architecture: { nodes: [], edges: [] }, contracts: null, agents: {}, wire });
    const d = diffSnapshots(snap({ k: at(ONE) }), snap({ k: at(ONE) }));
    const section = d.sections.find((s) => s.id === "wire")!;
    assert.deepStrictEqual(section.entries, []);
    assert.match(section.note ?? "", /caller built against the earlier revision/);
    assert.ok(diffSnapshots(snap(), snap({})).sections.find((s) => s.id === "wire")!.unavailable);
    const html = renderModelDiffHtml(diffSnapshots(snap({}), snap({ k: at(ONE) })), { against: "x", nonce: "N", cspSource: "c" });
    assert.match(html, /Wire contracts \(1\)/);
    assert.match(html, /class="compatible">compatible/);
  });
});
