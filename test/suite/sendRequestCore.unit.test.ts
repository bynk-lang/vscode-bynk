// #67: the pure part of "Bynk: Send Request". The models are trimmed copies of
// what `bynkc-lsp` v0.443.0 answers `bynk/wireContract` with.

import * as assert from "assert";

import {
  buildRequest,
  devTarget,
  fillPath,
  formatBody,
  isHttpHandlerHeader,
  parseHeaders,
  routeForm,
  type RouteForm,
} from "../../src/sendRequestCore";
import type { WcModel, WcRef, WcType } from "../../src/webview/wireContractTypes";

const str: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
const int: WcRef = { kind: "Base", base: "Int", json: "Number", guards: ["Integral"], expected: { kind: "Json", json: "Number" } };
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function model(over: Partial<WcModel>): WcModel {
  return {
    unit: "app.shop",
    service: "api",
    kind: { kind: "Http", method: "GET", path: "/" },
    range,
    handlerLine: 1,
    envelope: { kind: "Empty" },
    contract: null,
    types: [],
    instantiations: [],
    recursive: [],
    responses: [],
    noCrossContext: "SingleContext",
    ...over,
  };
}

const item: WcType = {
  name: "Item",
  codecSuffix: "Item",
  provenance: { kind: "Owned" },
  loc: null,
  body: {
    kind: "Record",
    fields: [
      { name: "name", shape: str, pathSegment: "name", default: null },
      { name: "qty", shape: int, pathSegment: "qty", default: null },
      { name: "tags", shape: { kind: "Inst", key: "List_String" }, pathSegment: "tags", default: null },
      { name: "note", shape: { kind: "Inst", key: "Option_String" }, pathSegment: "note", default: null },
    ],
  },
};
const insts: WcModel["instantiations"] = [
  { kind: "ListInst", key: "List_String", elem: str },
  { kind: "OptionInst", key: "Option_String", inner: str },
];

describe("sendRequestCore", () => {
  it("a non-HTTP handler has no form", () => {
    assert.strictEqual(routeForm(model({ kind: { kind: "Call" } })), undefined);
  });

  it("a path-only route: its `:name` params, no body", () => {
    const form = routeForm(
      model({ kind: { kind: "Http", method: "GET", path: "/items/:id" }, envelope: { kind: "Bare", param: "id", shape: { kind: "Named", name: "Sku" } } }),
    );
    assert.deepStrictEqual(form, { method: "GET", path: "/items/:id", pathParams: ["id"], body: null, readsHeaders: false });
  });

  it("a record body gets a skeleton in wire form (lists empty, options None)", () => {
    const form = routeForm(
      model({
        kind: { kind: "Http", method: "PUT", path: "/items/:id" },
        envelope: { kind: "Keyed", params: [{ name: "id", shape: str }, { name: "body", shape: { kind: "Named", name: "Item" } }] },
        types: [item],
        instantiations: insts,
      }),
    );
    assert.ok(form?.body?.kind === "json");
    assert.deepStrictEqual(JSON.parse(form.body.skeleton), { name: "", qty: 0, tags: [], note: { kind: "None" } });
    assert.deepStrictEqual(form.pathParams, ["id"]);
  });

  it("a sum body starts at its first variant, under the wire discriminant", () => {
    const shape: WcType = {
      name: "Shape",
      codecSuffix: "Shape",
      provenance: { kind: "Owned" },
      loc: null,
      body: {
        kind: "Sum",
        wireDiscriminant: "kind",
        memoryDiscriminant: "tag",
        variants: [
          { name: "Circle", payload: [{ name: "r", shape: int, pathSegment: "r", default: null }] },
          { name: "Square", payload: [] },
        ],
      },
    };
    const form = routeForm(
      model({ kind: { kind: "Http", method: "POST", path: "/s" }, envelope: { kind: "Bare", param: "body", shape: { kind: "Named", name: "Shape" } }, types: [shape] }),
    );
    assert.ok(form?.body?.kind === "json");
    assert.deepStrictEqual(JSON.parse(form.body.skeleton), { kind: "Circle", r: 0 });
  });

  it("a recursive type's skeleton stays finite", () => {
    const node: WcType = {
      name: "Node",
      codecSuffix: "Node",
      provenance: { kind: "Owned" },
      loc: null,
      body: { kind: "Record", fields: [{ name: "next", shape: { kind: "Named", name: "Node" }, pathSegment: "next", default: null }] },
    };
    const form = routeForm(
      model({ kind: { kind: "Http", method: "POST", path: "/n" }, envelope: { kind: "Bare", param: "body", shape: { kind: "Named", name: "Node" } }, types: [node] }),
    );
    assert.ok(form?.body?.kind === "json");
    assert.deepStrictEqual(JSON.parse(form.body.skeleton), { next: null });
  });

  it("a raw route and a headers param are noted", () => {
    const raw = routeForm(model({ kind: { kind: "Http", method: "POST", path: "/up" }, envelope: { kind: "Raw", param: "body", contentType: "image/png" } }));
    assert.deepStrictEqual(raw?.body, { kind: "raw", contentType: "image/png" });
    const h = routeForm(
      model({ envelope: { kind: "Keyed", params: [{ name: "id", shape: str }, { name: "headers", shape: { kind: "Unchecked", reason: "Effect" } }] } }),
    );
    assert.strictEqual(h?.readsHeaders, true);
    assert.strictEqual(h?.body, null, "headers is not a body");
  });

  it("fills path params percent-encoded, and names the empty ones", () => {
    assert.deepStrictEqual(fillPath("/n/:a/:b", { a: "x y", b: "1/2" }), { path: "/n/x%20y/1%2F2" });
    assert.deepStrictEqual(fillPath("/n/:a/:b", { a: "x" }), { missing: ["b"] });
  });

  it("parses header lines, skipping blanks and comments", () => {
    assert.deepStrictEqual(parseHeaders("Authorization: Bearer t\n\n# note\nX-A:1"), {
      headers: [["Authorization", "Bearer t"], ["X-A", "1"]],
    });
    assert.deepStrictEqual(parseHeaders("ok: 1\nnot a header"), { error: "Header line 2 isn't Name: value." });
  });

  it("refuses headers fetch would reject, naming the line", () => {
    const framing = parseHeaders("X-A: 1\nTransfer-Encoding: chunked");
    assert.ok("error" in framing && /^Header line 2: Transfer-Encoding can't be set/.test(framing.error));
    assert.ok("error" in parseHeaders("expect: 100-continue"));
    const wide = parseHeaders("X-Name: 日本");
    assert.ok("error" in wide && /beyond U\+00FF/.test(wide.error));
    assert.deepStrictEqual(parseHeaders("X-Name: café\tok"), { headers: [["X-Name", "café\tok"]] }, "Latin-1 and tab pass");
  });

  describe("buildRequest", () => {
    const put: RouteForm = { method: "PUT", path: "/items/:id", pathParams: ["id"], body: { kind: "json", skeleton: "{}" }, readsHeaders: false };

    it("joins the base, fills the path and defaults the content type", () => {
      const r = buildRequest(put, "http://localhost:8787/", { path: { id: "a" }, headers: "", body: '{"name":"x"}' });
      assert.deepStrictEqual(r, {
        request: {
          method: "PUT",
          url: "http://localhost:8787/items/a",
          headers: [["Content-Type", "application/json"]],
          body: '{"name":"x"}',
        },
      });
    });

    it("keeps a content type the headers set", () => {
      const r = buildRequest(put, "http://h", { path: { id: "a" }, headers: "content-type: application/json; charset=utf-8", body: "{}" });
      assert.ok("request" in r);
      assert.deepStrictEqual(r.request.headers, [["content-type", "application/json; charset=utf-8"]]);
    });

    it("refuses an empty path param or a body that isn't JSON", () => {
      assert.deepStrictEqual(buildRequest(put, "http://h", { path: {}, headers: "", body: "{}" }), { error: "Fill in :id." });
      const bad = buildRequest(put, "http://h", { path: { id: "a" }, headers: "", body: "{" });
      assert.ok("error" in bad && /isn't valid JSON/.test(bad.error));
    });

    it("sends no body for a route without one", () => {
      const get: RouteForm = { method: "GET", path: "/", pathParams: [], body: null, readsHeaders: false };
      const r = buildRequest(get, "http://h", { path: {}, headers: "", body: "ignored" });
      assert.deepStrictEqual(r, { request: { method: "GET", url: "http://h/", headers: [] } });
    });
  });

  describe("devTarget", () => {
    const ctx = { name: "app-shop", port: 8787, url: "http://localhost:8787", inspectorPort: null };

    it("no session, or one still starting", () => {
      assert.deepStrictEqual(devTarget("app.shop", undefined), { kind: "stopped" });
      assert.deepStrictEqual(devTarget("app.shop", { phase: "stopped", contexts: [ctx], ready: true }), { kind: "stopped" });
      assert.deepStrictEqual(devTarget("app.shop", { phase: "serving", contexts: [ctx], ready: false }), { kind: "starting" });
    });

    it("matches the unit to its worker-dir context name", () => {
      assert.deepStrictEqual(devTarget("app.shop", { phase: "ready", contexts: [ctx], ready: true }), {
        kind: "ready",
        url: "http://localhost:8787",
      });
      assert.deepStrictEqual(devTarget("app.web", { phase: "ready", contexts: [ctx], ready: true }), {
        kind: "notServed",
        served: ["app-shop"],
      });
    });

    it("a rebuild still sends, with a note", () => {
      const t = devTarget("app.shop", { phase: "failed", contexts: [ctx], ready: true });
      assert.ok(t.kind === "ready" && t.note && /previous build/.test(t.note));
    });
  });

  it("pretty-prints a JSON body, and leaves anything else as sent", () => {
    assert.deepStrictEqual(formatBody("application/json", '{"a":1}'), { body: '{\n  "a": 1\n}', json: true });
    assert.deepStrictEqual(formatBody(null, "[1]"), { body: "[\n  1\n]", json: true });
    assert.deepStrictEqual(formatBody("text/plain", "hi"), { body: "hi", json: false });
    assert.deepStrictEqual(formatBody("application/json", "{oops"), { body: "{oops", json: false });
  });

  it("recognises an HTTP handler header, past annotations", () => {
    assert.ok(isHttpHandlerHeader(['  on GET("/") () -> X by v: Visitor {']));
    assert.ok(isHttpHandlerHeader(["  @cache(maxAge: 60)", '  on GET("/x") () -> X {']));
    assert.ok(!isHttpHandlerHeader(["  on call() -> Effect[Int] {"]));
    assert.ok(!isHttpHandlerHeader(["  fn f() {", '  on GET("/") () {']));
    const commented = [...Array(12).fill("  // a long note"), "  @cache(maxAge: 60)", '  on GET("/x") () -> X {'];
    assert.ok(isHttpHandlerHeader(commented), "however many comment lines come first");
  });
});
