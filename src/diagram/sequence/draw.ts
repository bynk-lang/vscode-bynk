// Draw a laid-out sequence scene as SVG, in UML notation (model-diagrams track
// §5): a synchronous call is a solid line with a filled head, a reply a dashed
// line with an open head, an asynchronous send a solid line with an open head.
// Lifelines carry their stereotype, the principal is a stick figure, and
// activation bars mark when a lifeline is executing.
//
// Every element that stands for something in the model carries
// `data-bynk-ref`, its IR id. Interaction (`../interact.ts`) looks elements up
// by that id; nothing depends on DOM order or on a renderer's internal naming.
// Elements with a source range are also focusable buttons with an accessible
// name and a tooltip.

import { px, svg, svgText, svgTitle } from "../svg";
import type { ArrowKind, SourceRef } from "./ir";
import type { PlacedFragment, PlacedLifeline, PlacedMessage, PlacedNote, SequenceScene } from "./layout";

const ARROW_WORD: Record<ArrowKind, string> = { sync: "Call", reply: "Reply", async: "Send" };

const TONE_WORD: Record<PlacedNote["tone"], string> = {
  reply: "Yields",
  collapsed: "Nested branching",
  empty: "Empty branch",
  state: "State write",
};

/** Mark `el` as standing for `ref`; a focusable button when it has a source. */
function identify(el: SVGElement, ref: SourceRef, description: string): void {
  el.setAttribute("data-bynk-ref", ref.id);
  if (!ref.range) return;
  el.setAttribute("data-bynk-focusable", "");
  el.setAttribute("tabindex", "-1");
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", description);
  svgTitle(`${description}\nClick to show the source.`, el);
}

function lifelineName(l: PlacedLifeline | undefined): string {
  return l ? (l.stereotype ? `«${l.stereotype}» ${l.name}` : l.name) : "?";
}

export interface DrawOptions {
  /** The diagram's accessible name. */
  title: string;
  /** The font family layout measured with. */
  fontFamily: string;
}

/** The drawing in two parts: the lifeline heads, which the viewport pins to
 *  the top as the body scrolls (sticky headers), and the body. Both share the
 *  scene's coordinates: the head strip is the scene's top `headHeight`, the
 *  body the rest. */
export interface SequenceDrawing {
  head: SVGSVGElement;
  body: SVGSVGElement;
  width: number;
  headHeight: number;
  bodyHeight: number;
}

export function drawSequence(scene: SequenceScene, opts: DrawOptions): SequenceDrawing {
  const headHeight = scene.lifelines[0]?.lineTop ?? 0;
  const bodyHeight = Math.max(scene.height - headHeight, 1);
  const head = svg("svg", {
    class: "bynk-diagram bynk-seq bynk-seq-head",
    width: scene.width,
    height: headHeight,
    viewBox: `0 0 ${scene.width} ${headHeight}`,
    role: "group",
    "aria-label": `${opts.title}: lifelines`,
  });
  head.style.fontFamily = opts.fontFamily;
  const root = svg("svg", {
    class: "bynk-diagram bynk-seq",
    width: scene.width,
    height: bodyHeight,
    viewBox: `0 ${headHeight} ${scene.width} ${bodyHeight}`,
    role: "group",
    "aria-label": opts.title,
  });
  root.style.fontFamily = opts.fontFamily;

  const defs = svg("defs", {}, root);
  const marker = (id: string, filled: boolean): void => {
    const m = svg("marker", {
      id,
      viewBox: "0 0 10 10",
      refX: 9.5,
      refY: 5,
      markerWidth: 10,
      markerHeight: 10,
      markerUnits: "userSpaceOnUse",
      orient: "auto-start-reverse",
    }, defs);
    svg("path", { d: filled ? "M0,0 L10,5 L0,10 z" : "M0,0 L10,5 L0,10", class: filled ? "bynk-head-filled" : "bynk-head-open" }, m);
  };
  marker("bynk-seq-filled", true);
  marker("bynk-seq-open", false);

  const lines = svg("g", { class: "bynk-lines" }, root);
  const heads = svg("g", { class: "bynk-heads" }, head);
  const items = svg("g", { class: "bynk-items" }, root);

  for (const l of scene.lifelines) {
    svg("line", { class: "bynk-lifeline-line", x1: px(l.x), y1: l.lineTop, x2: px(l.x), y2: l.lineBottom }, lines);
    drawHead(l, heads);
  }
  for (const a of scene.activations) {
    svg("rect", { class: "bynk-activation", x: px(a.box.x), y: px(a.box.y), width: a.box.w, height: px(a.box.h) }, lines);
  }
  for (const item of scene.items) {
    if (item.type === "message") drawMessage(item, scene, items);
    else if (item.type === "note") drawNote(item, items);
    else drawFragment(item, items);
  }
  return { head, body: root, width: scene.width, headHeight, bodyHeight };
}

function drawHead(l: PlacedLifeline, parent: Element): void {
  const g = svg("g", { class: `bynk-head bynk-head--${l.kind}` }, parent);
  const { x, y, w, h } = l.head;
  if (l.kind === "actor") {
    const cx = px(l.x);
    svg("circle", { class: "bynk-figure", cx, cy: y + 7, r: 6 }, g);
    svg("path", {
      class: "bynk-figure",
      d: `M${cx},${y + 13} V${y + 25} M${cx - 9},${y + 17} H${cx + 9} M${cx},${y + 25} L${cx - 8},${y + 33} M${cx},${y + 25} L${cx + 8},${y + 33}`,
    }, g);
    svgText(l.name, { class: "bynk-name", x: cx, y: y + h - 2, "text-anchor": "middle" }, g);
  } else {
    svg("rect", { class: "bynk-head-box", x: px(x), y, width: px(w), height: h, rx: 3 }, g);
    if (l.stereotype) {
      svgText(`«${l.stereotype}»`, { class: "bynk-stereotype", x: px(l.x), y: y + 18, "text-anchor": "middle" }, g);
      svgText(l.name, { class: "bynk-name", x: px(l.x), y: y + 36, "text-anchor": "middle" }, g);
    } else {
      svgText(l.name, { class: "bynk-name", x: px(l.x), y: y + h / 2 + 5, "text-anchor": "middle" }, g);
    }
  }
  identify(g, l.ref, `${l.kind === "actor" ? "Actor" : "Lifeline"} ${lifelineName(l)}`);
}

function drawMessage(m: PlacedMessage, scene: SequenceScene, parent: Element): void {
  const g = svg("g", { class: `bynk-msg bynk-msg--${m.arrow}` }, parent);
  const head = m.arrow === "sync" ? "url(#bynk-seq-filled)" : "url(#bynk-seq-open)";
  let d: string;
  if (m.self) {
    const x = px(m.x1);
    d = `M${x},${m.y - 8} H${x + 30} V${m.y + 8} H${x}`;
    svgText(m.label.text, { class: "bynk-label", x: px(m.labelX), y: m.y - 12, "text-anchor": m.labelAnchor }, g);
  } else {
    d = `M${px(m.x1)},${m.y} H${px(m.x2)}`;
    svgText(m.label.text, { class: "bynk-label", x: px(m.labelX), y: m.y - 6, "text-anchor": m.labelAnchor }, g);
  }
  // A wide transparent stroke under the line, so the arrow is easy to hit.
  svg("path", { class: "bynk-hit", d }, g);
  svg("path", { class: "bynk-msg-line", d, "marker-end": head }, g);
  const to = scene.lifelines[m.to];
  const what = m.label.full ? `: ${m.label.full}` : "";
  if (m.found) {
    // UML found message: it comes from outside the diagram, a filled dot.
    g.classList.add("bynk-msg--found");
    svg("circle", { class: "bynk-found-dot", cx: px(m.x1), cy: m.y, r: 4 }, g);
    identify(g, m.ref, `Found message to ${lifelineName(to)}${what}`);
    return;
  }
  const from = scene.lifelines[m.from];
  identify(g, m.ref, `${ARROW_WORD[m.arrow]} from ${lifelineName(from)} to ${lifelineName(to)}${what}`);
  if (m.callee) drawCalleeLink(m, g);
}

/** The drill-down link after a boundary call's label: opens the callee's own
 *  sequence diagram (a UML `ref`, model-diagrams slice 3). Its own focusable
 *  button, marked `data-bynk-open` so the interaction layer opens rather than
 *  reveals. */
function drawCalleeLink(m: PlacedMessage, parent: Element): void {
  const c = m.callee;
  if (!c) return;
  const description = `Open the sequence diagram of ${c.name}`;
  const link = svg("g", {
    class: "bynk-ref-link",
    "data-bynk-ref": `${m.ref.id}.ref`,
    "data-bynk-focusable": "",
    "data-bynk-open": "",
    tabindex: "-1",
    role: "button",
    "aria-label": description,
  }, parent);
  svg("rect", { class: "bynk-ref-hit", x: px(c.x - 7), y: px(c.y - 11), width: 14, height: 14 }, link);
  svgText("↗", { class: "bynk-ref-glyph", x: px(c.x), y: px(c.y), "text-anchor": "middle" }, link);
  svgTitle(`${description}.`, link);
}

function drawNote(n: PlacedNote, parent: Element): void {
  const g = svg("g", { class: `bynk-note bynk-note--${n.tone}` }, parent);
  const { x, y, w, h } = n.box;
  const fold = 7;
  svg("path", {
    class: "bynk-note-box",
    d: `M${px(x)},${px(y)} H${px(x + w - fold)} L${px(x + w)},${px(y + fold)} V${px(y + h)} H${px(x)} Z M${px(x + w - fold)},${px(y)} V${px(y + fold)} H${px(x + w)}`,
  }, g);
  svgText(n.label.text, { class: "bynk-note-text", x: px(x + w / 2), y: px(y + h / 2 + 4), "text-anchor": "middle" }, g);
  identify(g, n.ref, `${TONE_WORD[n.tone]}: ${n.label.full}`);
}

function drawFragment(f: PlacedFragment, parent: Element): void {
  const g = svg("g", { class: `bynk-frag bynk-frag--${f.operator}${f.folded ? " bynk-frag--folded" : ""}` }, parent);
  const { x, y, w, h } = f.box;
  svg("rect", { class: "bynk-frag-box", x: px(x), y: px(y), width: px(w), height: px(h) }, g);
  f.operands.forEach((op, i) => {
    if (i > 0) svg("line", { class: "bynk-frag-sep", x1: px(x), y1: px(op.y), x2: px(x + w), y2: px(op.y) }, g);
  });

  const t = f.tab;
  const tab = svg("g", { class: "bynk-frag-tab" }, g);
  svg("path", {
    class: "bynk-frag-tab-box",
    d: `M${px(t.x)},${px(t.y)} H${px(t.x + t.w)} V${px(t.y + t.h - 5)} L${px(t.x + t.w - 5)},${px(t.y + t.h)} H${px(t.x)} Z`,
  }, tab);
  svgText(f.operator, { class: "bynk-frag-op", x: px(t.x + 8), y: px(t.y + 13) }, tab);
  // The fold toggle: a triangle at the tab's right end, pointing down when
  // open and right when folded. A click on it folds; Space on the tab does.
  const toggle = svg("g", { class: "bynk-fold", "data-bynk-fold-toggle": f.ref.id }, tab);
  svg("rect", { class: "bynk-fold-hit", x: px(f.foldX - 7), y: px(f.foldY - 7), width: 14, height: 14 }, toggle);
  svg("path", {
    class: "bynk-fold-glyph",
    d: f.folded
      ? `M${px(f.foldX - 2)},${px(f.foldY - 4)} L${px(f.foldX + 3)},${px(f.foldY)} L${px(f.foldX - 2)},${px(f.foldY + 4)} Z`
      : `M${px(f.foldX - 4)},${px(f.foldY - 2)} L${px(f.foldX + 4)},${px(f.foldY - 2)} L${px(f.foldX)},${px(f.foldY + 3)} Z`,
  }, toggle);
  identify(tab, f.ref, `${f.operator} fragment${f.folded ? ", folded" : ""}`);
  tab.setAttribute("data-bynk-foldable", f.ref.id);
  tab.setAttribute("aria-expanded", String(!f.folded));
  if (f.summary) {
    svgText(f.summary.text, { class: "bynk-frag-summary", x: px(f.summary.x), y: px(f.summary.y) }, g);
  }

  for (const op of f.operands) {
    if (!op.guard.text) continue;
    const guard = svgText(op.guard.text, { class: "bynk-guard", x: px(op.guardX), y: px(op.guardY) }, g);
    identify(guard, op.ref, `${f.operator} branch ${op.guard.full}`);
  }
}
