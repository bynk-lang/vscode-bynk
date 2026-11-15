// Unit coverage for the graphs of "Bynk: Compare Model with…" (#153): the merged
// before-and-after models, and how the views' generators style their marks.

import * as assert from "assert";

import { renderModelDiffHtml } from "../../src/modelDiffHtml";
import { agentKey, diffSnapshots, type ModelSnapshot } from "../../src/modelDiffCore";
import { buildGraphs, mergeArchitecture, mergeMachine } from "../../src/modelDiffGraphCore";
import { toMermaidArch } from "../../src/webview/architecture-gen";
import type { ArchModel, ArchNode } from "../../src/webview/architectureTypes";
import { edgeKey, memberKey } from "../../src/webview/diffMarks";
import { toMermaidState } from "../../src/webview/state-gen";
import type { AgentStateModel, StateEdge, StateMachine } from "../../src/webview/stateTypes";

const rng = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const loc = (uri = "file:///w/a.bynk") => ({ uri, range: rng });
const node = (name: string, over: Partial<ArchNode> = {}): ArchNode => ({
  name, kind: "Context", loc: loc(), capabilities: [], providers: [], services: [], agents: [], ...over,
});
const svc = (name: string, handlerCount: number) => ({ name, handlerCount, loc: loc() });

describe("merged architecture (#153)", () => {
  const before: ArchModel = {
    nodes: [node("shop", { services: [svc("api", 2), svc("legacy", 1)] }), node("old", { services: [svc("s", 1)] }), node("same")],
    edges: [{ from: "shop", to: "old", capabilities: [], loc: loc() }],
  };
  const after: ArchModel = {
    nodes: [node("shop", { services: [svc("api", 3), svc("new", 1)] }), node("billing", { kind: "Adapter", services: [svc("b", 1)] }), node("same")],
    edges: [{ from: "shop", to: "billing", capabilities: ["Pay"], loc: loc() }],
  };
  const { model, marks } = mergeArchitecture(before, after);

  it("keeps removed contexts, members and edges as ghosts beside the working tree's", () => {
    assert.deepStrictEqual(model.nodes.map((n) => n.name), ["shop", "billing", "same", "old"]);
    assert.deepStrictEqual(model.nodes[0].services.map((s) => s.name), ["api", "new", "legacy"]);
    assert.deepStrictEqual(model.edges.map(edgeKey), ["shop → billing", "shop → old"]);
  });

  it("marks added, removed and changed, and a context whose member moved", () => {
    assert.deepStrictEqual(marks.nodes, { shop: "changed", billing: "added", old: "removed" });
    assert.strictEqual(marks.members[memberKey("shop", "service", "api")], "changed");
    assert.strictEqual(marks.members[memberKey("shop", "service", "new")], "added");
    assert.strictEqual(marks.members[memberKey("shop", "service", "legacy")], "removed");
    assert.strictEqual(marks.members[memberKey("billing", "service", "b")], "added", "an added context's members are added");
    assert.strictEqual(marks.members[memberKey("old", "service", "s")], "removed");
    assert.deepStrictEqual(marks.edges, { "shop → billing": "added", "shop → old": "removed" });
  });

  it("styles the marks on the map: signs, classes, unclickable ghosts, marked links", () => {
    const r = toMermaidArch(model, new Set(["shop"]), marks);
    assert.ok(r.text.includes('["+ billing"]:::adapterNode'), r.text);
    assert.ok(r.text.includes('["− old"]:::contextNode'), r.text);
    assert.ok(r.text.includes('("− service legacy (1)")'), r.text);
    assert.ok(/class ctx0 diffChanged;/.test(r.text) && /class ctx1 diffAdded;/.test(r.text) && /class ctx3 diffRemoved;/.test(r.text), r.text);
    assert.ok(!r.clickTargets.has("ctx3"), "a removed context has no source to open");
    assert.ok(r.clickTargets.has("ctx1"));
    assert.deepStrictEqual(r.linkMarks.map((l) => l.mark).sort(), ["added", "added", "changed", "removed", "removed"]);
    assert.ok(r.text.includes('-->|"+ Pay"|'), r.text);
  });

  it("draws an unmarked model exactly as before", () => {
    const plain = toMermaidArch(before, new Set());
    assert.deepStrictEqual(plain.linkMarks, []);
    assert.ok(!plain.text.includes("diff"), plain.text);
  });
});

describe("merged state machine (#153)", () => {
  const edge = (handler: string, from: string[], to: string, outcome: string | null = null): StateEdge => ({
    handler, from, guards: [], to: { kind: "State", state: to }, outcome, range: rng, violations: [],
  });
  const machine = (states: string[], edges: StateEdge[]): StateMachine => ({
    field: "status", fieldRange: rng, states, initial: states[0], edges, reachable: states, truncated: [], notEvaluated: [],
  });
  const before = machine(["New", "Paid", "Gone"], [edge("pay", ["New"], "Paid"), edge("drop", ["Paid"], "Gone"), edge("x", ["New"], "Paid", "A")]);
  const after = machine(["New", "Paid", "Shipped"], [edge("pay", ["New"], "Paid"), edge("ship", ["Paid"], "Shipped"), edge("x", ["New"], "Paid", "B")]);
  const merged = mergeMachine(before, after)!;

  it("keeps removed states and paths, marking each", () => {
    assert.deepStrictEqual(merged.states, ["New", "Paid", "Shipped", "Gone"]);
    assert.deepStrictEqual(merged.diffStates, { Shipped: "added", Gone: "removed" });
    assert.deepStrictEqual(merged.edges.map((e) => `${e.handler}:${e.diff ?? "-"}`), ["pay:-", "ship:added", "x:changed", "drop:removed"]);
    assert.ok(merged.reachable.includes("Gone"), "a ghost state is not dimmed as unreachable");
  });

  it("styles states and transitions, and leaves an untouched machine alone", () => {
    const { text, edgeOrder } = toMermaidState(merged, { showUnchanged: false });
    assert.ok(text.includes("class s2 diffAdded"), text);
    assert.ok(text.includes("class s3 diffRemoved"), text);
    // `pay` (unchanged) and `x` (its outcome changed) share a transition, so it is changed.
    assert.ok(text.includes(": + ship()") && text.includes(": − drop()") && text.includes(": ~ pay(), x()"), text);
    assert.deepStrictEqual(edgeOrder.map((g) => g.diff), ["changed", "added", "removed"]);
    const plain = toMermaidState(after, { showUnchanged: false });
    assert.ok(!plain.text.includes("diff"), plain.text);
  });

  it("treats a transition shared by marked and unmarked paths as changed", () => {
    const m = machine(["A", "B"], [{ ...edge("a", ["A"], "B"), diff: "added" }, edge("b", ["A"], "B")]);
    assert.strictEqual(toMermaidState(m, { showUnchanged: false }).edgeOrder[0].diff, "changed");
  });

  it("marks a machine that only one revision has as wholly added or removed, with no violations", () => {
    const flagged = { ...edge("p", ["New"], "Paid"), violations: [{ transition: "t", range: rng, certainty: "Known" as const, from: ["New"], targets: ["Paid"] }] };
    const gone = mergeMachine(machine(["New", "Paid"], [flagged]), undefined)!;
    assert.strictEqual(gone.diff, "removed");
    assert.deepStrictEqual(gone.edges[0].violations, []);
    assert.deepStrictEqual(gone.diffStates, { New: "removed", Paid: "removed" });
    assert.strictEqual(mergeMachine(undefined, after)!.diff, "added");
  });
});

describe("diff graphs and page (#153)", () => {
  const arch: ArchModel = { nodes: [node("shop", { agents: [{ name: "Order", handlerCount: 1, loc: loc("file:///w/o.bynk") }] })], edges: [] };
  const model = (states: string[]): AgentStateModel => ({
    agent: "Order", range: rng, handlers: [],
    machines: [{ field: "status", fieldRange: rng, states, initial: states[0], edges: [], reachable: states, truncated: [], notEvaluated: [] }],
  });
  const snap = (states: string[]): ModelSnapshot => ({ architecture: arch, contracts: null, agents: { [agentKey("shop", "Order")]: model(states) } });

  it("draws only the agents whose state machine differs, linked to the working tree", () => {
    assert.deepStrictEqual(buildGraphs(snap(["A"]), snap(["A"])).agents, []);
    const g = buildGraphs(snap(["A"]), snap(["A", "B"]));
    assert.deepStrictEqual(g.agents.map((a) => [a.key, a.uri, a.machines.length]), [["shop.Order", "file:///w/o.bynk", 1]]);
  });

  it("has no architecture graph when a revision's model could not be read", () => {
    assert.strictEqual(buildGraphs({ architecture: null, contracts: null, agents: {} }, snap(["A"])).architecture, null);
  });

  it("embeds the graphs and loads the bundle, escaping `<` in the payload", () => {
    const b = snap(["A"]);
    const a = snap(["A", "B"]);
    a.architecture = { nodes: [node("<script>")], edges: [] };
    const html = renderModelDiffHtml(diffSnapshots(b, a), {
      against: "main", nonce: "N", cspSource: "csp", scriptUri: "vscode-resource://x/model-diff.js", graphs: buildGraphs(b, a),
    });
    assert.match(html, /id="diff-architecture"/);
    assert.match(html, /<script nonce="N" src="vscode-resource:\/\/x\/model-diff\.js">/);
    assert.ok(!html.includes("<script>\""), "payload does not break out of its script");
    assert.ok(html.includes("\\u003cscript>"));
    assert.ok(!html.includes("acquireVsCodeApi"), "the bundle, not the page, acquires the API");
  });

  it("is the tables alone without a bundle", () => {
    const html = renderModelDiffHtml(diffSnapshots(snap(["A"]), snap(["A"])), { against: "main", nonce: "N", cspSource: "csp" });
    assert.ok(!html.includes("diff-architecture"));
    assert.match(html, /acquireVsCodeApi/);
  });
});
