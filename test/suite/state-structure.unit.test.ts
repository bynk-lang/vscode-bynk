// Model-diagrams slice 6: the agent state machine and the model diff on the
// diagram engine. The state adapter (UML state machine notation over the
// shared transition grouping), its top-to-bottom ELK layout, and the
// architecture adapter's diff marks. Pure: no DOM.

import * as assert from "assert";

import { fixedMeasurer } from "../../src/diagram/measure";
import { toArchitectureDiagram } from "../../src/diagram/structure/architecture";
import type { StructDiagram, StructNode } from "../../src/diagram/structure/ir";
import { layoutStructure } from "../../src/diagram/structure/layout";
import { stateIds, toStateDiagram } from "../../src/diagram/structure/stateMachine";
import { mergeArchitecture } from "../../src/modelDiffGraphCore";
import type { ArchModel, ArchNode } from "../../src/webview/architectureTypes";
import type { StateEdge, StateMachine } from "../../src/webview/stateTypes";

const R = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 4 } });
const URI = "file:///agent.bynk";

const edge = (handler: string, from: string[], to: StateEdge["to"], line: number, over: Partial<StateEdge> = {}): StateEdge => ({
  handler,
  from,
  guards: [],
  to,
  outcome: null,
  range: R(line),
  violations: [],
  ...over,
});

function machine(): StateMachine {
  return {
    field: "status",
    fieldRange: R(2),
    states: ["Open", "Paid", "Closed", "Lost"],
    initial: "Open",
    edges: [
      edge("pay", ["Open"], { kind: "State", state: "Paid" }, 10, { guards: ["amount > 0"] }),
      edge("settle", ["Open"], { kind: "State", state: "Paid" }, 14),
      edge("close", ["Paid"], { kind: "State", state: "Closed" }, 18, {
        violations: [{ transition: "noReopen", range: R(30), certainty: "Known", from: ["Paid"], targets: ["Closed"] }],
      }),
      edge("guess", ["Open"], { kind: "Unknown" }, 22),
      edge("peek", ["Open", "Paid"], { kind: "Unchanged" }, 26),
    ],
    reachable: ["Open", "Paid", "Closed"],
    truncated: ["audit"],
    notEvaluated: [],
  };
}

const ids = (d: StructDiagram): string[] => d.nodes.map((n) => n.ref.id);
const find = (d: StructDiagram, id: string): StructNode | undefined => d.nodes.find((n) => n.ref.id === id);

describe("state machine (adapter)", () => {
  it("draws the initial pseudo-state, each state, the computed `?` and a note", () => {
    const d = toStateDiagram(machine(), { uri: URI, showUnchanged: false });
    assert.deepStrictEqual(ids(d), ["initial", "state:Open", "state:Paid", "state:Closed", "state:Lost", "state:?", "note:truncated"]);
    assert.strictEqual(find(d, "initial")?.kind, "initial");
    assert.strictEqual(find(d, "state:?")?.kind, "computed");
    assert.ok(find(d, "state:Lost")?.dimmed, "unreachable from the initial state");
    assert.ok(!find(d, "state:Open")?.dimmed);
    assert.strictEqual(find(d, "note:truncated")?.name, "audit(): too many paths to analyse");
    // A state opens its field; `?` and the note open nothing.
    assert.deepStrictEqual(find(d, "state:Paid")?.ref.loc, { uri: URI, range: R(2) });
    assert.strictEqual(find(d, "state:?")?.ref.loc, null);
  });

  it("groups transitions per (from, to), flags refused ones, and tags their handlers", () => {
    const d = toStateDiagram(machine(), { uri: URI, showUnchanged: false });
    const t = d.edges.map((e) => [e.ref.id, e.label, e.flag ?? null, e.tags ?? null]);
    assert.deepStrictEqual(t, [
      ["tr:[*]->Open", null, null, null],
      ["tr:Open->Paid", "pay(), settle()", null, ["pay", "settle"]],
      ["tr:Paid->Closed", "⚠ close() (noReopen)", "Known", ["close"]],
      ["tr:Open->?", "guess()", null, ["guess"]],
    ]);
    const pay = d.edges[1];
    assert.deepStrictEqual(pay.ref.loc, { uri: URI, range: R(10) }, "a transition opens its first write");
    assert.strictEqual(pay.note, "pay() when amount > 0\nsettle()");
    assert.ok(d.edges[2].note?.includes("violates noReopen at commit"));
  });

  it("draws unchanged outcomes as self-loops only on request", () => {
    const d = toStateDiagram(machine(), { uri: URI, showUnchanged: true });
    assert.ok(d.edges.some((e) => e.ref.id === "tr:Open->Open" && e.source === e.target));
    assert.ok(d.edges.some((e) => e.ref.id === "tr:Paid->Paid"));
  });

  it("links nothing between two revisions, nor a removed state or path", () => {
    const unlinked = toStateDiagram(machine(), { uri: URI, showUnchanged: false, linked: false });
    assert.ok(unlinked.nodes.every((n) => n.ref.loc === null));
    assert.ok(unlinked.edges.every((e) => e.ref.loc === null));

    const m = machine();
    m.diffStates = { Lost: "removed", Closed: "added" };
    m.edges[2].diff = "removed";
    const d = toStateDiagram(m, { uri: URI, showUnchanged: false });
    assert.strictEqual(find(d, "state:Lost")?.diff, "removed");
    assert.strictEqual(find(d, "state:Lost")?.ref.loc, null);
    assert.strictEqual(find(d, "state:Closed")?.diff, "added");
    assert.ok(find(d, "state:Closed")?.ref.loc);
    const closed = d.edges.find((e) => e.ref.id === "tr:Paid->Closed");
    assert.strictEqual(closed?.diff, "removed");
    assert.strictEqual(closed?.ref.loc, null);
    assert.ok(closed?.label?.startsWith("− "), "a mark is a sign as well as a colour");

    const gone = machine();
    gone.diff = "removed";
    assert.ok(toStateDiagram(gone, { uri: URI, showUnchanged: false }).nodes.every((n) => n.ref.loc === null));
  });

  it("has no initial transition when the initial state is not declared", () => {
    const m = machine();
    m.initial = null;
    const d = toStateDiagram(m, { uri: URI, showUnchanged: false });
    assert.ok(!find(d, "initial"));
    assert.ok(!d.edges.some((e) => e.ref.id.startsWith("tr:[*]")));
  });
});

describe("state machine (ELK layout, top to bottom)", function () {
  this.timeout(20_000);

  it("puts the initial state above the first, and routes every transition", async () => {
    const d = toStateDiagram(machine(), { uri: URI, showUnchanged: true });
    const scene = await layoutStructure(d, fixedMeasurer(), { direction: "DOWN" });
    const box = (id: string) => scene.nodes.find((p) => p.node.ref.id === id)?.box;
    const init = box(stateIds.initial);
    const open = box(stateIds.state("Open"));
    const paid = box(stateIds.state("Paid"));
    assert.ok(init && open && paid);
    assert.strictEqual(init.w, 18);
    assert.ok(init.y + init.h <= open.y, "the initial dot is above Open");
    assert.ok(open.y + open.h <= paid.y, "Open is above Paid");
    assert.strictEqual(scene.edges.length, d.edges.length);
    for (const e of scene.edges) assert.ok(e.points.length >= 2, `${e.edge.ref.id} is routed`);
  });
});

describe("architecture diff marks (adapter)", () => {
  const loc = (uri = "file:///w/a.bynk") => ({ uri, range: R(0) });
  const node = (name: string, over: Partial<ArchNode> = {}): ArchNode => ({
    name, kind: "Context", loc: loc(), capabilities: [], providers: [], services: [], agents: [], ...over,
  });
  const svc = (name: string, handlerCount: number) => ({ name, handlerCount, loc: loc() });
  const before: ArchModel = {
    nodes: [node("shop", { services: [svc("api", 2), svc("legacy", 1)] }), node("old"), node("same")],
    edges: [{ from: "shop", to: "old", capabilities: [], loc: loc() }],
  };
  const after: ArchModel = {
    nodes: [node("shop", { services: [svc("api", 3), svc("new", 1)] }), node("billing", { kind: "Adapter" }), node("same")],
    edges: [{ from: "shop", to: "billing", capabilities: ["Pay"], loc: loc() }],
  };

  it("marks units, their members and `consumes` edges, and makes removed ones ghosts", () => {
    const { model, marks } = mergeArchitecture(before, after);
    const d = toArchitectureDiagram(model, { expanded: new Set(["shop"]), events: false, marks });
    const all: StructNode[] = [];
    const walk = (ns: StructNode[]): void => ns.forEach((n) => (all.push(n), walk(n.children)));
    walk(d.nodes);
    const at = (id: string) => all.find((n) => n.ref.id === id);
    assert.strictEqual(at("u:shop")?.diff, "changed");
    assert.strictEqual(at("u:billing")?.diff, "added");
    assert.strictEqual(at("u:old")?.diff, "removed");
    assert.strictEqual(at("u:old")?.ref.loc, null, "a ghost opens nothing");
    assert.ok(at("u:billing")?.ref.loc);
    assert.strictEqual(at("u:same")?.diff, undefined);
    assert.strictEqual(at("svc:shop/api")?.diff, "changed");
    assert.strictEqual(at("svc:shop/new")?.diff, "added");
    assert.strictEqual(at("svc:shop/legacy")?.diff, "removed");
    assert.strictEqual(at("svc:shop/legacy")?.ref.loc, null);
    const added = d.edges.find((e) => e.target === "u:billing");
    const removed = d.edges.find((e) => e.target === "u:old");
    assert.deepStrictEqual([added?.diff, added?.label], ["added", "+ Pay"]);
    assert.deepStrictEqual([removed?.diff, removed?.label, removed?.ref.loc], ["removed", "−", null]);
  });

  it("opens no component view on a diff, and nothing from an edge that touches a ghost", () => {
    const b: ArchModel = {
      nodes: [node("shop"), node("gone", { services: [{ ...svc("web", 1), protocol: "http", actors: ["Visitor"] }] })],
      edges: [],
    };
    const a: ArchModel = { nodes: [node("shop")], edges: [] };
    const { model, marks } = mergeArchitecture(b, a);
    const d = toArchitectureDiagram(model, { expanded: new Set(), events: false, marks });
    const all: StructNode[] = [];
    const walk = (ns: StructNode[]): void => ns.forEach((n) => (all.push(n), walk(n.children)));
    walk(d.nodes);
    assert.ok(all.every((n) => !n.opens), "no ↗ on a diff's map");
    const call = d.edges.find((e) => e.source === "actor:Visitor" && e.target === "u:gone");
    assert.ok(call, "the removed unit's caller is still drawn");
    assert.strictEqual(call.ref.loc, null, "its edge opens nothing: the source was in a scratch checkout");
  });

  it("opens nothing at all between two revisions", () => {
    const { model, marks } = mergeArchitecture(before, after);
    const d = toArchitectureDiagram(model, { expanded: new Set(["shop"]), events: false, marks, linked: false });
    const all: StructNode[] = [];
    const walk = (ns: StructNode[]): void => ns.forEach((n) => (all.push(n), walk(n.children)));
    walk(d.nodes);
    assert.ok(all.every((n) => n.ref.loc === null));
    assert.ok(d.edges.every((e) => e.ref.loc === null));
  });

  it("draws an unmarked model as before, but for the component-view links a diff never offers", () => {
    const plain = toArchitectureDiagram(after, { expanded: new Set(), events: false });
    const marked = toArchitectureDiagram(after, { expanded: new Set(), events: false, marks: { nodes: {}, members: {}, edges: {} } });
    const strip = (d: StructDiagram): unknown => JSON.parse(JSON.stringify(d, (k, v: unknown) => (k === "opens" ? undefined : v)));
    assert.deepStrictEqual(strip(marked), strip(plain));
  });
});
