// #143: the pure core of request traces. The event below is the line `bynk dev
// --trace-events` writes in v0.639.1 (`bynk/src/dev.rs`, the `request` event
// pinned at :3001, and `bynk/src/trace.rs`; docs: `Request traces`); keep the
// two in step.

import * as assert from "assert";

import { parseDevEvent, devArgs } from "../../src/devEvents";
import {
  compareTraces,
  formatMs,
  MAX_TRACED_HANDLERS,
  MAX_TRACES_PER_HANDLER,
  overlayTrace,
  parseFrameLocation,
  parseRequestEvent,
  type RequestTrace,
  sameRoute,
  toTraceView,
  TraceStore,
  type TraceView,
  traceRelevant,
} from "../../src/requestTraceCore";
import type { SequenceModel } from "../../src/webview/types";

const EVENT =
  '{"event":"request","context":"shop-orders","id":"r1","parent":"p0","route":"POST /orders","status":201,"duration_ms":12.5,"steps":[{"kind":"call","target":"shop.payment.authorise","span":{"file":"src/shop/orders.bynk","line":23,"col":14},"ms":3.5,"outcome":"ok","request":"c1"}],"truncated":false,"fault":null}';

function trace(over: Partial<RequestTrace> = {}): RequestTrace {
  return {
    context: "shop-orders",
    id: "r",
    parent: null,
    route: "POST /orders",
    status: 200,
    durationMs: 1,
    steps: [],
    truncated: false,
    fault: null,
    receivedAt: 0,
    ...over,
  };
}

describe("the request event", () => {
  it("is read from the driver's line", () => {
    const e = parseDevEvent(EVENT);
    assert.ok(e && e.event === "request");
    const t = e.trace;
    assert.strictEqual(t.context, "shop-orders");
    assert.strictEqual(t.parent, "p0");
    assert.strictEqual(t.route, "POST /orders");
    assert.strictEqual(t.status, 201);
    assert.strictEqual(t.durationMs, 12.5);
    assert.deepStrictEqual(t.steps, [
      { kind: "call", target: "shop.payment.authorise", span: { file: "src/shop/orders.bynk", line: 23, col: 14 }, ms: 3.5, outcome: "ok", request: "c1" },
    ]);
    assert.strictEqual(t.fault, null);
  });

  it("reads a fault's message and frames, and a step with no span or request", () => {
    const t = parseRequestEvent(
      {
        id: "r2",
        route: "GET /a",
        steps: [{ kind: "agent", target: "Ledger.tally", span: null, ms: 0, outcome: "pending" }],
        fault: { message: "Error: boom", frames: ["at f (src/a.bynk:9:1)"] },
      },
      5,
    );
    assert.ok(t);
    assert.strictEqual(t.steps[0].span, null);
    assert.strictEqual(t.steps[0].request, undefined);
    assert.strictEqual(t.steps[0].outcome, "pending");
    assert.deepStrictEqual(t.fault, { message: "Error: boom", frames: ["at f (src/a.bynk:9:1)"] });
    assert.strictEqual(t.parent, null);
    assert.strictEqual(t.receivedAt, 5);
  });

  it("is total: nonsense is undefined, unknown steps and fields are dropped", () => {
    assert.strictEqual(parseDevEvent('{"event":"request"}'), undefined);
    assert.strictEqual(parseDevEvent('{"event":"request","id":1,"route":"x","steps":[]}'), undefined);
    const t = parseRequestEvent(
      { id: "r", route: "GET /", steps: [{ kind: "teleport", target: "x" }, { kind: "capability", target: "Db.query", span: { file: "a.bynk", line: 0, col: 1 }, ms: "x", outcome: "weird" }], extra: 1 },
      0,
    );
    assert.deepStrictEqual(t?.steps.map((s) => [s.target, s.span, s.ms, s.outcome]), [["Db.query", null, 0, "ok"]], "an unknown kind goes; a bad span, time and outcome are made safe");
  });

  it("reads a fault the Worker printed raw (its stack as one string)", () => {
    const t = parseRequestEvent({ id: "r", route: "GET /", steps: [], fault: "Error: boom\n    at f (index.js:1:2)" }, 0);
    assert.deepStrictEqual(t?.fault, { message: "Error: boom", frames: ["at f (index.js:1:2)"] });
  });

  it("asks for --trace-events only when told to, before the contexts", () => {
    assert.deepStrictEqual(devArgs({}), ["dev", "--format", "json", "--log-events"]);
    assert.deepStrictEqual(devArgs({ traceEvents: true, contexts: ["a"] }), ["dev", "--format", "json", "--log-events", "--trace-events", "--context", "a"]);
  });
});

describe("TraceStore", () => {
  it("keeps the newest traces per handler, and the newest handlers", () => {
    const s = new TraceStore();
    for (let i = 0; i < MAX_TRACES_PER_HANDLER + 5; i++) s.add(trace({ id: `a${i}`, receivedAt: i }));
    assert.strictEqual(s.all().length, MAX_TRACES_PER_HANDLER);
    assert.strictEqual(s.all()[0].id, `a${MAX_TRACES_PER_HANDLER + 4}`, "newest first");
    assert.strictEqual(s.byId("a0"), undefined, "the oldest went");
    const t = new TraceStore();
    for (let i = 0; i < MAX_TRACED_HANDLERS + 3; i++) t.add(trace({ id: `h${i}`, route: `GET /${i}`, receivedAt: i }));
    assert.strictEqual(t.all().length, MAX_TRACED_HANDLERS);
    assert.strictEqual(t.byId("h0"), undefined);
    t.clear();
    assert.deepStrictEqual(t.all(), []);
  });

  it("keeps handlers apart by context and route", () => {
    const s = new TraceStore();
    s.add(trace({ id: "1", context: "a" }));
    s.add(trace({ id: "2", context: "b" }));
    assert.strictEqual(s.all().length, 2);
  });
});

describe("parseFrameLocation and toTraceView", () => {
  it("finds a .bynk location in a frame, project-relative or absolute", () => {
    assert.deepStrictEqual(parseFrameLocation("at http_GET (src/shop.bynk:12:3)"), { file: "src/shop.bynk", line: 12, col: 3 });
    assert.deepStrictEqual(parseFrameLocation("at /work/src/shop.bynk:12:3"), { file: "/work/src/shop.bynk", line: 12, col: 3 });
    assert.strictEqual(parseFrameLocation("at f (index.js:1:2)"), undefined);
    assert.strictEqual(parseFrameLocation("at g (a.bynk:0:1)"), undefined);
  });

  it("resolves locations through the wrapper, joins callees and links frames", () => {
    const callee = trace({ id: "c1", context: "payment", route: "POST /authorise", status: 200, durationMs: 2 });
    const t = trace({
      steps: [
        { kind: "call", target: "p.authorise", span: { file: "src/a.bynk", line: 3, col: 5 }, ms: 3, outcome: "ok", request: "c1" },
        { kind: "capability", target: "Db.query", span: { file: "../outside.bynk", line: 1, col: 1 }, ms: 1, outcome: "fault" },
      ],
      fault: { message: "boom", frames: ["at f (src/a.bynk:9:2)", "at index.js:1:1"] },
    });
    const v = toTraceView(t, (f) => (f.startsWith("..") ? undefined : `file:///p/${f}`), (id) => (id === "c1" ? callee : undefined));
    assert.deepStrictEqual(v.steps[0].at, { uri: "file:///p/src/a.bynk", range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } } });
    assert.strictEqual(v.steps[1].at, null, "a path that leaves the project is not located");
    assert.deepStrictEqual(v.callees[0], { id: "c1", context: "payment", route: "POST /authorise", status: 200, durationMs: 2 });
    assert.ok(v.fault?.frames[0].at);
    assert.strictEqual(v.fault?.frames[1].at, null);
  });
});

// A handler: `check` (found), `auth` call at line 3 inside the `if`, `save` at
// line 7 inside the else, a nested-free tail call at line 10, and a reply.
const R = (line: number, c0 = 2, c1 = 30) => ({ start: { line, character: c0 }, end: { line, character: c1 } });
const MODEL: SequenceModel = {
  participants: [
    { id: 0, kind: "Entry", name: "api", range: null },
    { id: 1, kind: "Context", name: "payment", range: R(0) },
    { id: 2, kind: "Capability", name: "Db", range: R(0) },
  ],
  messages: [
    { from: 0, to: 1, kind: "Call", label: "authorise", range: R(3), block: 0 },
    { from: 1, to: 0, kind: "Return", label: "", range: R(3), block: 0 },
    { from: 0, to: 2, kind: "Call", label: "save", range: R(7), block: 0 },
    { from: 0, to: 2, kind: "Call", label: "log", range: R(10), block: null },
  ],
  blocks: [
    { id: 0, kind: "If", range: R(2, 0, 9), parent: null, parentBranch: null, branches: [
      { label: "paid", messageIds: [0, 1], reply: null },
      { label: "else", messageIds: [2], reply: null },
    ] },
  ],
};
const URI = "file:///p/src/a.bynk";
const at = (line0: number, character = 10) => ({ uri: URI, range: { start: { line: line0, character }, end: { line: line0, character } } });
function view(steps: TraceView["steps"], over: Partial<TraceView> = {}): TraceView {
  return { context: "c", id: "t", parent: null, route: "GET /a", status: 200, durationMs: 5, steps, truncated: false, fault: null, receivedAt: 0, callees: {}, ...over };
}
const step = (line0: number, over: Partial<TraceView["steps"][number]> = {}): TraceView["steps"][number] =>
  ({ kind: "call", target: "t", ms: 2, outcome: "ok", at: at(line0), ...over });

describe("overlayTrace", () => {
  it("marks what the request touched and fades what it did not", () => {
    const o = overlayTrace(MODEL, URI, view([step(3), step(10)]));
    assert.deepStrictEqual(o.marks.get("m0"), { state: "hit", count: 1, ms: 2 });
    assert.strictEqual(o.marks.get("m2")?.state, "miss", "the else branch's call was not made");
    assert.strictEqual(o.marks.get("m3")?.state, "hit");
    assert.strictEqual(o.marks.get("m1"), undefined, "a reply is never a step");
    assert.strictEqual(o.marks.get("b0")?.state, "hit", "the fragment was entered");
    assert.strictEqual(o.marks.get("b0.0")?.state, "hit");
    assert.strictEqual(o.marks.get("b0.1")?.state, "miss", "the branch it did not take");
    assert.deepStrictEqual(o.unmatched, []);
  });

  it("marks a failing call, adds up a call made in a loop, and reports the pending", () => {
    const o = overlayTrace(MODEL, URI, view([step(7, { outcome: "fault" }), step(10, { ms: 1.5 }), step(10, { ms: 2.5, outcome: "pending" })]));
    assert.strictEqual(o.marks.get("m2")?.state, "fault");
    assert.deepStrictEqual(o.marks.get("m3"), { state: "pending", count: 2, ms: 4 });
  });

  it("leaves unmatched steps out: no span, another file, no message on that line", () => {
    const o = overlayTrace(MODEL, URI, view([step(3, { at: null }), step(3, { at: { ...at(3), uri: "file:///p/src/b.bynk" } }), step(20)]));
    assert.deepStrictEqual(o.unmatched, [0, 1, 2]);
    assert.ok([...o.marks.values()].filter((m) => m.state !== "miss").length === 0, "nothing is claimed that no step landed on");
  });

  it("matches a span on the call's line when it is not inside the range", () => {
    const o = overlayTrace(MODEL, URI, view([step(3, { at: at(3, 80) })]));
    assert.strictEqual(o.marks.get("m0")?.state, "hit");
  });

  it("marks no operand that has no calls of its own", () => {
    const m: SequenceModel = { ...MODEL, blocks: [{ ...MODEL.blocks[0], branches: [{ label: "x", messageIds: [], reply: "Ok" }, { label: "y", messageIds: [3], reply: null }] }] };
    const o = overlayTrace(m, URI, view([]));
    assert.strictEqual(o.marks.get("b0.0"), undefined);
    assert.strictEqual(o.marks.get("b0.1")?.state, "miss");
  });
});

describe("traceRelevant and sameRoute", () => {
  it("belongs on a diagram a step is on, or whose route triggers the handler", () => {
    assert.ok(traceRelevant(MODEL, URI, view([step(3)])));
    assert.ok(!traceRelevant(MODEL, URI, view([step(20)])));
    assert.ok(!traceRelevant(MODEL, URI, view([])));
    const m: SequenceModel = { ...MODEL, trigger: { kind: "Request", label: "get  /a" } };
    assert.ok(traceRelevant(m, URI, view([])));
    assert.ok(!traceRelevant({ ...m, trigger: { kind: "Schedule", label: "GET /a" } }, URI, view([])));
    assert.ok(sameRoute("GET /a", "get /a"));
    assert.ok(!sameRoute("GET /a", "GET /b"));
  });
});

describe("compareTraces and formatMs", () => {
  it("aligns steps by kind, target and occurrence, and says what only one did", () => {
    const a = view([step(3, { target: "x", ms: 2 }), step(3, { target: "x", ms: 4 }), step(7, { target: "y", ms: 1 })]);
    const b = view([step(3, { target: "x", ms: 3 }), step(10, { target: "z", ms: 9 })]);
    const rows = compareTraces(a, b);
    assert.deepStrictEqual(rows.map((r) => [r.target, r.a, r.b, r.delta]), [
      ["x", 2, 3, 1],
      ["x", 4, undefined, undefined],
      ["y", 1, undefined, undefined],
      ["z", undefined, 9, undefined],
    ]);
  });

  it("formats times", () => {
    assert.strictEqual(formatMs(3.14), "3.1 ms");
    assert.strictEqual(formatMs(12.4), "12 ms");
    assert.strictEqual(formatMs(250), "250 ms");
    assert.strictEqual(formatMs(1200), "1.2 s");
    assert.strictEqual(formatMs(0), "0.0 ms");
  });
});
