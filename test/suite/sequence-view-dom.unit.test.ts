// Model-diagrams slice 1: the sequence webview entry (`src/webview/main.ts`)
// drawing through the diagram engine, in jsdom. Checks identity (one element
// per model id), that source text stays text, click and keyboard reveal,
// keyboard navigation, focus kept across a live update, and Copy as Mermaid.

import * as assert from "assert";

import type { SequencePayload } from "../../src/webview/types";
import { HOSTILE, setupDom, settle, type Dom } from "./domHarness";

const R = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 4 } });

function payload(label = "now()"): SequencePayload {
  return {
    uri: "file:///a.bynk",
    model: {
      participants: [
        { id: 0, kind: "Actor", name: "Visitor", range: R(1) },
        { id: 1, kind: "Entry", name: "api", range: null },
        { id: 2, kind: "Capability", name: "Clock", range: R(2) },
      ],
      messages: [
        { from: 0, to: 1, kind: "Call", label: "GET /", range: R(10), block: null },
        { from: 1, to: 2, kind: "Call", label, range: R(11), block: 0 },
        { from: 2, to: 1, kind: "Return", label: "", range: R(12), block: 0 },
      ],
      blocks: [
        {
          id: 0,
          kind: "If",
          branches: [
            { label: "ready", messageIds: [1, 2], reply: "Ok(t)" },
            { label: "else", messageIds: [], reply: null },
          ],
          range: R(13),
          parent: null,
          parentBranch: null,
        },
      ],
    },
  };
}

describe("sequence view (jsdom)", () => {
  let dom: Dom;
  const open = async (p: SequencePayload | null = payload()): Promise<void> => {
    dom = setupDom({ __BYNK_SEQUENCE_MODEL__: p });
    dom.load("main");
    await settle();
  };
  afterEach(() => dom.dispose());

  const el = (id: string): SVGElement => {
    const found = dom.root.querySelectorAll<SVGElement>(`[data-bynk-ref="${id}"]`);
    assert.strictEqual(found.length, 1, `exactly one element for ${id}`);
    return found[0];
  };

  it("draws one element per model id, without Mermaid", async () => {
    await open();
    assert.strictEqual(dom.mermaid.calls.length, 0);
    assert.ok(dom.root.querySelector("svg.bynk-seq"));
    for (const id of ["p0", "p1", "p2", "m0", "m1", "m2", "b0", "b0.0", "b0.1", "n0", "n1"]) el(id);
    assert.strictEqual(el("p2").querySelector(".bynk-name")?.textContent, "Clock");
    assert.strictEqual(el("p2").querySelector(".bynk-stereotype")?.textContent, "«capability»");
  });

  it("draws reply arrows dashed and calls with a filled head", async () => {
    await open();
    assert.ok(el("m1").classList.contains("bynk-msg--sync"));
    assert.ok(el("m2").classList.contains("bynk-msg--reply"));
    assert.strictEqual(el("m1").querySelector(".bynk-msg-line")?.getAttribute("marker-end"), "url(#bynk-seq-filled)");
  });

  it("renders source text as text, never as elements", async () => {
    await open(payload(HOSTILE));
    assert.strictEqual(dom.root.querySelectorAll("img, script").length, 0);
    assert.ok(el("m1").querySelector(".bynk-label")?.textContent?.includes("<img"));
  });

  it("reveals source on a click and on Enter, and not for the entry, which has none", async () => {
    await open();
    el("m1").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "reveal", uri: "file:///a.bynk", range: R(11) }]);
    el("b0").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "reveal", uri: "file:///a.bynk", range: R(13) }]);
    const before = dom.posted.length;
    el("p1").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual(dom.posted.length, before);
    assert.ok(!el("p1").hasAttribute("tabindex"));
  });

  it("keeps one element in the tab order and moves focus with the arrow keys", async () => {
    await open();
    const tabbable = dom.root.querySelectorAll('[tabindex="0"]');
    assert.strictEqual(tabbable.length, 1);
    assert.strictEqual(tabbable[0].getAttribute("data-bynk-ref"), "p0");
    el("m0").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.strictEqual(dom.document.activeElement?.getAttribute("data-bynk-ref"), "b0");
    assert.strictEqual(dom.root.querySelectorAll('[tabindex="0"]').length, 1);
  });

  it("keeps focus on the same element across a live update", async () => {
    await open();
    (el("m1") as unknown as { focus(): void }).focus();
    dom.post({ type: "update", payload: payload("later()"), view: { target: { uri: "file:///a.bynk" }, followsCursor: true } });
    await settle();
    assert.strictEqual(dom.document.activeElement?.getAttribute("data-bynk-ref"), "m1");
    assert.ok(el("m1").querySelector(".bynk-label")?.textContent?.includes("later()"));
  });

  it("asks the host to copy the diagram as Mermaid", async () => {
    await open();
    (dom.document.getElementById("bynk-copy-mermaid") as HTMLButtonElement).click();
    const copy = dom.posted.slice(-1)[0] as { type: string; text: string };
    assert.strictEqual(copy.type, "copyText");
    assert.ok(copy.text.startsWith("sequenceDiagram"));
  });

  it("says so when there is no model", async () => {
    await open(null);
    assert.strictEqual(dom.root.textContent, "No sequence model to render.");
  });
});

describe("sequence view reading aids (jsdom, slice 2)", () => {
  let dom: Dom;
  const open = async (p: SequencePayload | null = payload()): Promise<void> => {
    dom = setupDom({ __BYNK_SEQUENCE_MODEL__: p });
    dom.load("main");
    await settle();
  };
  afterEach(() => dom.dispose());
  const q = (sel: string): Element | null => dom.root.querySelector(sel);
  const view = { target: { uri: "file:///a.bynk" }, followsCursor: true };

  it("pins the lifeline heads in their own strip above the scrolling body", async () => {
    await open();
    assert.ok(q(".bynk-viewport .bynk-sticky-head svg.bynk-seq-head [data-bynk-ref=\"p2\"]"));
    assert.ok(!q(".bynk-viewport-body [data-bynk-ref=\"p2\"]"), "heads are not drawn twice");
    assert.ok(q(".bynk-viewport-body [data-bynk-ref=\"m1\"]"));
  });

  it("folds a fragment from its toggle, and unfolds it again", async () => {
    await open();
    (q('[data-bynk-fold-toggle="b0"]') as Element).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.strictEqual(q('[data-bynk-foldable="b0"]')?.getAttribute("aria-expanded"), "false");
    assert.ok(!q('[data-bynk-ref="m1"]'), "the fragment's contents are hidden");
    assert.ok(q(".bynk-frag-summary")?.textContent?.startsWith("folded:"));
    assert.ok(!dom.posted.some((m) => (m as { type: string }).type === "reveal"), "folding does not open the source");
    (q('[data-bynk-fold-toggle="b0"]') as Element).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.ok(q('[data-bynk-ref="m1"]'));
  });

  it("folds with Space on the fragment's tab, and keeps the fold across a live update", async () => {
    await open();
    (q('[data-bynk-ref="b0"]') as Element).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await settle();
    assert.strictEqual(q('[data-bynk-foldable="b0"]')?.getAttribute("aria-expanded"), "false");
    dom.post({ type: "update", payload: payload("later()"), view });
    await settle();
    assert.strictEqual(q('[data-bynk-foldable="b0"]')?.getAttribute("aria-expanded"), "false");
  });

  it("drops the reader's folds when the view moves to another handler", async () => {
    await open();
    (q('[data-bynk-fold-toggle="b0"]') as Element).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await settle();
    const other = payload();
    other.model.participants[1] = { ...other.model.participants[1], name: "other" };
    dom.post({ type: "update", payload: other, view });
    await settle();
    assert.strictEqual(q('[data-bynk-foldable="b0"]')?.getAttribute("aria-expanded"), "true");
  });

  it("marks the element under the editor's cursor, and only for its own file", async () => {
    await open();
    dom.post({ type: "cursor", uri: "file:///a.bynk", position: { line: 11, character: 2 } });
    await settle();
    assert.deepStrictEqual(
      Array.from(dom.root.querySelectorAll(".bynk-current")).map((e) => e.getAttribute("data-bynk-ref")),
      ["m1"],
    );
    dom.post({ type: "cursor", uri: "file:///other.bynk", position: { line: 11, character: 2 } });
    await settle();
    assert.strictEqual(dom.root.querySelectorAll(".bynk-current").length, 0);
  });

  it("asks the host to mark the source of the element under the pointer, and to clear it", async () => {
    await open();
    (q('[data-bynk-ref="m1"]') as Element).dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "highlight", uri: "file:///a.bynk", range: R(11) }]);
    (q(".bynk-viewport") as Element).dispatchEvent(new dom.window.MouseEvent("mouseleave"));
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "highlight", uri: "file:///a.bynk", range: null }]);
  });

  it("zooms from the toolbar and keeps the zoom across an update", async () => {
    await open();
    const label = (): string | null | undefined => dom.document.getElementById("bynk-zoom-label")?.textContent;
    assert.strictEqual(label(), "100% (fit)");
    (dom.document.getElementById("bynk-zoom-in") as HTMLButtonElement).click();
    assert.strictEqual(label(), "125%");
    const svg = q(".bynk-viewport-body svg") as SVGSVGElement;
    const w = Number(svg.getAttribute("width"));
    assert.ok(w > Number(svg.getAttribute("viewBox")?.split(" ")[2]), "the drawing is scaled up");
    dom.post({ type: "update", payload: payload("later()"), view });
    await settle();
    assert.strictEqual(label(), "125%");
    (dom.document.getElementById("bynk-zoom-fit") as HTMLButtonElement).click();
    assert.strictEqual(label(), "100% (fit)");
  });

  it("zooms with the keyboard and Ctrl+wheel, within the limits", async () => {
    await open();
    const vp = q(".bynk-viewport") as HTMLElement;
    const label = (): string | null | undefined => dom.document.getElementById("bynk-zoom-label")?.textContent;
    const key = (k: string): void => void vp.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("+");
    assert.strictEqual(label(), "125%");
    key("-");
    key("-");
    assert.strictEqual(label(), "80%");
    key("0");
    assert.strictEqual(label(), "100% (fit)");
    for (let i = 0; i < 20; i++) key("-");
    assert.strictEqual(label(), "25%");
    vp.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -500, ctrlKey: true, bubbles: true, cancelable: true }));
    assert.notStrictEqual(label(), "25%");
    const before = label();
    vp.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -500, bubbles: true }));
    assert.strictEqual(label(), before, "a plain wheel scrolls; it does not zoom");
    (dom.document.getElementById("bynk-zoom-100") as HTMLButtonElement).click();
    assert.strictEqual(label(), "100%");
  });

  it("moves to the first and last element with Home and End, and back with the arrows", async () => {
    await open();
    const focused = (): string | null | undefined => dom.document.activeElement?.getAttribute("data-bynk-ref");
    const key = (on: string, k: string): void =>
      void (q(`[data-bynk-ref="${on}"]`) as Element).dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("p0", "End");
    const last = focused();
    assert.ok(last && last !== "p0");
    key(last, "Home");
    assert.strictEqual(focused(), "p0");
    key("p0", "ArrowUp");
    assert.strictEqual(focused(), "p0", "nothing before the first");
    key("m1", "ArrowLeft");
    assert.ok(focused() && focused() !== "m1");
    key("m1", "x");
    assert.notStrictEqual(focused(), "m1", "other keys do nothing");
  });

  it("exports a standalone SVG with the theme's colours resolved", async () => {
    await open();
    (dom.document.getElementById("bynk-save-svg") as HTMLButtonElement).click();
    await settle();
    const saved = dom.posted.slice(-1)[0] as { type: string; format: string; name: string; data: string };
    assert.strictEqual(saved.type, "saveFile");
    assert.strictEqual(saved.format, "svg");
    assert.strictEqual(saved.name, "api");
    assert.ok(saved.data.startsWith("<svg"));
    assert.ok(!saved.data.includes("var(--"), "no VS Code variables left");
    assert.ok(!/data-bynk-|tabindex/.test(saved.data), "nothing interactive exported");
    assert.ok(saved.data.includes("Clock") && saved.data.includes("now()"));
  });
});
