// #158: promoting a scenario to a `system` suite, the pure part: which calls,
// assertions and captures the suite can express, and what is listed instead.

import * as assert from "assert";

import { parseScenario } from "../../src/scenarioCore";
import { promote, summarise, variantFor, type PromoteRoute } from "../../src/scenarioPromoteCore";
import type { WcHttpResponse, WcType } from "../../src/webview/wireContractTypes";

const baseRef = (base: "String" | "Int") => ({ kind: "Base" as const, base, json: base === "Int" ? ("Number" as const) : ("String" as const), guards: [], expected: { kind: "Json" as const, json: "String" as const } });

const ITEM: WcType = {
  name: "Item",
  codecSuffix: "Item",
  provenance: { kind: "Owned" },
  loc: null,
  body: {
    kind: "Record",
    fields: [
      { name: "name", shape: baseRef("String"), pathSegment: "name", default: null },
      { name: "qty", shape: baseRef("Int"), pathSegment: "qty", default: null },
    ],
  },
};
const ITEM_ID: WcType = {
  name: "ItemId",
  codecSuffix: "ItemId",
  provenance: { kind: "Owned" },
  loc: null,
  body: { kind: "Scalar", base: "String", json: "String", opaque: true, predicates: [], baseGuards: [], revalidation: "ViaConstructor" },
};

const responses = (...rs: [number, string, boolean?][]): WcHttpResponse[] =>
  rs.map(([status, variant, declared]) => ({ status, variant, origin: declared ? { kind: "DeclaredSuccess" } : { kind: "Constructed", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } } }));

function route(over: Partial<PromoteRoute> & Pick<PromoteRoute, "method" | "path">): PromoteRoute {
  return {
    unit: "shop",
    service: "api",
    model: { envelope: { kind: "Empty" }, types: [ITEM, ITEM_ID], instantiations: [] },
    responses: responses([200, "Ok", true]),
    ...over,
  };
}

const PUT = route({
  method: "PUT",
  path: "/items/:id",
  model: {
    envelope: {
      kind: "Keyed",
      params: [
        { name: "id", shape: { kind: "Named", name: "ItemId" } },
        { name: "body", shape: { kind: "Named", name: "Item" } },
      ],
    },
    types: [ITEM, ITEM_ID],
    instantiations: [],
  },
  responses: responses([200, "Ok", true], [201, "Created"], [409, "Conflict"]),
});
const GET = route({ method: "GET", path: "/items/:id", model: { envelope: { kind: "Bare", param: "id", shape: { kind: "Named", name: "ItemId" } }, types: [ITEM, ITEM_ID], instantiations: [] }, responses: responses([200, "Ok", true], [404, "NotFound"]) });
const PING = route({ method: "GET", path: "/ping" });

const routes = [PUT, GET, PING];
const resolveAll = (text: string) => {
  const sc = parseScenario(text);
  return { sc, resolved: sc.steps.map((s) => ({ route: routes.find((r) => r.method === s.method && r.path.split("/").length === s.path.split("/").length && (r.path === s.path || r.path.includes(":"))) ?? PING })) };
};
const opts = { name: "scenarios/items.bynk-http", actorFor: () => "Visitor", actorRule: "Runs as Visitor." };

describe("Promote a scenario (#158)", () => {
  it("writes a call, matches the status's variant and carries a captured value", () => {
    const { sc, resolved } = resolveAll(`@context shop

### create
PUT /items/abc
Content-Type: application/json

{ "name": "x", "qty": 2 }

? status == 201
? body.name == "x"

### fetch
GET /items/{{create.body.name}}

? status == 200
`);
    const r = promote(sc, resolved, opts);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.unit, "shop");
    assert.ok(r.text.includes("suite shop as system {"), r.text);
    assert.ok(r.text.includes('\tcase "items" {'), r.text);
    assert.ok(r.text.includes('let Created(v_create) <- api.PUT("/items/:id", ItemId.unsafe("abc"), Item { name: "x", qty: 2 }) by Visitor else { expect false }'), r.text);
    assert.ok(r.text.includes('expect v_create.name == "x"'), r.text);
    // The capture is a typed value, not text: it is the argument itself.
    assert.ok(r.text.includes('let Ok(_) <- api.GET("/items/:id", v_create.name) by Visitor else { expect false }'), r.text);
    assert.strictEqual(r.expressed, r.expectations);
    assert.deepStrictEqual(r.unsupported, []);
  });

  it("never writes an environment value, and names the actor instead", () => {
    const { sc, resolved } = resolveAll(`@context shop

### ping
GET /ping
Authorization: Bearer {{env.TOKEN}}
`);
    const r = promote(sc, resolved, { ...opts, actorFor: () => 'User("ada")', actorRule: 'Runs as User("ada"): the scenario sends credentials.' });
    assert.ok(r.ok);
    assert.ok(!/TOKEN|Bearer/.test(r.text.replace(/^\/\/.*$/gm, "")), r.text);
    assert.ok(r.text.includes('by User("ada")'), r.text);
  });

  it("refuses an environment value anywhere but a credential header, listing the step", () => {
    const { sc, resolved } = resolveAll(`@context shop

### ping
GET /ping
X-Region: {{env.REGION}}

### ok
GET /ping
`);
    const r = promote(sc, resolved, opts);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.unsupported.map((u) => u.step), ["ping"]);
    assert.match(r.unsupported[0].why, /reads the environment/);
    assert.ok(r.text.includes("// Not expressed"), r.text);
    assert.ok(!r.text.includes("REGION="), r.text);
  });

  it("lists what a suite cannot express, with the reason, and says how much", () => {
    const { sc, resolved } = resolveAll(`@context shop

### ping
GET /ping

? status == 200
? header content-type == "application/json"
? header set-cookie contains "sid"
? body.items[0] == 1
? body exists
`);
    const r = promote(sc, resolved, opts);
    assert.ok(r.ok);
    assert.strictEqual(r.expectations, 5);
    assert.strictEqual(r.expressed, 1);
    const why = r.unsupported.map((u) => u.why).join("\n");
    assert.match(why, /cannot read a content-type response header/);
    assert.match(why, /cookies/);
    assert.match(r.text, /Not expressed \(4 of 5 expectations/);
    assert.match(summarise(r), /1 of 5 expectations became assertions/);
  });

  it("leaves out a step that reads one it could not write, and carries on", () => {
    const { sc, resolved } = resolveAll(`@context shop

### one
GET /ping
X-A: {{env.A}}

### two
GET /ping
X-B: {{one.status}}

### three
GET /ping
`);
    const r = promote(sc, resolved, opts);
    assert.ok(r.ok);
    assert.strictEqual(r.generated, 1);
    assert.deepStrictEqual(r.unsupported.map((u) => u.step), ["one", "two"]);
    assert.match(r.unsupported[1].why, /reads `one`/);
  });

  it("will not guess between variants, nor match a boundary rejection", () => {
    const ambiguous = route({ method: "GET", path: "/ping", responses: responses([200, "Ok"], [200, "Raw"]) });
    assert.deepStrictEqual(variantFor(ambiguous, 200), { why: "200 is answered by Ok and Raw; naming one would be a guess" });
    const declared = route({ method: "GET", path: "/ping", responses: responses([200, "Ok", true], [200, "Raw"]) });
    assert.deepStrictEqual(variantFor(declared, 200), { name: "Ok" });
    const implicit: PromoteRoute = { ...PING, responses: [{ status: 400, variant: "StructuralMismatch", origin: { kind: "BoundaryImplicit", why: "x" } }] };
    assert.match((variantFor(implicit, 400) as { why: string }).why, /boundary's own rejection/);
    assert.match((variantFor(PING, 404) as { why: string }).why, /does not answer 404/);
    assert.match((variantFor({ ...PING, responses: undefined }, 200) as { why: string }).why, /did not give/);
  });

  it("qualifies a variant with no payload, and ends the case without a blank line", () => {
    const gone = route({ method: "DELETE", path: "/items/:id", model: { envelope: { kind: "Bare", param: "id", shape: { kind: "Named", name: "ItemId" } }, types: [ITEM, ITEM_ID], instantiations: [] }, responses: responses([200, "Ok", true], [204, "NoContent"]) });
    const sc = parseScenario("@context shop\n\n### drop\nDELETE /items/a\n\n? status == 204\n");
    const r = promote(sc, [{ route: gone }], opts);
    assert.ok(r.ok);
    // A bare variant name is a binding, not a pattern.
    assert.ok(r.text.includes('let HttpResult.NoContent <- api.DELETE("/items/:id", ItemId.unsafe("a")) by Visitor else { expect false }'), r.text);
    assert.ok(r.text.endsWith("\t\tlet HttpResult.NoContent <- api.DELETE(\"/items/:id\", ItemId.unsafe(\"a\")) by Visitor else { expect false }\n\t}\n}\n"), r.text);
  });

  it("matches a redirect's Location as its payload", () => {
    const redirect = route({ method: "GET", path: "/go", responses: responses([302, "Found"]) });
    const { sc } = resolveAll(`@context shop

### go
GET /go

? status == 302
? header location == "/home"
`);
    const r = promote(sc, [{ route: redirect }], opts);
    assert.ok(r.ok);
    assert.ok(r.text.includes('let Found(v_go) <- api.GET("/go") by Visitor else { expect false }'), r.text);
    assert.ok(r.text.includes('expect v_go == "/home"'), r.text);
    assert.strictEqual(r.expressed, 2);
  });

  it("refuses a scenario that spans contexts, and one with nothing to call", () => {
    const other = route({ method: "GET", path: "/ping", unit: "billing" });
    const sc = parseScenario("@context shop\n\n### a\nGET /ping\n\n### b\nGET /ping\n");
    const spans = promote(sc, [{ route: PING }, { route: other }], opts);
    assert.ok(!spans.ok);
    assert.match(spans.reason, /spans shop and billing/);
    const none = promote(sc, [{ error: "No handler" }, { error: "No handler" }], opts);
    assert.ok(!none.ok);
    assert.match(none.reason, /nothing to call/);
    assert.strictEqual(none.unsupported.length, 2);
  });

  it("escapes strings, and refuses a query string it cannot type", () => {
    const { sc, resolved } = resolveAll(`@context shop

### q
GET /ping?limit=1

### s
PUT /items/a
Content-Type: application/json

{ "name": "a \\"b\\" \\\\(c)", "qty": 1 }
`);
    const r = promote(sc, resolved, opts);
    assert.ok(r.ok);
    assert.deepStrictEqual(r.unsupported.map((u) => u.step), ["q"]);
    assert.ok(r.text.includes('name: "a \\"b\\" \\\\(c)"'), r.text);
  });

  describe("typed literals and arguments", () => {
    const QTY: WcType = { name: "Qty", codecSuffix: "Qty", provenance: { kind: "Owned" }, loc: null, body: { kind: "Scalar", base: "Int", json: "Number", opaque: false, predicates: ["Positive"], baseGuards: ["Integral"], revalidation: "ViaConstructor" } };
    const SHAPE: WcType = { name: "Shape", codecSuffix: "Shape", provenance: { kind: "Owned" }, loc: null, body: { kind: "Sum", wireDiscriminant: "kind", memoryDiscriminant: "tag", variants: [] } };
    const BOX: WcType = {
      name: "Box",
      codecSuffix: "Box",
      provenance: { kind: "Owned" },
      loc: null,
      body: {
        kind: "Record",
        fields: [
          { name: "qty", shape: { kind: "Named", name: "Qty" }, pathSegment: "qty", default: null },
          { name: "tags", shape: { kind: "Inst", key: "L" }, pathSegment: "tags", default: null },
          { name: "note", shape: { kind: "Inst", key: "O" }, pathSegment: "note", default: null },
          { name: "ratio", shape: { kind: "Base", base: "Float", json: "Number", guards: [], expected: { kind: "Json", json: "Number" } } as never, pathSegment: "ratio", default: "1.0" },
          { name: "ok", shape: { kind: "Base", base: "Bool", json: "Boolean", guards: [], expected: { kind: "Json", json: "Boolean" } } as never, pathSegment: "ok", default: null },
        ],
      },
    };
    const insts = [
      { kind: "ListInst" as const, key: "L", elem: baseRef("String") },
      { kind: "OptionInst" as const, key: "O", inner: baseRef("String") },
    ];
    const types = [ITEM, ITEM_ID, QTY, SHAPE, BOX];
    const boxRoute = (params: { name: string; shape: unknown }[], path = "/boxes/:n", method: "POST" | "GET" = "POST", responses_ = responses([200, "Ok", true])): PromoteRoute =>
      route({ method, path, model: { envelope: { kind: "Keyed", params: params as never }, types, instantiations: insts }, responses: responses_ });
    const gen = (r: PromoteRoute, text: string) => {
      const sc = parseScenario(`@context shop\n\n${text}`);
      return promote(sc, sc.steps.map(() => ({ route: r })), opts);
    };
    const BODY = { name: "body", shape: { kind: "Named", name: "Box" } };
    const N = { name: "n", shape: { kind: "Named", name: "Qty" } };

    it("builds records, scalars, lists, options, floats and booleans", () => {
      const r = gen(boxRoute([N, BODY]), `### a\nPOST /boxes/7\nContent-Type: application/json\n\n{ "qty": 3, "tags": ["a"], "note": {"kind":"Some","value":"n"}, "ok": true }\n`);
      assert.ok(r.ok, JSON.stringify(r));
      assert.ok(r.text.includes('api.POST("/boxes/:n", 7, Box { qty: 3, tags: ["a"], note: Some("n"), ok: true })'), r.text);
      const none = gen(boxRoute([BODY]), `### a\nPOST /boxes/7\nContent-Type: application/json\n\n{ "qty": 3, "tags": [], "note": {"kind":"None"}, "ratio": 2, "ok": false }\n`);
      assert.ok(none.ok);
      assert.ok(none.text.includes("note: None") && none.text.includes("ratio: 2.0"), none.text);
    });

    it("lists a value it cannot spell, rather than guessing", () => {
      const bad = (body: string, why: RegExp) => {
        const r = gen(boxRoute([BODY]), `### a\nPOST /boxes/7\nContent-Type: application/json\n\n${body}\n\n### b\nPOST /boxes/7\nContent-Type: application/json\n\n{ "qty": 1, "tags": [], "note": {"kind":"None"}, "ok": true }\n`);
        assert.ok(r.ok, JSON.stringify(r));
        assert.match(r.unsupported[0].why, why);
      };
      bad('{ "tags": [], "note": {"kind":"None"}, "ok": true }', /needs "qty"/);
      bad('{ "qty": "x", "tags": [], "note": {"kind":"None"}, "ok": true }', /integer was expected/);
      bad('{ "qty": 1, "tags": "no", "note": {"kind":"None"}, "ok": true }', /needs a JSON array/);
      bad('{ "qty": 1, "tags": [], "note": 1, "ok": true }', /option needs/);
      bad('{ "qty": 1, "tags": [1], "note": {"kind":"None"}, "ok": true }', /string was expected/);
      bad('{ "qty": 1, "tags": [], "note": {"kind":"None"}, "ok": 1 }', /boolean was expected/);
      bad("[1]", /needs a JSON object/);
      bad("{ nope", /isn't valid JSON/);
    });

    it("refuses what has no literal: a sum, a missing type, a bytes or duration value", () => {
      const sum = boxRoute([{ name: "n", shape: { kind: "Named", name: "Shape" } }, BODY]);
      assert.match((gen(sum, "### a\nPOST /boxes/x\n") as { reason: string }).reason, /No step could be written/);
      const unknown = boxRoute([{ name: "n", shape: { kind: "Named", name: "Nope" } }]);
      assert.ok(!gen(unknown, "### a\nPOST /boxes/x\n").ok);
      const dur = boxRoute([{ name: "n", shape: { kind: "Base", base: "Duration", json: "Number", guards: [], expected: { kind: "Json", json: "Number" } } }]);
      assert.ok(!gen(dur, "### a\nPOST /boxes/1\n").ok);
      const bytes = boxRoute([{ name: "n", shape: { kind: "Bytes" } }]);
      assert.ok(!gen(bytes, "### a\nPOST /boxes/1\n").ok);
    });

    it("reads a path parameter's value by its type, and from captures and interpolation", () => {
      const idRoute = route({ method: "GET", path: "/items/:id", model: { envelope: { kind: "Bare", param: "id", shape: { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } } }, types, instantiations: insts } });
      const mk = (path: string) => gen(idRoute, `### a\nGET ${path}\n`);
      assert.ok(mk("/items/plain").ok && (mk("/items/plain") as { text: string }).text.includes('api.GET("/items/:id", "plain")'));
      const sc = parseScenario(`@context shop\n\n### first\nGET /items/1\n\n? status == 200\n? body.name == "n"\n\n### next\nGET /items/pre-{{first.body.name}}-post\n`);
      const r = promote(sc, [{ route: idRoute }, { route: idRoute }], opts);
      assert.ok(r.ok, JSON.stringify(r));
      assert.ok(r.text.includes('api.GET("/items/:id", "pre-\\(v_first.name)-post")'), r.text);
      const num = boxRoute([{ name: "n", shape: { kind: "Base", base: "Bool", json: "Boolean", guards: [], expected: { kind: "Json", json: "Boolean" } } }]);
      assert.ok((gen(num, "### a\nPOST /boxes/true\n") as { text: string }).text.includes('"/boxes/:n", true'));
    });

    it("sends other headers as RequestHeaders, in the route's parameter or trailing", () => {
      const withParam = boxRoute([{ name: "headers", shape: { kind: "Unchecked", reason: "Effect" } }], "/h", "GET");
      const a = gen(withParam, "### a\nGET /h\nAccept-Language: fr\nContent-Type: application/json\n");
      assert.ok(a.ok);
      assert.ok(a.text.includes('api.GET("/h", RequestHeaders.of(["Accept-Language: fr"]))'), a.text);
      const trailing = route({ method: "GET", path: "/h" });
      const b = gen(trailing, "### a\nGET /h\nX-Run: run-1\n");
      assert.ok(b.ok && b.text.includes('api.GET("/h", RequestHeaders.of(["X-Run: run-1"]))'), JSON.stringify(b));
      const sc = parseScenario("@context shop\n\n### one\nGET /h\n\n? status == 200\n? body == \"x\"\n\n### two\nGET /h\nX-Prev: {{one.body}}\n");
      const c = promote(sc, [{ route: trailing }, { route: trailing }], opts);
      assert.ok(c.ok, JSON.stringify(c));
      assert.ok(c.text.includes('RequestHeaders.of(["X-Prev: \\(v_one)"])'), c.text);
    });

    it("lists a step it cannot call: bad body, raw envelope, unknown parameter, no service", () => {
      const noBody = gen(boxRoute([BODY]), "### a\nPOST /boxes/1\n\n### b\nGET /h\n");
      assert.ok(!noBody.ok || noBody.unsupported.some((u) => /takes a body/.test(u.why)));
      const extraBody = gen(route({ method: "GET", path: "/h" }), "### a\nGET /h\nContent-Type: application/json\n\n{}\n");
      assert.ok(!extraBody.ok);
      const raw = route({ method: "POST", path: "/raw", model: { envelope: { kind: "Raw", param: "body", contentType: "text/csv" }, types, instantiations: [] } });
      assert.match(((gen(raw, "### a\nPOST /raw\n") as { unsupported: { why: string }[] }).unsupported[0]).why, /raw text\/csv body/);
      const query = boxRoute([{ name: "query", shape: { kind: "Unchecked", reason: "Effect" } }], "/q", "GET");
      assert.match(((gen(query, "### a\nGET /q\n") as { unsupported: { why: string }[] }).unsupported[0]).why, /no counterpart/);
      const noService = { ...route({ method: "GET", path: "/h" }), service: undefined };
      assert.match(((gen(noService, "### a\nGET /h\n") as { unsupported: { why: string }[] }).unsupported[0]).why, /did not name the service/);
    });
  });

  describe("assertions and captures", () => {
    const text = (r: ReturnType<typeof promote>): string => (r.ok ? r.text : JSON.stringify(r));
    const sc = (body: string) => parseScenario(`@context shop\n\n${body}`);
    const withResponses = (...rs: [number, string, boolean?][]) => route({ method: "GET", path: "/h", responses: responses(...rs) });

    it("compares a body value, an error message, a Location and a redirect with contains", () => {
      const ok = withResponses([200, "Ok", true]);
      const a = promote(sc('### a\nGET /h\n\n? status == 200\n? body.n != 3\n? body.f == 1.5\n? body.b == true\n? body == "x"\n'), [{ route: ok }], opts);
      assert.ok(a.ok);
      assert.ok(text(a).includes("expect v_a.n != 3") && text(a).includes("expect v_a.f == 1.5") && text(a).includes("expect v_a.b == true") && text(a).includes('expect v_a == "x"'), text(a));
      const conflict = withResponses([409, "Conflict"]);
      const b = promote(sc('### a\nGET /h\n\n? status == 409\n? body.error == "exists"\n? body.other == 1\n'), [{ route: conflict }], opts);
      assert.ok(b.ok);
      assert.ok(text(b).includes('expect v_a == "exists"'), text(b));
      assert.strictEqual(b.unsupported.length, 1);
      const redirect = withResponses([302, "Found"]);
      const c = promote(sc('### a\nGET /h\n\n? status == 302\n? header location contains "/home"\n? body.x == 1\n'), [{ route: redirect }], opts);
      assert.ok(c.ok);
      assert.ok(text(c).includes('expect v_a.contains("/home")'), text(c));
      assert.strictEqual(c.unsupported.length, 1);
    });

    it("lists the checks a typed field is needed for, a status with no variant and a bodyless answer", () => {
      const r = withResponses([200, "Ok", true], [204, "NoContent"]);
      const a = promote(sc('### a\nGET /h\n\n? status == 200\n? body.x exists\n? body.x absent\n? body.s contains "q"\n? body.xs[0] == 1\n? body == null\n? status != 500\n? status == 404\n'), [{ route: r }], opts);
      assert.ok(a.ok);
      assert.strictEqual(a.unsupported.length, 7);
      const none = promote(sc('### a\nGET /h\n\n? status == 204\n? body.x == 1\n'), [{ route: r }], opts);
      assert.ok(none.ok);
      assert.match(none.unsupported[0].why, /carries no body/);
      const set = promote(sc('### a\nGET /h\n\n? header set-cookie contains "sid"\n? header etag == "x"\n'), [{ route: r }], opts);
      assert.ok(set.ok);
      assert.match(set.unsupported.map((u) => u.why).join("\n"), /cookies a result sets/);
    });

    it("spells contains and exists once the response type is known (#160)", () => {
      const item = { kind: "Named" as const, name: "Item" };
      const typed = route({
        method: "GET",
        path: "/h",
        model: { envelope: { kind: "Empty" }, types: [ITEM, ITEM_ID], instantiations: [{ kind: "OptionInst", key: "Option<Int>", inner: baseRef("Int") }], success: item },
        responses: [{ status: 200, variant: "Ok", origin: { kind: "DeclaredSuccess" }, payload: item, body: { kind: "Value", ref: item } }],
      });
      const a = promote(sc('### a\nGET /h\n\n? status == 200\n? body.name contains "wid"\n? body.qty exists\n'), [{ route: typed }], opts);
      assert.ok(a.ok);
      assert.deepStrictEqual(a.unsupported, []);
      assert.ok(text(a).includes('expect v_a.name.contains("wid")'), text(a));
      assert.ok(text(a).includes("// ? body.qty exists: v_a.qty is required by its type"), text(a));
      assert.strictEqual(a.expressed, 3);
      // With no status expectation the declared success is the type.
      const b = promote(sc('### a\nGET /h\n? body.name contains "wid"\n'), [{ route: typed }], opts);
      assert.ok(b.ok && text(b).includes('expect v_a.name.contains("wid")'), text(b));
      // Still listed: a field that isn't a String, one that isn't there, `absent` of a required field.
      const c = promote(sc('### a\nGET /h\n\n? status == 200\n? body.qty contains "1"\n? body.nope exists\n? body.name absent\n? body.name contains 3\n'), [{ route: typed }], opts);
      assert.ok(c.ok);
      assert.strictEqual(c.unsupported.length, 4);
      assert.match(c.unsupported[0].why, /only for a String/);
      assert.match(c.unsupported[1].why, /no field `nope`/);
      assert.match(c.unsupported[2].why, /never absent/);
      assert.match(c.unsupported[3].why, /takes a string/);
    });

    it("binds only what a later step reads, and refuses a capture it cannot spell", () => {
      const r = withResponses([200, "Ok", true]);
      const redirect = withResponses([302, "Found"]);
      const two = (second: string) => promote(sc(`### a\nGET /h\n\n? status == 200\n\n### b\nGET /h\n${second}\n`), [{ route: r }, { route: r }], opts);
      assert.ok(two("X: {{a.body.x}}").ok && (two("X: {{a.body.x}}") as { text: string }).text.includes("let Ok(v_a) <-"));
      const why = (header: string) => {
        const g = two(header);
        assert.ok(g.ok, JSON.stringify(g));
        return g.unsupported.map((u) => u.why).join("\n");
      };
      assert.match(why("X: {{a.status}}"), /can't be read as a value/);
      assert.match(why("X: {{a.header.etag}}"), /can't be read/);
      assert.match(why("X: {{a.body.xs[0]}}"), /list index/);
      assert.match(why("X: {{z.body.x}}"), /not in the suite/);
      assert.match(why("X: {{env.A}}"), /reads the environment/);
      const body = promote(sc('### a\nGET /h\n\n? status == 302\n\n### b\nGET /h\nX: {{a.header.location}}\n\n### c\nGET /h\nX: {{a.body.x}}\n'), [{ route: redirect }, { route: r }, { route: r }], opts);
      assert.ok(body.ok);
      assert.ok(body.text.includes("X: \\(v_a)"), body.text);
      assert.match(body.unsupported[0].why, /carries no body|only `error`|did not bind|redirect/);
      const msg = promote(sc('### a\nGET /h\n\n? status == 409\n\n### b\nGET /h\nX: {{a.body.error}}\n\n### c\nGET /h\nX: {{a.body.other}}\n'), [{ route: withResponses([409, "Conflict"]) }, { route: r }, { route: r }], opts);
      assert.ok(msg.ok);
      assert.ok(msg.text.includes("X: \\(v_a)") && msg.unsupported.some((u) => /only `error`/.test(u.why)), msg.text);
      const none = promote(sc('### a\nGET /h\n\n? status == 204\n\n### b\nGET /h\nX: {{a.body.x}}\n'), [{ route: withResponses([204, "NoContent"]) }, { route: r }], opts);
      assert.ok(none.ok && /carries no body/.test(none.unsupported[0].why), JSON.stringify(none));
      const tuple = promote(sc('### a\nGET /h\n\n? status == 200\n'), [{ route: withResponses([200, "Raw", true]) }], opts);
      assert.ok(!tuple.ok);
    });

    it("lists a body capture it cannot spell and an unnamed service, and summarises many gaps", () => {
      const r = withResponses([200, "Ok", true]);
      const many = Array.from({ length: 10 }, (_, i) => `### s${i}\nGET /h\nX: {{env.E${i}}}\n`).join("\n");
      const sc10 = parseScenario(`@context shop\n\n### ok\nGET /h\n\n${many}`);
      const p = promote(sc10, sc10.steps.map(() => ({ route: r })), opts);
      assert.ok(p.ok);
      assert.match(summarise(p), /…and 2 more/);
      const clean = promote(sc("### a\nGET /h\n"), [{ route: r }], opts);
      assert.ok(clean.ok);
      assert.ok(!/could not be expressed/.test(summarise(clean)));
      assert.ok(!clean.text.includes("Not expressed"));
    });
  });
});
