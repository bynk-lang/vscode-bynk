// Model-diagrams slice 5: the component view. The adapter (one unit of the
// architecture model → structure IR with parts, compartments and ports), the
// unit a file belongs to, the ELK layout of ports, and the page messages.
// Pure: no DOM.

import * as assert from "assert";

import { fixedMeasurer } from "../../src/diagram/measure";
import { componentIds, toComponentDiagram, unitOfUri } from "../../src/diagram/structure/component";
import type { StructDiagram, StructNode } from "../../src/diagram/structure/ir";
import { layoutStructure } from "../../src/diagram/structure/layout";
import { isAllowedScheme, isOpenComponent } from "../../src/sequenceMessages";
import { componentModel, L } from "./componentFixture";

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
const find = (d: StructDiagram, id: string): StructNode | undefined => all(d).find((n) => n.ref.id === id);
const edgeKeys = (d: StructDiagram): string[] => d.edges.map((e) => `${e.kind}:${e.source}->${e.target}${e.label ? `[${e.label}]` : ""}`);

describe("component view (adapter)", () => {
  it("finds the unit a file belongs to", () => {
    const m = componentModel();
    assert.strictEqual(unitOfUri(m, "file:///p/shop.bynk"), "shop");
    assert.strictEqual(unitOfUri(m, "file:///p/stripe.bynk"), "stripe");
    assert.strictEqual(unitOfUri(m, "file:///p/elsewhere.bynk"), null);
    assert.strictEqual(toComponentDiagram(m, "nowhere"), null);
  });

  it("opens the context around its parts, callers left, providers right", () => {
    const view = toComponentDiagram(componentModel(), "shop");
    assert.ok(view);
    const d = view.diagram;
    assert.deepStrictEqual(d.nodes.map((n) => n.ref.id), ["actor:Visitor", "u:billing", "u:shop", "x:bynk", "u:stripe", "u:audit"]);
    const shop = find(d, "u:shop");
    assert.ok(shop?.expanded && !shop.muted);
    assert.deepStrictEqual(shop.children.map((c) => [c.ref.id, c.stereotype]), [
      ["svc:shop/web", "http service"],
      ["svc:shop/orders", "service"],
      ["agent:shop/Cart", "agent"],
      ["prov:shop/Ledger", "provider"],
    ]);
    for (const id of ["u:billing", "u:stripe", "u:audit", "x:bynk"]) assert.ok(find(d, id)?.muted, `${id} is drawn in grey`);
    assert.ok(find(d, "u:billing")?.opens && !find(d, "x:bynk")?.opens, "only project units open their own view");
  });

  it("lists operations, and an agent's key and state, in compartments", () => {
    const view = toComponentDiagram(componentModel(), "shop");
    assert.ok(view);
    const items = (id: string) => find(view.diagram, id)?.items?.map((i) => [i.text, i.role]);
    assert.deepStrictEqual(items("svc:shop/web"), [
      ["POST /checkout", "operation"],
      ["GET /cart", "operation"],
    ]);
    assert.deepStrictEqual(items("agent:shop/Cart"), [
      ["key owner: CustomerId", "attribute"],
      ["store lines, total", "attribute"],
      ["add", "operation"],
      ["view", "operation"],
    ]);
    assert.deepStrictEqual(items("prov:shop/Ledger"), [["post", "operation"]]);
    // A service or agent operation opens its sequence diagram; a provider's has none.
    const op = componentIds.operation("shop", "web", "POST /checkout");
    assert.deepStrictEqual(view.links.sequences.get(op), L("shop", 7));
    assert.ok(!view.links.sequences.has(componentIds.operation("shop", "MemLedger", "post")));
    assert.deepStrictEqual([...view.links.components.entries()], [
      ["u:billing", "billing"],
      ["u:stripe", "stripe"],
      ["u:audit", "audit"],
    ]);
  });

  it("puts a provided port per service and a required port per outside need", () => {
    const view = toComponentDiagram(componentModel(), "shop");
    assert.ok(view);
    const ports = find(view.diagram, "u:shop")?.ports?.map((p) => [p.name, p.kind]);
    assert.deepStrictEqual(ports, [
      ["web · http", "provided"],
      ["orders", "provided"],
      ["Clock", "required"],
      ["Payments", "required"],
      ["billing.Charges", "required"],
      // A `consumes` with no call or capability through it still needs a port.
      ["audit", "required"],
    ]);
  });

  it("delegates ports to parts, wires neighbours to ports, and joins parts inside", () => {
    const view = toComponentDiagram(componentModel(), "shop");
    assert.ok(view);
    const keys = edgeKeys(view.diagram);
    const pp = componentIds.provided("shop", "web");
    const clock = componentIds.requiredCapability("shop", "bynk", "Clock");
    const charges = componentIds.requiredService("shop", "billing", "Charges");
    for (const k of [
      `delegates:${pp}->svc:shop/web`,
      `delegates:svc:shop/web->${clock}`,
      `delegates:svc:shop/web->${charges}`,
      "invokes:svc:shop/web->agent:shop/Cart[add, view]",
      "invokes:svc:shop/web->prov:shop/Ledger[Ledger]",
      `assembly:actor:Visitor->${pp}`,
      // billing calls `shop.orders`: wired to that port, not to the whole context.
      `assembly:u:billing->${componentIds.provided("shop", "orders")}`,
      `assembly:${clock}->x:bynk`,
      `assembly:${charges}->u:billing`,
      `assembly:${componentIds.requiredUnit("shop", "audit")}->u:audit`,
    ]) {
      assert.ok(keys.includes(k), `has ${k}\n${keys.join("\n")}`);
    }
    assert.ok(!keys.some((k) => k.startsWith("assembly:u:billing->u:shop")));
  });

  it("draws no edge to a member the declarations no longer have (a model mid-edit)", () => {
    const m = componentModel();
    m.nodes[0].services = m.nodes[0].services.filter((s) => s.name !== "web");
    const view = toComponentDiagram(m, "shop");
    assert.ok(view);
    const ids = new Set(all(view.diagram).map((n) => n.ref.id));
    for (const p of find(view.diagram, "u:shop")?.ports ?? []) ids.add(p.ref.id);
    for (const e of view.diagram.edges) assert.ok(ids.has(e.source) && ids.has(e.target), e.ref.id);
  });

  it("draws an older server's model: no operations, ports from capabilities and edges", () => {
    const m = componentModel();
    for (const n of m.nodes) {
      delete n.uses;
      for (const a of n.agents) {
        delete a.key;
        delete a.state;
      }
    }
    const view = toComponentDiagram(m, "shop");
    assert.ok(view);
    const shop = find(view.diagram, "u:shop");
    assert.strictEqual(find(view.diagram, "svc:shop/web")?.detail, "2 handlers");
    assert.deepStrictEqual(find(view.diagram, "agent:shop/Cart")?.items, []);
    assert.deepStrictEqual(shop?.ports?.filter((p) => p.kind === "required").map((p) => p.name), ["Clock", "Payments", "billing", "audit"]);
    // With no calls to say which service, a consumer wires to the context.
    assert.ok(edgeKeys(view.diagram).includes("assembly:u:billing->u:shop"));
  });
});

describe("component view (ELK layout)", function () {
  this.timeout(20_000);

  it("puts provided ports on the left border and required ones on the right, and routes every edge", async () => {
    const view = toComponentDiagram(componentModel(), "shop");
    assert.ok(view);
    const scene = await layoutStructure(view.diagram, fixedMeasurer());
    const shop = scene.nodes.find((p) => p.node.ref.id === "u:shop");
    assert.ok(shop);
    assert.strictEqual(shop.ports.length, 6);
    for (const p of shop.ports) {
      const cx = p.box.x + p.box.w / 2;
      const border: number = p.port.kind === "provided" ? shop.box.x : shop.box.x + shop.box.w;
      assert.strictEqual(p.side, p.port.kind === "provided" ? "left" : "right", p.port.name);
      assert.ok(Math.abs(cx - border) <= 1, `${p.port.name} straddles its border (${cx} vs ${border})`);
      assert.ok(p.label.w > 0, `${p.port.name} has a label`);
    }
    const web = scene.nodes.find((p) => p.node.ref.id === "svc:shop/web");
    assert.ok(web && web.box.h >= 2 * 10 + 2 * 16 + 8 + 2 * 16, "the compartment adds height");
    assert.strictEqual(scene.edges.length, view.diagram.edges.length);
    for (const e of scene.edges) assert.ok(e.points.length >= 2, `${e.edge.ref.id} is routed`);
  });
});

describe("isAllowedScheme (review of #177)", () => {
  it("lets a local file or a workspace folder's scheme through, and nothing else", () => {
    assert.ok(isAllowedScheme("file:///p/shop.bynk", []));
    assert.ok(isAllowedScheme("/p/shop.bynk", []), "no scheme parses as file");
    assert.ok(isAllowedScheme("vscode-vfs://github/x/shop.bynk", ["vscode-vfs"]));
    assert.ok(isAllowedScheme("FILE:///p/shop.bynk", []), "schemes are case-insensitive");
    assert.ok(!isAllowedScheme("command:workbench.action.quit", []));
    assert.ok(!isAllowedScheme("https://example.com/x.bynk", ["file"]));
    assert.ok(!isAllowedScheme("vscode-vfs://github/x/shop.bynk", []));
  });
});

describe("openComponent message", () => {
  const R = { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } };
  it("accepts a uri with or without a range, and nothing else", () => {
    assert.ok(isOpenComponent({ type: "openComponent", uri: "file:///x.bynk" }));
    assert.ok(isOpenComponent({ type: "openComponent", uri: "file:///x.bynk", range: R }));
    assert.ok(!isOpenComponent({ type: "openComponent", uri: "" }));
    assert.ok(!isOpenComponent({ type: "openComponent", uri: "file:///x.bynk", range: { start: 1 } }));
    assert.ok(!isOpenComponent({ type: "openSequence", uri: "file:///x.bynk", range: R }));
  });
});
