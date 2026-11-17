// #146: the Impact view's join, over hand-built inputs.

import * as assert from "assert";

import { clientConfig, type ImpactInput, impactOf, type WireSite } from "../../src/impactCore";
import { wireCarries } from "../../src/wireDiffCore";
import type { ArchLoc, ArchMember, ArchModel, ArchNode } from "../../src/webview/architectureTypes";
import type { CdModel } from "../../src/webview/contractDiffTypes";
import type { Range } from "../../src/webview/types";
import type { WcBody, WcField, WcHttpResponse, WcModel, WcRef } from "../../src/webview/wireContractTypes";

const rng = (line: number, end = line): Range => ({ start: { line, character: 0 }, end: { line: end, character: 5 } });
const loc = (uri: string, line = 0): ArchLoc => ({ uri, range: rng(line) });
const member = (unit: string, kind: ArchMember["kind"], container: string, handler: string): ArchMember => ({
  unit, kind, container, handler, loc: loc(`file:///${unit}.bynk`, 3),
});
const node = (name: string, over: Partial<ArchNode> = {}): ArchNode => ({
  name, kind: "Context", loc: loc(`file:///${name}.bynk`), capabilities: [], providers: [], services: [], agents: [], ...over,
});

const place = member("shop", "service", "Orders", "POST /orders");
function model(): ArchModel {
  return {
    nodes: [
      node("shop", { services: [{ name: "Orders", handlerCount: 1, loc: loc("file:///shop.bynk"), protocol: "http" }], uses: [{ member: place, uses: [], calls: [] }] }),
      node("billing", { uses: [{ member: member("billing", "agent", "Ledger", "charge"), uses: [], calls: [{ kind: "service", unit: "shop", container: "Orders", loc: loc("file:///billing.bynk", 9) }] }] }),
      node("web", { kind: "Adapter" }),
    ],
    edges: [
      { from: "billing", to: "shop", capabilities: [], loc: loc("file:///billing.bynk") },
      { from: "web", to: "shop", capabilities: [], loc: loc("file:///web.bynk") },
    ],
    events: [
      {
        owner: "shop", name: "Order", loc: loc("file:///shop.bynk", 1),
        emitters: [{ member: place, loc: loc("file:///shop.bynk", 4) }],
        subscribers: [{ member: member("billing", "agent", "Ledger", "on Order"), delivery: "queue", loc: loc("file:///billing.bynk", 12) }],
      },
    ],
  };
}

const wire = (over: Partial<WireSite> = {}): WireSite => ({
  unit: "shop", service: "Orders", label: "POST /orders", boundary: "Http", loc: loc("file:///shop.bynk", 3), carries: { request: true, response: false }, ...over,
});

function input(over: Partial<ImpactInput> = {}): ImpactInput {
  return {
    name: "Order",
    declaringUnit: "shop",
    references: [],
    unitOf: {},
    model: model(),
    wires: [],
    contract: { lock: "read", ledger: "read", changes: [], services: [] },
    testCases: {},
    client: { configured: false, services: [] },
    ...over,
  };
}

describe("impactOf (#146)", () => {
  it("groups the references by the other units they lie in, leaving out the declaring unit's own and the tests'", () => {
    const a = impactOf(input({
      references: [
        { uri: "file:///shop.bynk", range: rng(2) },
        { uri: "file:///billing.bynk", range: rng(5) },
        { uri: "file:///billing.bynk", range: rng(8) },
        { uri: "file:///shop.test.bynk", range: rng(1) },
      ],
      unitOf: {
        "file:///shop.bynk": { name: "shop", kind: "context" },
        "file:///billing.bynk": { name: "billing", kind: "context" },
        "file:///shop.test.bynk": { name: "shop", kind: "test" },
      },
    }));
    const billing = a.units.find((u) => u.unit === "billing")!;
    assert.deepStrictEqual(billing.rows.map((r) => r.label), ["billing.bynk:6", "billing.bynk:9"]);
    assert.ok(billing.why.includes("mentions it"));
    assert.ok(!a.units.some((u) => u.unit === "shop"));
    assert.strictEqual(a.tests.length, 1);
  });

  it("adds the units that consume the declaring unit, and the handlers that call a service", () => {
    const a = impactOf(input({ name: "Orders" }));
    assert.deepStrictEqual(a.units.map((u) => [u.unit, u.kind]), [["billing", "context"], ["web", "adapter"]]);
    const billing = a.units.find((u) => u.unit === "billing")!;
    assert.deepStrictEqual(billing.why, ["consumes shop", "calls shop.Orders"]);
    assert.deepStrictEqual(billing.rows.map((r) => [r.label, r.description]), [["billing.Ledger.charge", "calls it"]]);
    assert.deepStrictEqual(a.units.find((u) => u.unit === "web")!.rows, []);
  });

  it("says so when the server sends no calls", () => {
    const m = model();
    for (const n of m.nodes) for (const h of n.uses ?? []) delete h.calls;
    assert.ok(impactOf(input({ name: "Orders", model: m })).notes.some((n) => n.includes("v0.634.4")));
  });

  it("lists an event's emitters and subscribers", () => {
    const a = impactOf(input());
    assert.deepStrictEqual(a.event?.emitters.map((r) => r.label), ["shop.Orders.POST /orders"]);
    assert.deepStrictEqual(a.event?.subscribers.map((r) => [r.label, r.description]), [["billing.Ledger.on Order", "queue"]]);
    assert.strictEqual(impactOf(input({ name: "Money" })).event, undefined);
  });

  it("lists the wire contracts that carry it, and the contract diff's view of the boundary", () => {
    const contract: CdModel = {
      lock: "read", ledger: "read",
      changes: [{ kind: "event", unit: "shop", name: "Order", class: "breaking", lockedVersion: 2, detail: "field removed", loc: loc("file:///shop.bynk", 1) }],
      services: [
        { environment: "prod", context: "shop", service: "Orders", status: "changed", live: "a", current: "b", compat: { verdict: "breaking", reasons: ["x"] }, loc: null },
        { environment: "prod", context: "billing", service: "Other", status: "changed", live: "a", current: "b", loc: null },
      ],
    };
    const a = impactOf(input({ wires: [wire({ carries: { request: true, response: true } }), wire({ label: "GET /o", carries: { request: false, response: true } })], contract }));
    assert.deepStrictEqual(a.boundary.wire.map((r) => [r.label, r.description]), [
      ["shop.Orders: POST /orders", "request and response"],
      ["shop.Orders: GET /o", "response"],
    ]);
    assert.deepStrictEqual(a.boundary.changes.map((r) => [r.label, r.description]), [["event shop.Order", "breaking: field removed"]]);
    assert.deepStrictEqual(a.boundary.deployed.map((r) => [r.label, r.description]), [["prod: shop.Orders", "changed, breaking"]]);
  });

  it("says the contract diff could not be read, rather than that nothing changed", () => {
    const a = impactOf(input({ contract: null }));
    assert.ok(a.notes.some((n) => n.includes("contract diff could not be read")));
  });

  it("lists the carrying HTTP routes of the client, narrowed to the services it names", () => {
    const wires = [wire(), wire({ service: "Admin", label: "GET /a" }), wire({ boundary: "Call", label: "call" })];
    assert.deepStrictEqual(impactOf(input({ wires, client: { configured: false, services: [] } })).client, { configured: false, routes: [] });
    const all = impactOf(input({ wires, client: { configured: true, services: [] } })).client;
    assert.deepStrictEqual(all.routes.map((r) => r.label), ["shop.Orders: POST /orders", "shop.Admin: GET /a"]);
    const some = impactOf(input({ wires, client: { configured: true, services: ["shop.Admin"] } })).client;
    assert.deepStrictEqual(some.routes.map((r) => r.label), ["shop.Admin: GET /a"]);
  });

  it("names the test case that holds a reference, else the file", () => {
    const a = impactOf(input({
      references: [{ uri: "file:///t.bynk", range: rng(7) }, { uri: "file:///t.bynk", range: rng(30) }],
      unitOf: { "file:///t.bynk": { name: "shop", kind: "test" } },
      testCases: { "file:///t.bynk": [{ name: "places an order", range: rng(5, 10) }] },
    }));
    assert.deepStrictEqual(a.tests.map((r) => [r.label, r.description]), [["shop: places an order", undefined], ["shop: t.bynk:31", "outside any case"]]);
  });
});

describe("clientConfig (#146)", () => {
  it("finds [build.client] and the services it selects", () => {
    assert.deepStrictEqual(clientConfig('[project]\nname = "p"\n'), { configured: false, services: [] });
    assert.deepStrictEqual(clientConfig('[build.client]\nout = "c.ts"\n'), { configured: true, services: [] });
    assert.deepStrictEqual(clientConfig('[build.client]\nservice = "Orders"\n[other]\nservice = "no"\n'), { configured: true, services: ["Orders"] });
    assert.deepStrictEqual(clientConfig('[ build . client ]\nservices = ["A", \'shop.B\'] # note\n').services, ["A", "shop.B"]);
  });
});

describe("wireCarries (#146)", () => {
  const STR: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
  const record = (name: string, fields: WcField[]) => ({
    name, codecSuffix: name, provenance: { kind: "Owned" as const }, body: { kind: "Record", fields } as WcBody, loc: null,
  });
  const f = (name: string, shape: WcRef): WcField => ({ name, shape, pathSegment: name, default: null });
  const base = (over: Partial<WcModel>): WcModel => ({
    unit: "shop", service: "Orders", kind: { kind: "Http", method: "POST", path: "/o" }, range: rng(1), handlerLine: 1,
    envelope: { kind: "Empty" }, contract: null, types: [], instantiations: [], recursive: [], responses: [], noCrossContext: null, ...over,
  });
  const ok = (ref: WcRef): WcHttpResponse => ({ status: 200, variant: "Ok", origin: { kind: "DeclaredSuccess" }, payload: ref, body: { kind: "Value", ref } });

  it("tells the request from the response of an HTTP handler, through nested fields", () => {
    const types = [record("Order", [f("line", { kind: "Named", name: "Line" })]), record("Line", [f("sku", STR)]), record("Receipt", [f("id", STR)])];
    const m = base({
      types,
      envelope: { kind: "Bare", param: "o", shape: { kind: "Named", name: "Order" } },
      success: { kind: "Named", name: "Receipt" },
      responses: [ok({ kind: "Named", name: "Receipt" })],
    });
    assert.deepStrictEqual(wireCarries(m, "Order"), { request: true, response: false });
    assert.deepStrictEqual(wireCarries(m, "Line"), { request: true, response: false }, "reached through a field");
    assert.deepStrictEqual(wireCarries(m, "Receipt"), { request: false, response: true });
    assert.deepStrictEqual(wireCarries(m, "Nothing"), { request: false, response: false });
    assert.deepStrictEqual(wireCarries(m, "shop.Receipt"), { request: false, response: false }, "a qualified query names a qualified type");
  });

  it("finds a type in both directions, and infers an `on call` handler's response", () => {
    const both = base({
      types: [record("Item", [f("n", STR)])],
      envelope: { kind: "Bare", param: "i", shape: { kind: "Named", name: "Item" } },
      responses: [ok({ kind: "Named", name: "Item" })],
      success: { kind: "Named", name: "Item" },
    });
    assert.deepStrictEqual(wireCarries(both, "Item"), { request: true, response: true });
    const call = base({ kind: { kind: "Call" }, types: [record("Out", [f("n", STR)])] });
    assert.deepStrictEqual(wireCarries(call, "Out"), { request: false, response: true });
    const cron = base({ kind: { kind: "Cron", expr: "* * * * *" }, types: [record("Out", [f("n", STR)])] });
    assert.deepStrictEqual(wireCarries(cron, "Out"), { request: false, response: false });
  });
});
