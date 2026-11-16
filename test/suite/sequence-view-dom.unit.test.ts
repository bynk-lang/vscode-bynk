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
