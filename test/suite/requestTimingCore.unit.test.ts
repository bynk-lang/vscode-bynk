// #218: the request timing diagram's core — timelines from a trace and the
// callees it joins, the longest chain, the comparison, the axis, and the Mermaid
// `gantt` export. Durations only: the data has no start offsets, so steps are
// laid end to end, and these tests pin that.

import * as assert from "assert";

import {
  axisTicks,
  buildComparison,
  buildTimeline,
  collectNested,
  CRITICAL_NOTE,
  formatDelta,
  ganttAxisFormat,
  layoutSteps,
  niceStep,
  participantOf,
  sameRouteShape,
  tickLabel,
  TIMING_NOTE,
  toMermaidGantt,
} from "../../src/requestTimingCore";
import type { StepView, TraceView } from "../../src/requestTraceCore";

function step(over: Partial<StepView> & Pick<StepView, "target" | "ms">): StepView {
  return { kind: "capability", outcome: "ok", at: null, ...over };
}

function view(over: Partial<TraceView> & Pick<TraceView, "id">): TraceView {
  return {
    context: "shop",
    parent: null,
    route: "GET /a",
    status: 200,
    durationMs: 10,
    steps: [],
    truncated: false,
    fault: null,
    receivedAt: 0,
    callees: {},
    ...over,
  };
}

const AT = { uri: "file:///p/src/shop.bynk", range: { start: { line: 4, character: 4 }, end: { line: 4, character: 4 } } };

/** r1 calls c1 (which does a Db.query then calls d1), then Ledger.tally faults. */
function tree(): { root: TraceView; all: Record<string, TraceView> } {
  const d1 = view({ id: "d1", context: "deep", route: "POST /deep", durationMs: 1, parent: "c1", steps: [step({ target: "Kv.get", ms: 0.5 })] });
  const c1 = view({
    id: "c1",
    context: "other",
    route: "POST /authorise",
    durationMs: 6,
    parent: "r1",
    steps: [
      step({ target: "Db.query", ms: 2 }),
      step({ kind: "call", target: "deep.fetch", ms: 3, request: "d1" }),
    ],
    callees: { 1: { id: "d1", context: "deep", route: "POST /deep", status: 200, durationMs: 1 } },
  });
  const root = view({
    id: "r1",
    status: 500,
    durationMs: 12.5,
    steps: [
      step({ kind: "call", target: "other.authorise", ms: 6, request: "c1", at: AT }),
      step({ kind: "agent", target: "Ledger.tally", ms: 1.2, outcome: "fault" }),
      step({ target: "Db.query", ms: 0.8, outcome: "pending" }),
    ],
    callees: { 0: { id: "c1", context: "other", route: "POST /authorise", status: 200, durationMs: 6 } },
  });
  return { root, all: { c1, d1 } };
}

describe("participantOf", () => {
  it("is the target without its last segment", () => {
    assert.strictEqual(participantOf("Db.query"), "Db");
    assert.strictEqual(participantOf("shop.payment.authorise"), "shop.payment");
    assert.strictEqual(participantOf("tally"), "tally");
  });
});

describe("layoutSteps (durations only)", () => {
  it("lays steps end to end from the origin, in order", () => {
    assert.deepStrictEqual(layoutSteps([{ ms: 3 }, { ms: 0 }, { ms: 1.5 }], 2), [
      { start: 2, end: 5 },
      { start: 5, end: 5 },
      { start: 5, end: 6.5 },
    ]);
  });
  it("never goes backwards for a bad duration", () => {
    assert.deepStrictEqual(layoutSteps([{ ms: -4 }], 1), [{ start: 1, end: 1 }]);
  });
});

describe("collectNested", () => {
  it("collects callees transitively, once each, and skips ones it never saw", () => {
    const { root, all } = tree();
    const src = collectNested(root, (id) => all[id]);
    assert.deepStrictEqual(Object.keys(src.nested).sort(), ["c1", "d1"]);
    const lonely = collectNested(root, () => undefined);
    assert.deepStrictEqual(lonely.nested, {});
  });

  it("cannot loop on a request that names its own ancestor", () => {
    const a = view({ id: "a", callees: { 0: { id: "b", context: "x", route: "r", status: 200, durationMs: 1 } } });
    const b = view({ id: "b", callees: { 0: { id: "a", context: "x", route: "r", status: 200, durationMs: 1 } } });
    const src = collectNested(a, (id) => ({ a, b })[id as "a" | "b"]);
    assert.deepStrictEqual(Object.keys(src.nested), ["b"]);
    const t = buildTimeline(src);
    assert.ok(t.bars.length >= 1);
  });
});

describe("buildTimeline", () => {
  const { root, all } = tree();
  const t = buildTimeline(collectNested(root, (id) => all[id]));

  it("gives the request, each participant and each nested request its own row, in first-use order", () => {
    assert.deepStrictEqual(
      t.rows.map((r) => [r.label, r.kind, r.depth]),
      [
        ["GET /a", "request", 0],
        ["other", "call", 1],
        ["POST /authorise", "request", 2],
        ["Db", "capability", 3],
        ["deep", "call", 3],
        ["POST /deep", "request", 4],
        ["Kv", "capability", 5],
        ["Ledger", "agent", 1],
        ["Db", "capability", 1],
      ],
    );
  });

  it("lays a request's steps end to end, and a callee from the call that reached it", () => {
    const bar = (label: string, row?: string) => t.bars.find((b) => b.label === label && (!row || b.row === row)) as NonNullable<typeof t.bars[number]>;
    const call = bar("other.authorise");
    assert.deepStrictEqual([call.start, call.end], [0, 6]);
    const tally = bar("Ledger.tally");
    assert.deepStrictEqual([tally.start, tally.end], [6, 7.2], "after the call, not overlapping it");
    const dbRoot = t.bars.find((b) => b.label === "Db.query" && b.row.endsWith("|capability|Db") && !b.row.includes("#")) as (typeof t.bars)[number];
    assert.deepStrictEqual([dbRoot.start, dbRoot.end], [7.2, 8]);
    // The callee: its request starts where the call did; its own steps end to end from there.
    const callee = t.bars.find((b) => b.kind === "request" && b.label === "POST /authorise") as (typeof t.bars)[number];
    assert.deepStrictEqual([callee.start, callee.end], [0, 6]);
    const inner = t.bars.find((b) => b.label === "Db.query" && b.row.includes("#")) as (typeof t.bars)[number];
    assert.deepStrictEqual([inner.start, inner.end], [0, 2]);
    const deepCall = t.bars.find((b) => b.label === "deep.fetch") as (typeof t.bars)[number];
    assert.deepStrictEqual([deepCall.start, deepCall.end], [2, 5]);
    const kv = t.bars.find((b) => b.label === "Kv.get") as (typeof t.bars)[number];
    assert.deepStrictEqual([kv.start, kv.end], [2, 2.5], "a nested callee starts at its call");
  });

  it("runs the axis to the latest end, and the root's own request bar to its reported duration", () => {
    assert.strictEqual(t.end, 12.5);
    const req = t.bars[0];
    assert.strictEqual(req.kind, "request");
    assert.deepStrictEqual([req.start, req.end, req.ms], [0, 12.5, 12.5]);
    assert.strictEqual(req.outcome, "fault", "a 5xx request");
  });

  it("carries outcomes, call sites and the callee join", () => {
    assert.strictEqual(t.bars.find((b) => b.label === "Ledger.tally")?.outcome, "fault");
    assert.strictEqual(t.bars.find((b) => b.label === "other.authorise")?.at, AT);
    assert.strictEqual(t.bars.find((b) => b.label === "other.authorise")?.callee, "c1");
    assert.strictEqual(t.fault, null);
    assert.strictEqual(t.unjoined, 0);
  });

  it("takes the longest chain through the heaviest step at each level, into the callee", () => {
    const labels = t.critical.map((id) => t.bars.find((b) => b.id === id)?.label);
    // root request; its heaviest step (other.authorise, 6); the callee request;
    // its heaviest (deep.fetch, 3); the deep request; its only step.
    assert.deepStrictEqual(labels, ["GET /a", "other.authorise", "POST /authorise", "deep.fetch", "POST /deep", "Kv.get"]);
    assert.deepStrictEqual(
      t.bars.filter((b) => b.critical).map((b) => b.label),
      ["GET /a", "other.authorise", "POST /authorise", "deep.fetch", "POST /deep", "Kv.get"],
    );
  });

  it("does not expand a call whose callee it never saw, and counts it", () => {
    const lonely = buildTimeline({ trace: root, nested: {} });
    assert.strictEqual(lonely.unjoined, 1);
    assert.deepStrictEqual(lonely.rows.map((r) => r.label), ["GET /a", "other", "Ledger", "Db"]);
  });

  it("draws a request that made no calls as its one bar", () => {
    const only = buildTimeline({ trace: view({ id: "x", durationMs: 4 }), nested: {} });
    assert.strictEqual(only.bars.length, 1);
    assert.deepStrictEqual(only.critical, [only.bars[0].id]);
    assert.strictEqual(only.end, 4);
  });

  it("lets a step total longer than the reported duration stand, not trimmed", () => {
    const long = buildTimeline({ trace: view({ id: "x", durationMs: 1, steps: [step({ target: "A.b", ms: 5 })] }), nested: {} });
    assert.strictEqual(long.end, 5);
  });

  it("namespaces ids with the prefix", () => {
    const p = buildTimeline({ trace: root, nested: {} }, "b:");
    assert.ok(p.bars.every((b) => b.id.startsWith("b:")));
    assert.ok(p.rows.every((r) => r.id.startsWith("b:")));
  });
});

describe("buildComparison", () => {
  it("stacks two traces on one scale and puts the delta on B's own steps", () => {
    const a = view({ id: "a", durationMs: 10, steps: [step({ target: "Db.query", ms: 2 }), step({ target: "Db.query", ms: 4 }), step({ target: "Q.only", ms: 1 })] });
    const b = view({ id: "b", durationMs: 14, steps: [step({ target: "Db.query", ms: 3 }), step({ target: "Db.query", ms: 4 }), step({ target: "Z.new", ms: 9 })] });
    const c = buildComparison({ trace: a, nested: {} }, { trace: b, nested: {} });
    assert.strictEqual(c.end, 16, "B's steps total 16 ms and are the longer");
    const label = (id: string) => c.b.bars.find((x) => x.id === id)?.label;
    assert.deepStrictEqual(
      Object.entries(c.deltas).map(([id, d]) => [label(id), d]),
      [["Db.query", 1], ["Db.query", 0]],
    );
    assert.strictEqual(c.totalDelta, 4);
    assert.deepStrictEqual(c.onlyA.map((id) => c.a.bars.find((x) => x.id === id)?.label), ["Q.only"]);
    assert.deepStrictEqual(c.onlyB.map((id) => c.b.bars.find((x) => x.id === id)?.label), ["Z.new"]);
    assert.ok(c.a.bars.every((x) => x.id.startsWith("a:")) && c.b.bars.every((x) => x.id.startsWith("b:")));
  });

  it("compares the same-route check", () => {
    assert.ok(sameRouteShape(view({ id: "1", route: "GET /orders/1" }), view({ id: "2", route: "GET /orders/2" })));
    assert.ok(!sameRouteShape(view({ id: "1" }), view({ id: "2", context: "other" })));
    assert.ok(!sameRouteShape(view({ id: "1", route: "GET /a" }), view({ id: "2", route: "POST /a" })));
  });
});

describe("the time axis", () => {
  it("picks 1, 2 or 5 times a power of ten", () => {
    assert.strictEqual(niceStep(12.5), 2);
    assert.strictEqual(niceStep(100), 20);
    assert.strictEqual(niceStep(7), 1);
    assert.strictEqual(niceStep(0.3), 0.05);
    assert.strictEqual(niceStep(0), 1);
  });
  it("runs from 0 to at or past the end", () => {
    assert.deepStrictEqual(axisTicks(12.5), [0, 2, 4, 6, 8, 10, 12, 14]);
    const t = axisTicks(0.3);
    assert.strictEqual(t[0], 0);
    assert.ok(t[t.length - 1] >= 0.3);
    assert.deepStrictEqual(axisTicks(0), [0, 1]);
  });
  it("labels ticks", () => {
    assert.strictEqual(tickLabel(0), "0");
    assert.strictEqual(tickLabel(5), "5 ms");
    assert.strictEqual(tickLabel(1500), "1.5 s");
    assert.strictEqual(tickLabel(0.05), "0.05 ms");
  });
  it("formats a delta, and nothing for none", () => {
    assert.strictEqual(formatDelta(1.2), "+1.2 ms");
    assert.strictEqual(formatDelta(-0.4), "−0.4 ms");
    assert.strictEqual(formatDelta(0), "");
  });
});

describe("Copy as Mermaid: a gantt chart", () => {
  const { root, all } = tree();
  const src = collectNested(root, (id) => all[id]);

  it("writes a gantt of the timeline with the caveat, outcomes and the longest chain", () => {
    const text = toMermaidGantt(buildTimeline(src));
    const lines = text.split("\n");
    assert.strictEqual(lines[0], "gantt");
    assert.ok(text.includes("dateFormat x"));
    assert.ok(text.includes(TIMING_NOTE), "the durations-only note travels with the export");
    assert.ok(text.includes("section GET /a"));
    assert.ok(text.includes("★ other.authorise 6.0 ms :done, g1, 0, 6ms"), text);
    assert.ok(/Ledger\.tally 1\.2 ms :crit, g\d+, 6, 1ms/.test(text), "a failing step is crit");
    assert.ok(/Db\.query 0\.8 ms :active, g\d+, 7, 1ms/.test(text), "a pending step is active; at least 1 ms");
    // Task ids are unique.
    const ids = [...text.matchAll(/, (g\d+),/g)].map((m) => m[1]);
    assert.strictEqual(new Set(ids).size, ids.length);
  });

  it("keeps a name's colon, hash and semicolon out of the syntax", () => {
    const t = buildTimeline({ trace: view({ id: "x", route: "GET /a:b#c", steps: [step({ target: "A.b;c", ms: 1 })] }), nested: {} });
    const body = toMermaidGantt(t).split("\n").filter((l) => !l.trim().startsWith("%%"));
    for (const l of body.slice(1)) {
      if (l.includes(":done") || l.includes(":crit") || l.includes(":active")) assert.strictEqual(l.split(":").length, 2, l);
    }
    assert.ok(!body.join("\n").includes("A.b;c"));
  });

  it("writes both traces of a comparison, with the delta on B", () => {
    const a = view({ id: "a", steps: [step({ target: "Db.query", ms: 2 })] });
    const b = view({ id: "b", steps: [step({ target: "Db.query", ms: 3.5 })] });
    const c = buildComparison({ trace: a, nested: {} }, { trace: b, nested: {} });
    const text = toMermaidGantt(c.a, c);
    assert.ok(text.includes("section A·"), text);
    assert.ok(text.includes("section B·"));
    assert.ok(text.includes("Db.query 3.5 ms +1.5 ms :done"), text);
  });

  it("chooses an axis that does not wrap past a second", () => {
    assert.strictEqual(ganttAxisFormat(999), "%L ms");
    assert.strictEqual(ganttAxisFormat(1500), "%S.%L s");
    assert.strictEqual(ganttAxisFormat(90_000), "%M:%S.%L");
    const slow = buildTimeline({ trace: view({ id: "s", durationMs: 2500 }), nested: {} });
    assert.ok(toMermaidGantt(slow).includes("axisFormat %S.%L s"));
    assert.ok(toMermaidGantt(buildTimeline({ trace: view({ id: "f", durationMs: 5 }), nested: {} })).includes("axisFormat %L ms"));
  });

  it("says what the longest chain is", () => {
    assert.ok(CRITICAL_NOTE.includes("longest step at each level"));
    assert.ok(CRITICAL_NOTE.includes("every step runs in turn"), "and why it is not called the critical path");
  });
});
