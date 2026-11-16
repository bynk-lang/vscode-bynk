// #2196: unit coverage for the agent state view's pure halves — the Mermaid
// `stateDiagram-v2` text (now the "Copy as Mermaid" export, model-diagrams
// slice 6) and the table cells (`state-gen.ts`).

import * as assert from "assert";

import { cellEdges, cellText, toMermaidState, writeText } from "../../src/webview/state-gen";
import type { StateEdge, StateMachine } from "../../src/webview/stateTypes";

const R = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

function edge(
  handler: string,
  from: string[],
  to: StateEdge["to"],
  outcome: string | null,
  guards: string[] = [],
  violations: StateEdge["violations"] = [],
): StateEdge {
  return { handler, from, guards, to, outcome, range: R, violations };
}

const ORDER: StateMachine = {
  field: "status",
  fieldRange: R,
  states: ["Pending", "Placed", "Cancelled"],
  initial: "Pending",
  edges: [
    edge("place", ["Pending"], { kind: "State", state: "Placed" }, "Ok(())"),
    edge("place", ["Placed"], { kind: "Unchanged" }, "Err(AlreadyPlaced)"),
    edge("place", ["Cancelled"], { kind: "Unchanged" }, "Err(AlreadyCancelled)"),
    edge("cancel", ["Pending"], { kind: "State", state: "Cancelled" }, "Ok(())"),
    edge("cancel", ["Placed"], { kind: "Unchanged" }, "Err(AlreadyPlaced)"),
    edge("cancel", ["Cancelled"], { kind: "Unchanged" }, "Err(AlreadyCancelled)"),
  ],
  reachable: ["Pending", "Placed", "Cancelled"],
  truncated: [],
  notEvaluated: [],
};

function body(text: string): string[] {
  return text.split("\n").slice(1).map((l) => l.trim());
}

describe("toMermaidState", () => {
  it("draws the Order lifecycle: initial state and the two moves, unchanged outcomes hidden", () => {
    const { text, edgeOrder, hasInitial, stateIds } = toMermaidState(ORDER, { showUnchanged: false });
    assert.deepStrictEqual(body(text), [
      'state "Pending" as s0',
      'state "Placed" as s1',
      'state "Cancelled" as s2',
      "[*] --> s0",
      "s0 --> s1 : place()",
      "s0 --> s2 : cancel()",
      "classDef unreachable opacity:0.45,stroke-dasharray:4 3",
      "classDef computed stroke-dasharray:4 3",
    ]);
    assert.strictEqual(hasInitial, true);
    assert.deepStrictEqual(edgeOrder.map((g) => [g.from, g.to, g.handlers]), [
      ["Pending", "Placed", ["place"]],
      ["Pending", "Cancelled", ["cancel"]],
    ]);
    assert.strictEqual(stateIds.get("s1"), "Placed");
  });

  it("draws unchanged outcomes as self-loops when asked, merging handlers on one transition", () => {
    const { text, edgeOrder } = toMermaidState(ORDER, { showUnchanged: true });
    assert.ok(text.includes("s1 --> s1 : place(), cancel()"), text);
    assert.ok(text.includes("s2 --> s2 : place(), cancel()"), text);
    const loop = edgeOrder.find((g) => g.from === "Placed" && g.to === "Placed");
    assert.strictEqual(loop?.edges.length, 2, "one transition stands for both handlers' edges");
  });

  it("sends a computed write to a dashed `?` pseudo-state, from every state it can start in", () => {
    const m: StateMachine = {
      ...ORDER,
      edges: [edge("reset", ["Placed", "Cancelled"], { kind: "Unknown" }, null)],
    };
    const { text, stateIds } = toMermaidState(m, { showUnchanged: false });
    assert.ok(text.includes('state "?" as unknown'), text);
    assert.ok(text.includes("s1 --> unknown : reset()"), text);
    assert.ok(text.includes("s2 --> unknown : reset()"), text);
    assert.ok(text.includes("class unknown computed"), text);
    assert.strictEqual(stateIds.get("unknown"), "?");
  });

  it("dims unreachable states, notes truncated handlers, and omits [*] without a literal initialiser", () => {
    const m: StateMachine = {
      ...ORDER,
      initial: null,
      reachable: ["Pending", "Placed"],
      truncated: ["go"],
    };
    const { text, hasInitial } = toMermaidState(m, { showUnchanged: false });
    assert.strictEqual(hasInitial, false);
    assert.ok(!text.includes("[*]"), text);
    assert.ok(text.includes("class s2 unreachable"), text);
    assert.ok(text.includes("note right of s0 : go() too many paths to analyse"), text);
  });

  it("skips an edge naming a state the model didn't declare rather than mis-drawing it", () => {
    const m: StateMachine = {
      ...ORDER,
      edges: [edge("x", ["Pending"], { kind: "State", state: "Gone" }, null)],
    };
    const { text, edgeOrder } = toMermaidState(m, { showUnchanged: false });
    assert.strictEqual(edgeOrder.length, 0);
    assert.ok(!text.includes("-->  s0") && !text.includes("s0 --> s0"), text);
  });

  it("keeps Mermaid's separators out of state names and labels", () => {
    const m: StateMachine = {
      ...ORDER,
      states: ["A;B", "C"],
      initial: "A;B",
      reachable: ["A;B", "C"],
      edges: [edge("x:y", ["A;B"], { kind: "State", state: "C" }, null)],
    };
    const { text } = toMermaidState(m, { showUnchanged: false });
    assert.ok(text.includes('state "A B" as s0'), text);
    assert.ok(text.includes("s0 --> s1 : x y()"), text);
  });
});

describe("transition overlay (#2197)", () => {
  const paidIsTerminal = (certainty: "Known" | "Possible", from: string[], targets: string[]) => ({
    transition: "paid_is_terminal",
    range: R,
    certainty,
    from,
    targets,
  });

  it("marks a violating transition with a warning and the transition's name", () => {
    const m: StateMachine = {
      ...ORDER,
      states: ["Pending", "Placed", "Paid"],
      reachable: ["Pending", "Placed", "Paid"],
      edges: [
        edge("place", ["Pending", "Placed", "Paid"], { kind: "State", state: "Placed" }, null, [], [
          paidIsTerminal("Known", ["Paid"], ["Placed"]),
        ]),
      ],
    };
    const { text, edgeOrder } = toMermaidState(m, { showUnchanged: false });
    assert.ok(text.includes("s2 --> s1 : ⚠ place() (paid_is_terminal)"), text);
    assert.ok(text.includes("s0 --> s1 : place()"), "only the violating start is flagged");
    const g = edgeOrder.find((x) => x.from === "Paid");
    assert.strictEqual(g?.flag, "Known");
    assert.deepStrictEqual(g?.violated, ["paid_is_terminal"]);
  });

  it("always draws a refused unchanged outcome, even with unchanged outcomes hidden", () => {
    const m: StateMachine = {
      ...ORDER,
      edges: [
        edge("refuse", ["Pending"], { kind: "Unchanged" }, "false", [], [
          { transition: "must_advance", range: R, certainty: "Known", from: ["Pending"], targets: ["Pending"] },
        ]),
        edge("refuse", ["Placed"], { kind: "Unchanged" }, "true"),
      ],
    };
    const { text, edgeOrder } = toMermaidState(m, { showUnchanged: false });
    assert.ok(text.includes("s0 --> s0 : ⚠ refuse() (must_advance)"), text);
    assert.ok(!text.includes("s1 --> s1"), "an unflagged unchanged outcome stays hidden");
    assert.strictEqual(edgeOrder.length, 1);
  });

  it("takes the strongest certainty when a transition's edges disagree", () => {
    const m: StateMachine = {
      ...ORDER,
      edges: [
        edge("a", ["Placed"], { kind: "Unknown" }, null, [], [paidIsTerminal("Possible", ["Placed"], ["Pending"])]),
        edge("b", ["Placed"], { kind: "Unknown" }, null, [], [paidIsTerminal("Known", ["Placed"], ["Pending"])]),
      ],
    };
    const { edgeOrder } = toMermaidState(m, { showUnchanged: false });
    assert.strictEqual(edgeOrder[0].flag, "Known");
  });
});

describe("handler x state cells", () => {
  it("lists every path of a handler from a state, with target and outcome", () => {
    assert.deepStrictEqual(cellEdges(ORDER, "place", "Pending").map(cellText), ["→ Placed · Ok(())"]);
    assert.deepStrictEqual(cellEdges(ORDER, "place", "Placed").map(cellText), ["Err(AlreadyPlaced)"]);
    assert.deepStrictEqual(cellText(edge("r", ["A"], { kind: "Unknown" }, null)), "→ ?");
    assert.deepStrictEqual(cellText(edge("r", ["A"], { kind: "Unchanged" }, null)), "()");
  });

  it("is empty where no path of the handler starts in the state", () => {
    const m: StateMachine = { ...ORDER, edges: [edge("place", ["Pending"], { kind: "State", state: "Placed" }, null)] };
    assert.deepStrictEqual(cellEdges(m, "place", "Placed"), []);
  });
});



describe("effect write labels (#2198)", () => {
  it("labels assignments, keyed writes, items and combiners", () => {
    assert.strictEqual(writeText({ field: "lastSeq", op: ":=", key: null }), "lastSeq :=");
    assert.strictEqual(writeText({ field: "items", op: "put", key: "id" }), "items.put(id, …)");
    assert.strictEqual(writeText({ field: "history", op: "append", key: "event" }), "history.append(event)");
    assert.strictEqual(writeText({ field: "seen", op: "add", key: "x" }), "seen.add(x)");
    assert.strictEqual(writeText({ field: "count", op: "update", key: null }), "count.update(…)");
  });
});
