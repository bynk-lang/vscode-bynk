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
});
