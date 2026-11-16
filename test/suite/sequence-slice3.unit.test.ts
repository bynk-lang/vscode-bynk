// Model-diagrams slice 3, the extension half: drawing the server's new facts.
// `?` as a `break` fragment, a found message for a handler with no principal,
// an agent lifeline's key, operands linked to their own arms (ADR 0853), and
// `ref` links that open a located callee's own diagram. Every field is
// optional: an older server sends none, and the diagram is as before.

import * as assert from "assert";

import { toSequenceDiagram } from "../../src/diagram/sequence/adapter";
import type { FragmentEvent, MessageEvent } from "../../src/diagram/sequence/ir";
import { layoutSequence, type PlacedMessage } from "../../src/diagram/sequence/layout";
import { fixedMeasurer } from "../../src/diagram/measure";
import { calleesOf } from "../../src/diagram/sequence/render";
import { isOpenSequence } from "../../src/sequenceMessages";
import { toMermaid } from "../../src/webview/mermaid-gen";
import type { SequenceModel, SequencePayload } from "../../src/webview/types";
import { setupDom, settle, type Dom } from "./domHarness";

const R = (line: number, character = 0) => ({ start: { line, character }, end: { line, character: character + 4 } });
const LIMITS = { uri: "file:///limits.bynk", range: R(40) };

function model(): SequenceModel {
  return {
    trigger: { kind: "Schedule", label: 'cron "0 * * * *"' },
    participants: [
      { id: 0, kind: "Entry", name: "sweeper cron", range: null },
      { id: 1, kind: "Agent", name: "Limiter", range: R(3), key: "client" },
      { id: 2, kind: "Context", name: "billing", range: R(4), key: null },
    ],
    messages: [
      { from: 0, to: 1, kind: "Call", label: "hit(now)", range: R(12), block: null, callee: { unit: null, owner: "Limiter", method: "hit", location: LIMITS } },
      { from: 1, to: 0, kind: "Return", label: "", range: R(12, 9), block: null, callee: null },
      { from: 0, to: 2, kind: "Send", label: "charge(c)", range: R(16), block: null, callee: { unit: "billing", owner: "Charges", method: null, location: null } },
    ],
    blocks: [
      { id: 0, kind: "Break", depth: 0, branches: [{ label: "stored?", messageIds: [], reply: "early return", range: R(14, 2) }], range: R(14), parent: null, parentBranch: null },
    ],
  };
}

/** The same handler as an older server sends it: none of slice 3's fields. */
function oldModel(): SequenceModel {
  const m = model();
  delete m.trigger;
  for (const p of m.participants) delete p.key;
  for (const msg of m.messages) delete msg.callee;
  m.blocks = [];
  return m;
}

describe("sequence slice 3 (adapter)", () => {
  it("makes a Break block a break fragment, and links each operand to its own arm", () => {
    const d = toSequenceDiagram(model());
    const frag = d.events.find((e): e is FragmentEvent => e.type === "fragment");
    assert.strictEqual(frag?.operator, "break");
    assert.strictEqual(frag.operands[0].guard, "stored?");
    assert.deepStrictEqual(frag.operands[0].ref.range, R(14, 2), "the arm's range, not the block's");
  });

  it("names an agent lifeline by its key", () => {
    assert.strictEqual(toSequenceDiagram(model()).lifelines[1].name, "Limiter[client]");
  });

  it("starts a handler with no principal from a found message labelled by its trigger", () => {
    assert.strictEqual(toSequenceDiagram(model()).found?.label, 'cron "0 * * * *"');
    const call = model();
    call.trigger = { kind: "Call", label: "hit" };
    assert.strictEqual(toSequenceDiagram(call).found?.label, "call hit");
    const ev = model();
    ev.trigger = { kind: "Event", label: "event" };
    assert.strictEqual(toSequenceDiagram(ev).found?.label, "event");
  });

  it("does not add a found message when there is a principal", () => {
    const m = model();
    m.participants.unshift({ id: 9, kind: "Actor", name: "Visitor", range: R(1) });
    assert.strictEqual(toSequenceDiagram(m).found, undefined);
  });

  it("links a located callee, and not one the server could not find", () => {
    const d = toSequenceDiagram(model());
    const msgs = d.events.filter((e): e is MessageEvent => e.type === "message");
    assert.deepStrictEqual(msgs[0].callee, { name: "Limiter.hit", location: LIMITS });
    assert.strictEqual(msgs[2].callee, undefined, "billing's callee has no location");
    assert.deepStrictEqual([...calleesOf(d)], [["m0.ref", LIMITS]]);
  });

  it("draws an older server's model exactly as before", () => {
    const d = toSequenceDiagram(oldModel());
    assert.strictEqual(d.found, undefined);
    assert.strictEqual(d.lifelines[1].name, "Limiter");
    assert.ok(d.events.every((e) => e.type !== "message" || e.callee === undefined));
  });
});

describe("sequence slice 3 (layout)", () => {
  const measure = fixedMeasurer();

  it("puts the found message first, from a dot left of the entry", () => {
    const scene = layoutSequence(toSequenceDiagram(model()), measure);
    const first = scene.items[0] as PlacedMessage;
    assert.ok(first.found);
    assert.strictEqual(first.x2, scene.lifelines[0].x - 5, "it ends at the entry's activation bar");
    assert.ok(first.x1 < first.x2 && first.x1 >= 16);
    assert.ok(first.x2 - first.x1 >= measure.width(first.label.text, "label"), "its label fits");
  });

  it("places the callee link after the label, and leaves room for it", () => {
    const scene = layoutSequence(toSequenceDiagram(model()), measure);
    const hit = scene.items.find((i): i is PlacedMessage => i.type === "message" && i.label.text === "hit(now)");
    assert.ok(hit?.callee);
    assert.ok(hit.callee.x > hit.labelX + measure.width("hit(now)", "label") / 2);
    assert.ok(hit.callee.x < Math.max(hit.x1, hit.x2), "inside the arrow's span");
  });
});

describe("sequence slice 3 (exporter and host checks)", () => {
  it("copies a break as a Mermaid break, and an agent with its key", () => {
    const text = toMermaid(model()).text;
    assert.ok(text.includes("break stored?"));
    assert.ok(text.includes("as Limiter[client]"));
  });

  it("accepts only a well-formed openSequence", () => {
    assert.ok(isOpenSequence({ type: "openSequence", uri: "file:///x.bynk", range: R(1) }));
    assert.ok(!isOpenSequence({ type: "openSequence", uri: "", range: R(1) }));
    assert.ok(!isOpenSequence({ type: "openSequence", uri: "file:///x.bynk", range: { start: { line: 0 } } }));
  });
});

describe("sequence slice 3 (jsdom)", () => {
  let dom: Dom;
  const open = async (m: SequenceModel): Promise<void> => {
    const p: SequencePayload = { model: m, uri: "file:///a.bynk" };
    dom = setupDom({ __BYNK_SEQUENCE_MODEL__: p });
    dom.load("main");
    await settle();
  };
  afterEach(() => dom.dispose());

  it("opens a callee's diagram from its ref link, by click or Enter, without revealing the call", async () => {
    await open(model());
    const link = dom.root.querySelector('[data-bynk-ref="m0.ref"]') as Element;
    assert.ok(link.hasAttribute("data-bynk-open"));
    link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "openSequence", uri: LIMITS.uri, range: LIMITS.range }]);
    link.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.deepStrictEqual(dom.posted.slice(-1), [{ type: "openSequence", uri: LIMITS.uri, range: LIMITS.range }]);
    assert.ok(!dom.posted.some((m) => (m as { type: string }).type === "reveal"));
    // The call itself still reveals its own source.
    (dom.root.querySelector('[data-bynk-ref="m0"]') as Element).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    assert.strictEqual((dom.posted.slice(-1)[0] as { type: string }).type, "reveal");
  });

  it("draws the found message's dot, the break and the keyed lifeline", async () => {
    await open(model());
    assert.ok(dom.root.querySelector(".bynk-msg--found .bynk-found-dot"));
    assert.ok(dom.root.querySelector(".bynk-frag--break"));
    assert.strictEqual(dom.root.querySelector('[data-bynk-ref="p1"] .bynk-name')?.textContent, "Limiter[client]");
    assert.strictEqual(dom.root.querySelectorAll("[data-bynk-open]").length, 1);
  });
});
