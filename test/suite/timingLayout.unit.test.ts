// #218: the timing diagram's layout (pure, fixed-width text for exact
// positions) and the page (jsdom): bars, interaction, the legend's caveat and
// the exports' wording.

import * as assert from "assert";

import { fixedMeasurer } from "../../src/diagram/measure";
import { layoutTiming, MIN_BAR, PLOT_W, ROW_H, scaleFor } from "../../src/diagram/timing/layout";
import { buildComparison, buildTimeline, collectNested, TIMING_NOTE } from "../../src/requestTimingCore";
import type { StepView, TraceView } from "../../src/requestTraceCore";
import type { TimingPayload } from "../../src/webview/timingTypes";
import { setupDom, type Dom } from "./domHarness";

function step(over: Partial<StepView> & Pick<StepView, "target" | "ms">): StepView {
  return { kind: "capability", outcome: "ok", at: null, ...over };
}
function view(over: Partial<TraceView> & Pick<TraceView, "id">): TraceView {
  return { context: "shop", parent: null, route: "GET /a", status: 200, durationMs: 10, steps: [], truncated: false, fault: null, receivedAt: 0, callees: {}, ...over };
}
const AT = { uri: "file:///p/src/shop.bynk", range: { start: { line: 4, character: 4 }, end: { line: 4, character: 4 } } };

function sample(): { root: TraceView; all: Record<string, TraceView> } {
  const c1 = view({ id: "c1", context: "other", route: "POST /authorise", durationMs: 3, parent: "r1", steps: [step({ target: "Db.query", ms: 2, at: AT })] });
  const root = view({
    id: "r1",
    status: 500,
    durationMs: 12,
    steps: [
      step({ kind: "call", target: "other.authorise", ms: 3.1, request: "c1", at: AT }),
      step({ kind: "agent", target: "Ledger.tally", ms: 1.2, outcome: "fault" }),
      step({ target: "Db.query", ms: 0.01, outcome: "pending" }),
    ],
    callees: { 0: { id: "c1", context: "other", route: "POST /authorise", status: 200, durationMs: 3 } },
  });
  return { root, all: { c1 } };
}

describe("layoutTiming", () => {
  const { root, all } = sample();
  const timeline = buildTimeline(collectNested(root, (id) => all[id]));
  const scene = layoutTiming({ timelines: [{ timeline, heading: "GET /a" }], footer: TIMING_NOTE }, fixedMeasurer());

  it("scales time linearly across the plot and puts ticks on it", () => {
    const scale = scaleFor(scene.end);
    assert.strictEqual(scene.x1 - scene.x0, PLOT_W);
    assert.strictEqual(scene.ticks[0].x, scene.x0);
    assert.ok(Math.abs(scene.ticks[scene.ticks.length - 1].x - (scene.x0 + scene.end * scale)) < 1e-6);
    const call = scene.bars.find((b) => b.bar.label === "other.authorise");
    assert.ok(call);
    assert.ok(Math.abs(call.x - scene.x0) < 1e-6, "starts at time 0");
    assert.ok(Math.abs(call.w - 3.1 * scale) < 1e-6);
  });

  it("stacks rows a row apart, below the axis", () => {
    const ys = scene.rows.map((r) => r.y);
    assert.ok(ys[0] > scene.headHeight);
    for (let i = 1; i < ys.length; i++) assert.strictEqual(ys[i] - ys[i - 1], ROW_H);
    assert.ok(scene.headings[0].y > scene.headHeight);
    assert.ok(scene.footer.y > ys[ys.length - 1]);
    assert.strictEqual(scene.footer.text, TIMING_NOTE);
  });

  it("gives a tiny step a bar you can hit, and a label only where it does not collide", () => {
    const tiny = scene.bars.find((b) => b.bar.label === "Db.query" && b.bar.ms === 0.01);
    assert.ok(tiny);
    assert.ok(tiny.w >= MIN_BAR);
    assert.strictEqual(tiny.label.placement, "after", "no later bar on its row, so the label sits after it");
    const big = scene.bars.find((b) => b.bar.kind === "request" && b.bar.label === "GET /a");
    assert.strictEqual(big?.label.placement, "inside");
  });

  it("drops a label that would run into the next bar on the same row", () => {
    const t = buildTimeline({
      trace: view({
        id: "x",
        durationMs: 502,
        steps: [step({ target: "A.b", ms: 0.5 }), step({ target: "A.b", ms: 0.5 }), step({ target: "B.c", ms: 500 }), step({ target: "A.b", ms: 0.5 })],
      }),
      nested: {},
    });
    const s = layoutTiming({ timelines: [{ timeline: t, heading: "x" }], footer: "" }, fixedMeasurer());
    const a = s.bars.filter((b) => b.bar.label === "A.b");
    assert.strictEqual(a[0].label.placement, "none", "the next bar on its row is right behind it");
    assert.strictEqual(a[1].label.placement, "after", "the next one on its row is far off");
  });

  it("stacks a comparison on one scale with deltas on B", () => {
    const a = view({ id: "a", steps: [step({ target: "Db.query", ms: 2 })] });
    const b = view({ id: "b", steps: [step({ target: "Db.query", ms: 3.5 })] });
    const c = buildComparison({ trace: a, nested: {} }, { trace: b, nested: {} });
    const s = layoutTiming({ timelines: [{ timeline: c.a, heading: "A" }, { timeline: c.b, heading: "B" }], comparison: c, footer: "" }, fixedMeasurer());
    assert.strictEqual(s.headings.length, 2);
    assert.ok(s.headings[1].y > s.rows[s.rows.length - 1].y - ROW_H * 3);
    const bBar = s.bars.find((x) => x.bar.id.startsWith("b:") && x.bar.kind === "capability");
    assert.strictEqual(bBar?.delta?.text, "+1.5 ms");
    assert.strictEqual(bBar?.delta?.slower, true);
    const aBar = s.bars.find((x) => x.bar.id.startsWith("a:") && x.bar.kind === "capability");
    assert.strictEqual(aBar?.delta, undefined);
    const widest = Math.max(...s.bars.map((x) => x.x + x.w));
    assert.ok(widest <= s.x1 + 1e-6, "both are on one scale, inside the axis");
  });
});

describe("the request timing page", () => {
  let dom: Dom | undefined;
  afterEach(() => {
    dom?.dispose();
    dom = undefined;
  });

  function payload(compare = false): TimingPayload {
    const { root, all } = sample();
    const source = collectNested(root, (id) => all[id]);
    const other = view({ id: "r2", durationMs: 14, steps: [step({ kind: "call", target: "other.authorise", ms: 5, request: "c1" }), step({ kind: "agent", target: "Ledger.tally", ms: 1.2 })] });
    return {
      source,
      ...(compare ? { compare: { trace: other, nested: {} } } : {}),
      choices: [
        { id: "r1", label: "GET /a · 500 · 12 ms · 10:00" },
        { id: "r2", label: "GET /a · 200 · 14 ms · 10:01" },
      ],
    };
  }

  function open(p: TimingPayload): Dom {
    dom = setupDom({ __BYNK_TIMING__: p });
    dom.load("timing");
    return dom;
  }

  it("draws a bar per step with the outcome, longest chain and caveat on it", () => {
    const d = open(payload());
    const bars = d.root.querySelectorAll("[data-bynk-ref]");
    assert.ok(bars.length >= 6, "request, the call, its callee request and step, two more steps");
    assert.ok(d.root.querySelector(".bynk-tbar--fault"), "a failing step");
    assert.ok(d.root.querySelector(".bynk-tbar--pending"), "a pending step");
    assert.ok(d.root.querySelector(".bynk-tbar--critical"), "the longest chain");
    const legend = d.root.querySelector(".bynk-timing-legend")?.textContent ?? "";
    assert.ok(legend.includes("Durations only; start times not reported"), legend);
    assert.ok((d.root.textContent ?? "").includes("Durations only; start times not reported"), "also inside the drawing, so an export says it");
    assert.ok(d.root.querySelector("#bynk-copy-mermaid"), "Copy as Mermaid is on the toolbar");
  });

  it("opens the call site on click, and marks it on hover", () => {
    const d = open(payload());
    const call = [...d.root.querySelectorAll<SVGElement>("[data-bynk-focusable]")].find((e) => e.getAttribute("aria-label")?.includes("other.authorise"));
    assert.ok(call, "a step with a call site is a focusable button");
    assert.ok((call.getAttribute("aria-label") ?? "").includes("3.1 ms"));
    assert.ok(call.querySelector("title")?.textContent?.includes("3.1 ms"), "hover shows the step and its duration");
    call.dispatchEvent(new d.window.MouseEvent("click", { bubbles: true }));
    assert.deepStrictEqual(d.posted.filter((m) => (m as { type: string }).type === "reveal"), [{ type: "reveal", uri: AT.uri, range: AT.range }]);
    call.dispatchEvent(new d.window.MouseEvent("mouseover", { bubbles: true }));
    assert.ok(d.posted.some((m) => (m as { type: string; uri?: string }).type === "highlight" && (m as { uri: string }).uri === AT.uri));
    const noSite = [...d.root.querySelectorAll<SVGElement>("[data-bynk-ref]")].find((e) => e.getAttribute("aria-label")?.includes("Ledger.tally"));
    assert.ok(noSite && !noSite.hasAttribute("data-bynk-focusable"), "a step with no call site opens nothing");
  });

  it("copies a gantt chart", () => {
    const d = open(payload());
    d.root.querySelector<HTMLButtonElement>("#bynk-copy-mermaid")?.click();
    const copy = d.posted.find((m) => (m as { type: string }).type === "copyText") as { text: string } | undefined;
    assert.ok(copy?.text.startsWith("gantt\n"), copy?.text ?? "");
    assert.ok(copy?.text.includes("other.authorise"));
  });

  it("stacks a comparison, with its deltas, and offers the picker", () => {
    const d = open(payload(true));
    assert.ok(d.root.querySelector(".bynk-tdelta"), "a delta on B's own step");
    assert.ok((d.root.querySelector(".bynk-timing-legend")?.textContent ?? "").includes("B against A"));
    const compare = d.root.querySelector<HTMLSelectElement>("#bynk-timing-compare");
    assert.ok(compare);
    compare.value = "";
    compare.dispatchEvent(new d.window.Event("change"));
    assert.deepStrictEqual(d.posted.filter((m) => (m as { type: string }).type === "showTiming"), [{ type: "showTiming", id: "r1" }]);
  });

  it("redraws for a host update", () => {
    const d = open(payload());
    const before = d.root.querySelectorAll("[data-bynk-ref]").length;
    const next = payload(true);
    d.post({ type: "timing", payload: next });
    assert.ok(d.root.querySelectorAll("[data-bynk-ref]").length > before, "both traces are drawn now");
  });

  it("says plainly when a callee could not be expanded", () => {
    const { root } = sample();
    const d = open({ source: { trace: root, nested: {} }, choices: [{ id: "r1", label: "x" }] });
    assert.ok((d.root.querySelector(".bynk-timing-legend")?.textContent ?? "").includes("could not be expanded"));
  });
});
