// Model-diagrams slice 1: the sequence diagram's adapter (model → IR) and grid
// layout (IR → positioned scene). Both are pure, so these run without a DOM,
// with a fixed-width text measurer for exact, repeatable positions.

import * as assert from "assert";

import { toSequenceDiagram } from "../../src/diagram/sequence/adapter";
import type { FragmentEvent, MessageEvent, NoteEvent, SequenceDiagram, SequenceEvent } from "../../src/diagram/sequence/ir";
import { layoutSequence, type PlacedFragment, type PlacedMessage, type SequenceScene } from "../../src/diagram/sequence/layout";
import { fixedMeasurer } from "../../src/diagram/measure";
import { rangesOf } from "../../src/diagram/sequence/render";
import type { SequenceModel } from "../../src/webview/types";

const R = (line: number, character = 0) => ({ start: { line, character }, end: { line, character: character + 4 } });

/** A rate-limiter-shaped handler: a principal, three lifelines, a state write,
 *  and an `if` whose first branch holds a nested `match` that collapses. */
function model(): SequenceModel {
  return {
    participants: [
      { id: 0, kind: "Actor", name: "Visitor", range: R(1) },
      { id: 1, kind: "Entry", name: "api", range: null },
      { id: 2, kind: "Capability", name: "Clock", range: R(2) },
      { id: 3, kind: "Context", name: "billing", range: R(3) },
      { id: 4, kind: "Agent", name: "Limiter", range: R(4) },
    ],
    messages: [
      { from: 0, to: 1, kind: "Call", label: "GET /check", range: R(10), block: null },
      { from: 1, to: 2, kind: "Call", label: "now()", range: R(11), block: null },
      { from: 2, to: 1, kind: "Return", label: "", range: R(11, 8), block: null },
      { from: 1, to: 3, kind: "Call", label: "charge(client)", range: R(14), block: 0 },
      { from: 3, to: 1, kind: "Return", label: "", range: R(14, 8), block: 0 },
      { from: 1, to: 4, kind: "Send", label: "record(\n  client )", range: R(17), block: 0 },
      { from: 1, to: 1, kind: "StateWrite", label: "hits := hits + 1", range: R(12), block: null },
    ],
    blocks: [
      {
        id: 0,
        kind: "If",
        branches: [
          { label: "view.allowed", messageIds: [3, 4], reply: "Ok(view)" },
          { label: "else", messageIds: [5], reply: null },
          { label: "never", messageIds: [], reply: null },
        ],
        range: R(13),
        parent: null,
        parentBranch: null,
      },
      { id: 1, kind: "Collapsed", branches: [], range: R(15), parent: 0, parentBranch: 0 },
    ],
  };
}

const flatten = (events: SequenceEvent[]): SequenceEvent[] =>
  events.flatMap((e) => (e.type === "fragment" ? [e, ...e.operands.flatMap((o) => flatten(o.events))] : [e]));

describe("sequence diagram adapter (model → IR)", () => {
  let d: SequenceDiagram;
  beforeEach(() => (d = toSequenceDiagram(model())));

  it("maps participants to lifelines with UML stereotypes", () => {
    assert.deepStrictEqual(
      d.lifelines.map((l) => [l.kind, l.stereotype, l.name]),
      [
        ["actor", null, "Visitor"],
        ["entry", null, "api"],
        ["capability", "capability", "Clock"],
        ["context", "context", "billing"],
        ["agent", "agent", "Limiter"],
      ],
    );
  });

  it("orders root content by source position and maps message kinds to UML arrows", () => {
    const top = d.events.map((e) => (e.type === "message" ? `${e.arrow}:${e.label}` : e.type === "note" ? `note:${e.text}` : e.type));
    assert.deepStrictEqual(top, ["sync:GET /check", "sync:now()", "reply:", "note:hits := hits + 1", "fragment"]);
  });

  it("keeps a reply's label empty and collapses whitespace in labels", () => {
    const msgs = flatten(d.events).filter((e): e is MessageEvent => e.type === "message");
    assert.strictEqual(msgs.find((m) => m.arrow === "reply")?.label, "");
    assert.ok(msgs.some((m) => m.arrow === "async" && m.label === "record( client )"));
  });

  it("anchors every note to the entry lifeline, found by kind rather than position", () => {
    const notes = flatten(d.events).filter((e): e is NoteEvent => e.type === "note");
    assert.ok(notes.length > 0);
    for (const n of notes) assert.strictEqual(n.over, 1);
  });

  it("builds fragments: alt for several branches, guards, replies, empty branches and collapsed nesting", () => {
    const frag = d.events.find((e): e is FragmentEvent => e.type === "fragment");
    assert.ok(frag);
    assert.strictEqual(frag.operator, "alt");
    assert.deepStrictEqual(frag.operands.map((o) => o.guard), ["view.allowed", "else", "never"]);
    const first = frag.operands[0].events.map((e) => (e.type === "note" ? `${e.tone}:${e.text}` : e.type));
    assert.deepStrictEqual(first, ["message", "message", "collapsed:nested branching — click to view source", "reply:Ok(view)"]);
    assert.deepStrictEqual(frag.operands[2].events.map((e) => e.type === "note" && e.tone), ["empty"]);
  });

  it("gives every element a unique id, and every source range a lookup", () => {
    const seen = new Set<string>();
    const add = (id: string): void => {
      assert.ok(!seen.has(id), `duplicate id ${id}`);
      seen.add(id);
    };
    d.lifelines.forEach((l) => add(l.ref.id));
    flatten(d.events).forEach((e) => {
      add(e.ref.id);
      if (e.type === "fragment") e.operands.forEach((o) => add(o.ref.id));
    });
    const ranges = rangesOf(d);
    assert.ok(!ranges.has("p1"), "the entry has no source range");
    assert.deepStrictEqual(ranges.get("p2"), R(2));
    assert.deepStrictEqual(ranges.get("b0"), R(13));
  });

  it("makes a single-branch block an opt", () => {
    const m = model();
    m.blocks = [{ id: 0, kind: "If", branches: [{ label: "x", messageIds: [3], reply: null }], range: R(13), parent: null, parentBranch: null }];
    m.messages = m.messages.slice(0, 4);
    const frag = toSequenceDiagram(m).events.find((e): e is FragmentEvent => e.type === "fragment");
    assert.strictEqual(frag?.operator, "opt");
  });
});

describe("sequence diagram layout (IR → scene)", () => {
  const measure = fixedMeasurer();
  let scene: SequenceScene;
  beforeEach(() => (scene = layoutSequence(toSequenceDiagram(model()), measure)));

  it("is deterministic", () => {
    assert.deepStrictEqual(layoutSequence(toSequenceDiagram(model()), measure), scene);
  });

  it("places lifelines left to right in declaration order, with heads that do not overlap", () => {
    for (let i = 1; i < scene.lifelines.length; i++) {
      const a = scene.lifelines[i - 1].head;
      const b = scene.lifelines[i].head;
      assert.ok(a.x + a.w <= b.x, `head ${i - 1} overlaps head ${i}`);
    }
    assert.ok(scene.lifelines.every((l) => l.head.x >= 16), "nothing starts left of the margin");
  });

  it("widens gaps until every label fits between its arrow's ends", () => {
    for (const m of scene.items.filter((i): i is PlacedMessage => i.type === "message" && !i.self)) {
      assert.ok(Math.abs(m.x2 - m.x1) >= measure.width(m.label.text, "label"), `label "${m.label.text}" does not fit`);
    }
  });

  it("runs rows top to bottom in event order", () => {
    const ys = scene.items.map((i) => (i.type === "message" ? i.y : i.box.y));
    for (let k = 1; k < ys.length; k++) assert.ok(ys[k] > ys[k - 1], `item ${k} is not below item ${k - 1}`);
  });

  it("encloses a fragment's contents, and puts each later operand below its separator", () => {
    const frag = scene.items.find((i): i is PlacedFragment => i.type === "fragment");
    assert.ok(frag);
    const k = scene.items.indexOf(frag);
    for (const it of scene.items.slice(k + 1)) {
      const [x1, x2, y1, y2] =
        it.type === "message" ? [Math.min(it.x1, it.x2), Math.max(it.x1, it.x2), it.y, it.y] : [it.box.x, it.box.x + it.box.w, it.box.y, it.box.y + it.box.h];
      assert.ok(x1 >= frag.box.x && x2 <= frag.box.x + frag.box.w, "content inside horizontally");
      assert.ok(y1 >= frag.box.y && y2 <= frag.box.y + frag.box.h, "content inside vertically");
    }
    for (let i = 1; i < frag.operands.length; i++) assert.ok(frag.operands[i].y > frag.operands[i - 1].y);
  });

  it("activates the entry throughout and a callee from its call to its reply", () => {
    const entry = scene.activations.filter((a) => a.lifeline === 1);
    assert.strictEqual(entry.length, 1);
    const clock = scene.activations.filter((a) => a.lifeline === 2);
    assert.strictEqual(clock.length, 1);
    const call = scene.items.find((i): i is PlacedMessage => i.type === "message" && i.label.text === "now()");
    assert.strictEqual(clock[0].box.y, call?.y);
    // An async send starts no activation.
    assert.strictEqual(scene.activations.filter((a) => a.lifeline === 4).length, 0);
  });

  it("ends arrows at the side of an active bar rather than its centre", () => {
    const call = scene.items.find((i): i is PlacedMessage => i.type === "message" && i.label.text === "now()");
    assert.ok(call);
    assert.notStrictEqual(call.x1, scene.lifelines[1].x);
    assert.notStrictEqual(call.x2, scene.lifelines[2].x);
  });

  it("truncates a very long label for drawing and keeps it whole for the tooltip", () => {
    const m = model();
    m.messages[1].label = "x".repeat(200);
    const s = layoutSequence(toSequenceDiagram(m), measure);
    const long = s.items.find((i): i is PlacedMessage => i.type === "message" && i.label.full.length === 200);
    assert.ok(long);
    assert.ok(long.label.text.length < 70 && long.label.text.endsWith("…"));
  });

  it("lays out a model with no messages", () => {
    const s = layoutSequence(toSequenceDiagram({ participants: [{ id: 0, kind: "Entry", name: "h", range: null }], messages: [], blocks: [] }), measure);
    assert.strictEqual(s.items.length, 0);
    assert.ok(s.width > 0 && s.height > 0);
  });
});
