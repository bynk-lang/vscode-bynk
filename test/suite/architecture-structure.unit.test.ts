// Model-diagrams slice 4: the architecture map as a structure diagram. The
// adapter (ArchModel → IR), `consumes` cycle detection, and the ELK layout,
// with a fixed-width text measurer. Pure: no DOM.

import * as assert from "assert";

import { fixedMeasurer } from "../../src/diagram/measure";
import { consumesCycles, toArchitectureDiagram } from "../../src/diagram/structure/architecture";
import type { StructDiagram, StructNode } from "../../src/diagram/structure/ir";
import { layoutStructure } from "../../src/diagram/structure/layout";
import type { ArchModel } from "../../src/webview/architectureTypes";

const L = (f: string, line: number) => ({ uri: `file:///p/${f}.bynk`, range: { start: { line, character: 0 }, end: { line, character: 4 } } });
const member = (unit: string, kind: "service" | "agent" | "provider", container: string, line: number) => ({
  unit,
  kind,
  container,
  handler: "POST /x",
  loc: L(unit, line),
});

function model(): ArchModel {
  return {
    nodes: [
      {
        name: "shop",
        kind: "Context",
        loc: L("shop", 0),
        capabilities: [{ name: "Clock", local: false, from: "bynk", loc: L("shop", 2) }],
        providers: [],
        services: [{ name: "web", handlerCount: 3, loc: L("shop", 5), protocol: "http", actors: ["Visitor"] }],
        agents: [{ name: "Cart", handlerCount: 2, loc: L("shop", 20) }],
        uses: [
          {
            member: member("shop", "service", "web", 7),
            uses: [{ capability: "Clock", from: "bynk", inherited: false, loc: L("shop", 7), stubbedIn: [] }],
          },
        ],
      },
      {
        name: "billing",
        kind: "Context",
        loc: L("billing", 0),
        capabilities: [{ name: "Ledger", local: true, from: null, loc: L("billing", 3) }],
        providers: [],
        services: [{ name: "Charges", handlerCount: 1, loc: L("billing", 9), protocol: "call", actors: [] }],
        agents: [],
        uses: [],
      },
      { name: "notify", kind: "Context", loc: L("notify", 0), capabilities: [], providers: [], services: [], agents: [], uses: [] },
    ],
    edges: [
      { from: "shop", to: "billing", capabilities: [], loc: L("shop", 1) },
      { from: "billing", to: "shop", capabilities: ["Orders"], loc: L("billing", 1) },
    ],
    events: [
      {
        owner: "shop",
        name: "OrderPlaced",
        loc: L("shop", 30),
        emitters: [{ member: member("shop", "service", "web", 7), loc: L("shop", 8) }],
        subscribers: [{ member: member("notify", "service", "mailer", 4), delivery: "all", loc: L("notify", 4) }],
      },
    ],
  };
}

const all = (d: StructDiagram): StructNode[] => {
  const out: StructNode[] = [];
  const walk = (ns: StructNode[]): void => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(d.nodes);
  return out;
};
const node = (d: StructDiagram, id: string): StructNode | undefined => all(d).find((n) => n.ref.id === id);
const edgeKeys = (d: StructDiagram): string[] => d.edges.map((e) => `${e.kind}:${e.source}->${e.target}${e.label ? `[${e.label}]` : ""}`);

describe("architecture structure (adapter)", () => {
  it("puts the project's units in a system boundary, actors and platforms outside", () => {
    const d = toArchitectureDiagram(model(), { expanded: new Set(), events: true });
    assert.deepStrictEqual(d.nodes.map((n) => n.ref.id), ["actor:Visitor", "system", "x:bynk"]);
    const boundary = d.nodes[1];
    assert.deepStrictEqual(boundary.children.map((n) => n.ref.id), ["u:shop", "u:billing", "u:notify", "ev:shop/OrderPlaced"]);
  });

  it("summarises a closed unit and opens it in place around its members", () => {
    const closed = toArchitectureDiagram(model(), { expanded: new Set(), events: true });
    assert.strictEqual(node(closed, "u:shop")?.detail, "http · 1 service · 1 agent");
    assert.strictEqual(node(closed, "u:billing")?.detail, "1 service · 1 capability");
    assert.strictEqual(node(closed, "u:notify")?.expandable, false, "nothing to open");
    const open = toArchitectureDiagram(model(), { expanded: new Set(["shop"]), events: true });
    const shop = node(open, "u:shop");
    assert.ok(shop?.expanded);
    assert.deepStrictEqual(shop.children.map((c) => [c.ref.id, c.stereotype]), [
      ["svc:shop/web", "http service"],
      ["agent:shop/Cart", "agent"],
    ]);
  });

  it("draws consumes, actor calls, platform wiring and events, attached to members when open", () => {
    const closed = toArchitectureDiagram(model(), { expanded: new Set(), events: true });
    assert.deepStrictEqual(edgeKeys(closed), [
      "consumes:u:shop->u:billing",
      "consumes:u:billing->u:shop[Orders]",
      "wires:u:shop->x:bynk[Clock]",
      "calls:actor:Visitor->u:shop[http]",
      "emits:u:shop->ev:shop/OrderPlaced",
      "subscribes:ev:shop/OrderPlaced->u:notify",
    ]);
    const open = toArchitectureDiagram(model(), { expanded: new Set(["shop"]), events: true });
    const keys = edgeKeys(open);
    assert.ok(keys.includes("wires:svc:shop/web->x:bynk[Clock]"));
    assert.ok(keys.includes("calls:actor:Visitor->svc:shop/web[http]"));
    assert.ok(keys.includes("emits:svc:shop/web->ev:shop/OrderPlaced"));
  });

  it("leaves events out when they are switched off", () => {
    const d = toArchitectureDiagram(model(), { expanded: new Set(), events: false });
    assert.ok(!node(d, "ev:shop/OrderPlaced"));
    assert.ok(d.edges.every((e) => e.kind !== "emits" && e.kind !== "subscribes"));
  });

  it("marks a consumes cycle on its units and edges", () => {
    const d = toArchitectureDiagram(model(), { expanded: new Set(), events: true });
    assert.ok(node(d, "u:shop")?.cycle && node(d, "u:billing")?.cycle);
    assert.ok(!node(d, "u:notify")?.cycle);
    assert.ok(d.edges.filter((e) => e.kind === "consumes").every((e) => e.cycle));
  });

  it("draws an older server's model: platform wiring from capabilities, no actors or events", () => {
    const m = model();
    delete m.events;
    for (const n of m.nodes) {
      delete n.uses;
      for (const s of n.services) {
        delete s.protocol;
        delete s.actors;
      }
    }
    const d = toArchitectureDiagram(m, { expanded: new Set(), events: true });
    assert.deepStrictEqual(d.nodes.map((n) => n.ref.id), ["system", "x:bynk"]);
    assert.ok(edgeKeys(d).includes("wires:u:shop->x:bynk[Clock]"));
    assert.strictEqual(node(d, "u:shop")?.detail, "1 service · 1 agent");
  });
});

describe("consumesCycles", () => {
  it("finds a cycle, a self-loop, and nothing in a chain", () => {
    const base = model();
    assert.deepStrictEqual([...consumesCycles(base).units].sort(), ["billing", "shop"]);
    base.edges = [{ from: "shop", to: "billing", capabilities: [], loc: L("shop", 1) }];
    assert.strictEqual(consumesCycles(base).units.size, 0);
    base.edges.push({ from: "notify", to: "notify", capabilities: [], loc: L("notify", 1) });
    assert.deepStrictEqual([...consumesCycles(base).units], ["notify"]);
  });
});

describe("architecture structure (ELK layout)", function () {
  this.timeout(20_000);
  const measure = fixedMeasurer();

  it("nests units in the boundary and members in their unit, and routes every edge", async () => {
    const d = toArchitectureDiagram(model(), { expanded: new Set(["shop"]), events: true });
    const scene = await layoutStructure(d, measure);
    const box = (id: string) => scene.nodes.find((p) => p.node.ref.id === id)?.box;
    const inside = (inner: string, outer: string): void => {
      const a = box(inner);
      const b = box(outer);
      assert.ok(a && b, `${inner} and ${outer} placed`);
      assert.ok(a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5, `${inner} inside ${outer}`);
    };
    inside("u:shop", "system");
    inside("svc:shop/web", "u:shop");
    inside("agent:shop/Cart", "u:shop");
    const actor = box("actor:Visitor");
    const system = box("system");
    assert.ok(actor && system && actor.x + actor.w <= system.x, "the actor is outside, to the left");
    assert.strictEqual(scene.edges.length, d.edges.length);
    for (const e of scene.edges) assert.ok(e.points.length >= 2, `${e.edge.ref.id} is routed`);
    assert.ok(scene.edges.some((e) => e.label?.text === "Clock"));
    assert.ok(scene.width > 0 && scene.height > 0);
  });

  it("is deterministic", async () => {
    const d = toArchitectureDiagram(model(), { expanded: new Set(), events: true });
    const a = await layoutStructure(d, measure);
    const b = await layoutStructure(d, measure);
    assert.deepStrictEqual(
      a.nodes.map((n) => [n.node.ref.id, n.box]),
      b.nodes.map((n) => [n.node.ref.id, n.box]),
    );
  });
});
