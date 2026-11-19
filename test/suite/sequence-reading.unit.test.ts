// Model-diagrams slice 2, the pure parts: folding in layout, which fragments
// start folded, what a fold hides, which element the editor's cursor is in,
// the viewport's zoom and minimap geometry, the export's CSS-variable
// resolution, and the host's checks on the page's messages.

import * as assert from "assert";

import { resolveCssVars } from "../../src/diagram/export";
import { fixedMeasurer } from "../../src/diagram/measure";
import { toSequenceDiagram } from "../../src/diagram/sequence/adapter";
import type { SequenceDiagram } from "../../src/diagram/sequence/ir";
import { layoutSequence, type PlacedFragment, type PlacedMessage } from "../../src/diagram/sequence/layout";
import { DEFAULT_FOLD_DEPTH, elementAt, foldedSet, fragmentDepths, hiddenBy, rangesOf } from "../../src/diagram/sequence/render";
import { clampZoom, fitZoom, minimapRect, scrollForMinimapPoint, wantsMinimap, ZOOM_MAX, ZOOM_MIN } from "../../src/diagram/viewport";
import { fileStem, isCopyText, isHighlight, isPageError, isSaveFile, isShowTiming } from "../../src/sequenceMessages";
import type { SequenceModel } from "../../src/webview/types";

const R = (line: number, character = 0, endLine = line, endChar = character + 4) => ({
  start: { line, character },
  end: { line: endLine, character: endChar },
});

/** A handler with three levels of nesting: if (b0) > match (b1) > if (b2). */
function nested(): SequenceModel {
  return {
    participants: [
      { id: 0, kind: "Entry", name: "api", range: null },
      { id: 1, kind: "Capability", name: "Clock", range: R(1) },
      { id: 2, kind: "Capability", name: "Store", range: R(2) },
    ],
    messages: [
      { from: 0, to: 1, kind: "Call", label: "now()", range: R(10, 4, 10, 15), block: null },
      { from: 0, to: 2, kind: "Call", label: "get(k)", range: R(12, 8, 12, 20), block: 0 },
      { from: 2, to: 0, kind: "Return", label: "", range: R(12, 8, 12, 20), block: 0 },
      { from: 0, to: 2, kind: "Send", label: "put(k)", range: R(14, 12, 14, 24), block: 1 },
      { from: 0, to: 1, kind: "Call", label: "tick()", range: R(16, 16, 16, 28), block: 2 },
    ],
    blocks: [
      { id: 0, kind: "If", branches: [{ label: "a", messageIds: [1, 2], reply: null }, { label: "else", messageIds: [], reply: "Err(e)" }], range: R(11, 2, 20, 3), parent: null, parentBranch: null },
      { id: 1, kind: "Match", branches: [{ label: "Some(x)", messageIds: [3], reply: null }], range: R(13, 6, 18, 7), parent: 0, parentBranch: 0 },
      { id: 2, kind: "If", branches: [{ label: "x > 1", messageIds: [4], reply: null }], range: R(15, 10, 17, 11), parent: 1, parentBranch: 0 },
    ],
  };
}

describe("sequence folding (layout)", () => {
  const measure = fixedMeasurer();
  let d: SequenceDiagram;
  beforeEach(() => (d = toSequenceDiagram(nested())));

  it("draws a folded fragment as its header and a summary, without its contents", () => {
    const open = layoutSequence(d, measure);
    const folded = layoutSequence(d, measure, { folded: new Set(["b0"]) });
    const frag = folded.items.find((i): i is PlacedFragment => i.type === "fragment" && i.ref.id === "b0");
    assert.ok(frag?.folded);
    assert.strictEqual(frag.summary?.text, "folded: 2 branches, 4 messages, 1 note");
    // Nothing inside b0 is placed: no nested fragments, only the first message.
    assert.deepStrictEqual(
      folded.items.map((i) => i.ref.id),
      ["m0", "b0"],
    );
    assert.ok(folded.height < open.height, "folding shortens the diagram");
    // Only the first operand (whose guard the header shows) is listed.
    assert.deepStrictEqual(frag.operands.map((o) => o.guard.text), ["[a]"]);
  });

  it("keeps the spacing between lifelines when a fragment folds", () => {
    // Gaps are sized from every label, folded or not, so folding never
    // re-spaces the columns. (The whole drawing may shift a few pixels: the
    // fit pass aligns its leftmost content with the margin.)
    const gaps = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]);
    const open = layoutSequence(d, measure);
    const folded = layoutSequence(d, measure, { folded: new Set(["b0"]) });
    assert.deepStrictEqual(gaps(folded.lifelines.map((l) => l.x)), gaps(open.lifelines.map((l) => l.x)));
  });

  it("does not activate a callee whose call is folded away", () => {
    const folded = layoutSequence(d, measure, { folded: new Set(["b0"]) });
    assert.strictEqual(folded.activations.filter((a) => a.lifeline === 2).length, 0);
    assert.ok(folded.items.some((i): i is PlacedMessage => i.type === "message" && i.label.text === "now()"));
  });

  it("starts the summary clear of the entry's activation bar", () => {
    const folded = layoutSequence(d, measure, { folded: new Set(["b0"]) });
    const frag = folded.items.find((i): i is PlacedFragment => i.type === "fragment") as PlacedFragment;
    const entryBar = folded.activations.find((a) => a.lifeline === 0);
    assert.ok(entryBar && frag.summary);
    assert.ok(frag.summary.x >= entryBar.box.x + entryBar.box.w);
    assert.ok(frag.summary.x + measure.width(frag.summary.text, "small") <= frag.box.x + frag.box.w);
  });
});

describe("sequence folding (state)", () => {
  let d: SequenceDiagram;
  beforeEach(() => (d = toSequenceDiagram(nested())));

  it("knows each fragment's nesting depth", () => {
    assert.deepStrictEqual([...fragmentDepths(d)], [["b0", 0], ["b1", 1], ["b2", 2]]);
  });

  it(`folds fragments ${DEFAULT_FOLD_DEPTH} deep or deeper by default, and lets the reader override`, () => {
    assert.deepStrictEqual([...foldedSet(d, new Map())], ["b2"]);
    assert.deepStrictEqual([...foldedSet(d, new Map([["b2", false], ["b0", true]]))], ["b0"]);
  });

  it("maps what a fold hides to the outermost folded fragment", () => {
    const hidden = hiddenBy(d, new Set(["b0", "b2"]));
    assert.strictEqual(hidden.get("m1"), "b0");
    assert.strictEqual(hidden.get("b1"), "b0");
    assert.strictEqual(hidden.get("m4"), "b0", "b2's contents report the outer fold");
    assert.strictEqual(hidden.get("b0.1"), "b0", "a later operand is hidden");
    assert.ok(!hidden.has("b0.0"), "the first operand's guard is still drawn");
    assert.ok(!hidden.has("m0"));
  });
});

describe("elementAt (the editor's cursor in the diagram)", () => {
  const d = toSequenceDiagram(nested());
  const ranges = rangesOf(d);

  it("picks the smallest range around the cursor", () => {
    assert.strictEqual(elementAt(ranges, new Map(), { line: 10, character: 6 }), "m0");
    assert.strictEqual(elementAt(ranges, new Map(), { line: 16, character: 20 }), "m4");
    assert.strictEqual(elementAt(ranges, new Map(), { line: 19, character: 0 }), "b0", "inside the if, outside the match");
  });

  it("prefers a message, then the fragment, over a note or operand sharing its range", () => {
    // A reply note and the operands share the block's range.
    assert.strictEqual(elementAt(ranges, new Map(), { line: 11, character: 2 }), "b0");
    assert.strictEqual(elementAt(ranges, new Map(), { line: 12, character: 10 }), "m1");
  });

  it("points at the folded fragment for an element it hides", () => {
    assert.strictEqual(elementAt(ranges, hiddenBy(d, new Set(["b1"])), { line: 16, character: 20 }), "b1");
  });

  it("finds nothing outside every element", () => {
    assert.strictEqual(elementAt(ranges, new Map(), { line: 40, character: 0 }), null);
  });
});

describe("viewport geometry", () => {
  it("fits the panel's width, never above 100%, within the zoom limits", () => {
    assert.strictEqual(fitZoom(500, 1000), 1);
    assert.strictEqual(fitZoom(1000, 500), 0.5);
    assert.strictEqual(fitZoom(10_000, 100), ZOOM_MIN);
    assert.strictEqual(fitZoom(500, 0), 1, "an unmeasured panel");
    assert.strictEqual(clampZoom(99), ZOOM_MAX);
  });

  it("maps the scroll position to the minimap and back", () => {
    const r = minimapRect({ left: 200, top: 400, width: 600, height: 300 }, 2, 0.1);
    assert.deepStrictEqual(r, { x: 10, y: 20, w: 30, h: 15 });
    const to = scrollForMinimapPoint(r.x + r.w / 2, r.y + r.h / 2, { width: 600, height: 300 }, 2, 0.1);
    assert.deepStrictEqual(to, { left: 200, top: 400 });
    assert.deepStrictEqual(scrollForMinimapPoint(0, 0, { width: 600, height: 300 }, 1, 0.1), { left: 0, top: 0 });
  });

  it("offers a minimap only for a drawing much bigger than the panel", () => {
    assert.strictEqual(wantsMinimap(500, 2000, 800, 600), true);
    assert.strictEqual(wantsMinimap(500, 700, 800, 600), false);
    assert.strictEqual(wantsMinimap(500, 2000, 0, 0), false);
  });
});

describe("export: resolveCssVars", () => {
  const vars: Record<string, string> = { "--a": "#111111", "--b": "rgba(1, 2, 3, 0.5)", "--empty": " " };
  const lookup = (n: string): string | undefined => vars[n];

  it("resolves set variables, and falls back for unset or empty ones", () => {
    assert.strictEqual(resolveCssVars("fill: var(--a);", lookup), "fill: #111111;");
    assert.strictEqual(resolveCssVars("fill: var(--x, red);", lookup), "fill: red;");
    assert.strictEqual(resolveCssVars("fill: var(--empty, blue);", lookup), "fill: blue;");
    assert.strictEqual(resolveCssVars("fill: var(--x);", lookup), "fill: initial;");
  });

  it("resolves nested fallbacks and values with parentheses", () => {
    assert.strictEqual(resolveCssVars("stroke: var(--x, var(--b));", lookup), "stroke: rgba(1, 2, 3, 0.5);");
    assert.strictEqual(resolveCssVars("stroke: var(--x, var(--y, rgba(0, 0, 0, 0.4)));", lookup), "stroke: rgba(0, 0, 0, 0.4);");
    assert.strictEqual(resolveCssVars("a: var(--a); b: var(--x, 1px) solid", lookup), "a: #111111; b: 1px solid");
  });
});

describe("sequence page messages (host checks)", () => {
  const range = R(1);

  it("accepts a highlight with a range or null, and nothing else", () => {
    assert.ok(isHighlight({ type: "highlight", uri: "file:///a", range }));
    assert.ok(isHighlight({ type: "highlight", uri: "file:///a", range: null }));
    assert.ok(!isHighlight({ type: "highlight", uri: "file:///a", range: { start: { line: -1, character: 0 }, end: range.end } }));
    assert.ok(!isHighlight({ type: "highlight", uri: 3, range }));
  });

  it("accepts an SVG or base64 PNG to save, within limits", () => {
    assert.ok(isSaveFile({ type: "saveFile", format: "svg", name: "api", data: "<svg xmlns='x'></svg>" }));
    assert.ok(isSaveFile({ type: "saveFile", format: "png", name: "api", data: "iVBORw0KGgo=" }));
    assert.ok(!isSaveFile({ type: "saveFile", format: "svg", name: "api", data: "<script>" }), "not an SVG");
    assert.ok(!isSaveFile({ type: "saveFile", format: "png", name: "api", data: "not base64!" }));
    assert.ok(!isSaveFile({ type: "saveFile", format: "exe", name: "api", data: "x" }));
    assert.ok(!isSaveFile({ type: "saveFile", format: "svg", name: "x".repeat(500), data: "<svg/>" }));
    assert.ok(!isSaveFile({ type: "saveFile", format: "png", name: "api", data: "" }));
  });

  it("checks copy text and page errors", () => {
    assert.ok(isCopyText({ type: "copyText", text: "sequenceDiagram" }));
    assert.ok(!isCopyText({ type: "copyText", text: "x".repeat(1_000_001) }));
    assert.ok(isPageError({ type: "error", message: "Could not make a PNG" }));
    assert.ok(!isPageError({ type: "error", message: 1 }));
  });

  it("makes a safe file name", () => {
    assert.strictEqual(fileStem("GET /check/:client"), "GET-check-client");
    assert.strictEqual(fileStem("../../etc/passwd"), "etc-passwd");
    assert.strictEqual(fileStem("///"), "sequence");
  });
});

describe("showTiming message (#218)", () => {
  it("accepts a request id, with or without one to compare, and nothing else", () => {
    assert.ok(isShowTiming({ type: "showTiming", id: "r1" }));
    assert.ok(isShowTiming({ type: "showTiming", id: "r1", compareId: "r2" }));
    assert.ok(!isShowTiming({ type: "showTiming" }));
    assert.ok(!isShowTiming({ type: "showTiming", id: "" }));
    assert.ok(!isShowTiming({ type: "showTiming", id: 1 }));
    assert.ok(!isShowTiming({ type: "showTiming", id: "r1", compareId: 2 }));
    assert.ok(!isShowTiming({ type: "showTiming", id: "r1", compareId: "" }));
    assert.ok(!isShowTiming({ type: "showTiming", id: "x".repeat(300) }));
    assert.ok(!isShowTiming({ type: "reveal", id: "r1" }));
    assert.ok(!isShowTiming(null));
  });
});
