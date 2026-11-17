// Draw a laid-out structure scene as SVG, in UML notation (model-diagrams
// track §5): units are components (with the component icon), `consumes` is a
// usage dependency (a dashed line, open head), an actor's call is an
// association into the system, and event flows are dotted. Every element that
// stands for something in the model carries `data-bynk-ref`; those with a
// source are focusable buttons (the shared interaction layer, `../interact.ts`).

import { px, svg, svgText, svgTitle } from "../svg";
import type { Drawing } from "../viewport";
import type { StructEdge, StructItem, StructNode, StructRef } from "./ir";
import { headerReserve, nodeLines, type PlacedPort, type PlacedStructEdge, type PlacedStructNode, type StructScene } from "./layout";

const EDGE_WORD: Record<StructEdge["kind"], string> = {
  consumes: "consumes",
  wires: "uses capabilities from",
  calls: "calls",
  emits: "emits",
  subscribes: "is subscribed to by",
  delegates: "delegates to",
  assembly: "is wired to",
  invokes: "calls",
  transition: "moves to",
};

const MARK_WORD = { added: "added", changed: "changed", removed: "removed" } as const;

function identify(el: SVGElement, ref: StructRef, description: string, note?: string): void {
  el.setAttribute("data-bynk-ref", ref.id);
  const more = note ? `\n${note}` : "";
  if (!ref.loc) {
    el.setAttribute("aria-label", description);
    if (note) svgTitle(`${description}${more}`, el);
    return;
  }
  el.setAttribute("data-bynk-focusable", "");
  el.setAttribute("tabindex", "-1");
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", description);
  svgTitle(`${description}${more}\nClick to show the source.`, el);
}

function describe(n: StructNode): string {
  const what = n.stereotype ? `«${n.stereotype}» ${n.name}` : n.name;
  const extra = n.detail ? `, ${n.detail}` : "";
  const folded = n.expandable ? (n.expanded ? ", open" : ", closed") : "";
  const cycle = n.cycle ? ", on a consumes cycle" : "";
  const dimmed = n.dimmed ? ", unreachable from the initial state" : "";
  const diff = n.diff ? `, ${MARK_WORD[n.diff]}` : "";
  const current = n.current ? ", the live instance's current state" : "";
  return `${what}${extra}${folded}${cycle}${dimmed}${diff}${current}`;
}

export interface StructDrawOptions {
  title: string;
  fontFamily: string;
}

/** The drawing, with an empty head (a structure diagram pins nothing). */
export function drawStructure(scene: StructScene, opts: StructDrawOptions): Drawing {
  const head = svg("svg", { class: "bynk-diagram bynk-struct", width: scene.width, height: 0, viewBox: `0 0 ${scene.width} 0` });
  const body = svg("svg", {
    class: "bynk-diagram bynk-struct",
    width: scene.width,
    height: scene.height,
    viewBox: `0 0 ${scene.width} ${scene.height}`,
    role: "group",
    "aria-label": opts.title,
  });
  body.style.fontFamily = opts.fontFamily;
  const defs = svg("defs", {}, body);
  const m = svg("marker", {
    id: "bynk-struct-open",
    viewBox: "0 0 10 10",
    refX: 9.5,
    refY: 5,
    markerWidth: 10,
    markerHeight: 10,
    markerUnits: "userSpaceOnUse",
    orient: "auto-start-reverse",
  }, defs);
  svg("path", { d: "M0,0 L10,5 L0,10", class: "bynk-head-open" }, m);

  const names = new Map(scene.nodes.map((p) => [p.node.ref.id, p.node.stereotype ? `«${p.node.stereotype}» ${p.node.name}` : p.node.name]));
  for (const p of scene.nodes) for (const q of p.ports) names.set(q.port.ref.id, `${q.port.kind} interface ${q.port.name}`);
  const nodesG = svg("g", { class: "bynk-snodes" }, body);
  const edgesG = svg("g", { class: "bynk-sedges" }, body);
  const portsG = svg("g", { class: "bynk-sports" }, body);
  for (const p of scene.nodes) drawNode(p, nodesG);
  for (const e of scene.edges) drawEdge(e, names, edgesG);
  for (const p of scene.nodes) for (const q of p.ports) drawPort(q, p.node, portsG);
  return { head, body, width: scene.width, headHeight: 0, bodyHeight: scene.height };
}

function drawNode(p: PlacedStructNode, parent: Element): void {
  const n = p.node;
  const { x, y, w, h } = p.box;
  const g = svg("g", {
    class: [
      "bynk-snode",
      `bynk-snode--${n.kind}`,
      n.cycle ? "bynk-cycle" : "",
      n.expanded ? "bynk-snode--open" : "",
      n.muted ? "bynk-muted" : "",
      n.dimmed ? "bynk-dimmed" : "",
      n.current ? "bynk-current" : "",
      n.diff ? `bynk-diff-${n.diff}` : "",
    ].filter(Boolean).join(" "),
  }, parent);
  if (n.kind === "initial") {
    // UML's initial pseudo-state: a filled dot.
    svg("circle", { class: "bynk-initial", cx: px(x + w / 2), cy: px(y + h / 2), r: Math.min(w, h) / 2 }, g);
    identify(g, n.ref, "The initial state", n.note);
    return;
  }
  if (n.kind === "note") {
    const f = 8;
    svg("path", {
      class: "bynk-snode-box bynk-note-shape",
      d: `M${px(x)},${px(y)} H${px(x + w - f)} L${px(x + w)},${px(y + f)} V${px(y + h)} H${px(x)} Z M${px(x + w - f)},${px(y)} V${px(y + f)} H${px(x + w)}`,
    }, g);
    svgText(n.name, { class: "bynk-detail", x: px(x + 10), y: px(y + h / 2 + 4) }, g);
    identify(g, n.ref, `Note: ${n.name}`, n.note);
    return;
  }
  if (n.kind === "actor") {
    const cx = px(x + w / 2);
    svg("circle", { class: "bynk-figure", cx, cy: y + 9, r: 7 }, g);
    svg("path", {
      class: "bynk-figure",
      d: `M${cx},${y + 16} V${y + 32} M${cx - 11},${y + 22} H${cx + 11} M${cx},${y + 32} L${cx - 9},${y + 44} M${cx},${y + 32} L${cx + 9},${y + 44}`,
    }, g);
    svgText(n.name, { class: "bynk-name", x: cx, y: y + h - 4, "text-anchor": "middle" }, g);
    identify(g, n.ref, `Actor ${n.name}`);
    return;
  }
  if (n.kind === "boundary") {
    svg("rect", { class: "bynk-boundary", x: px(x), y: px(y), width: px(w), height: px(h), rx: 8 }, g);
    svgText(n.name, { class: "bynk-boundary-label", x: px(x + 12), y: px(y + 19) }, g);
    identify(g, n.ref, "The system boundary");
    return;
  }
  const rx = n.kind === "event" ? Math.min(h / 2, 14) : n.kind === "state" || n.kind === "computed" ? 10 : 3;
  svg("rect", { class: "bynk-snode-box", x: px(x), y: px(y), width: px(w), height: px(h), rx }, g);
  if (n.kind === "context" || n.kind === "adapter") {
    // The UML component icon, top right.
    const ix = x + w - 20;
    const iy = y + 6;
    svg("path", {
      class: "bynk-component-icon",
      d: `M${px(ix + 3)},${px(iy)} H${px(ix + 14)} V${px(iy + 14)} H${px(ix + 3)} Z M${px(ix)},${px(iy + 3)} H${px(ix + 6)} V${px(iy + 6)} H${px(ix)} Z M${px(ix)},${px(iy + 8)} H${px(ix + 6)} V${px(iy + 11)} H${px(ix)} Z`,
    }, g);
  }
  const lines = n.expanded ? nodeLines({ ...n, detail: null }) : nodeLines(n);
  const items = n.items ?? [];
  const cx = n.expanded ? x + 12 : x + (w - headerReserve(n)) / 2;
  const anchor = n.expanded ? "start" : "middle";
  // A part with a compartment keeps its header at the top.
  const startY = n.expanded ? y + 18 : items.length > 0 ? y + 10 + 12 : y + h / 2 - ((lines.length - 1) * 16) / 2 + 4;
  lines.forEach((l, i) => {
    svgText(l.text, {
      class: l.role === "name" ? "bynk-name" : i === 0 && n.stereotype ? "bynk-stereotype" : "bynk-detail",
      x: px(cx),
      y: px(startY + i * 16),
      "text-anchor": anchor,
    }, g);
  });
  identify(g, n.ref, describe(n), n.note);
  if (items.length > 0) {
    const ruleY = y + 10 + lines.length * 16 + 4;
    svg("path", { class: "bynk-compartment-rule", d: `M${px(x)},${px(ruleY)} H${px(x + w)}` }, g);
    items.forEach((item, i) => drawItem(item, n, { x, w, y: ruleY + 16 + i * 16 }, g));
  }
  if (n.opens) {
    // Clear of the component icon, and of an open unit's fold toggle.
    const ox = n.kind === "context" || n.kind === "adapter" ? x + w - (n.expanded ? 52 : 34) : x + w - 12;
    drawOpenLink(n.ref.id, `Open the component view of ${n.name}`, ox, y + 14, g);
  }
  if (n.expandable) {
    const fx = n.expanded ? x + w - 34 : x + w - 14;
    const fy = n.expanded ? y + 13 : y + h / 2;
    const toggle = svg("g", { class: "bynk-fold", "data-bynk-fold-toggle": n.ref.id }, g);
    svg("rect", { class: "bynk-fold-hit", x: px(fx - 7), y: px(fy - 7), width: 14, height: 14 }, toggle);
    svg("path", {
      class: "bynk-fold-glyph",
      d: n.expanded
        ? `M${px(fx - 4)},${px(fy - 2)} L${px(fx + 4)},${px(fy - 2)} L${px(fx)},${px(fy + 3)} Z`
        : `M${px(fx - 2)},${px(fy - 4)} L${px(fx + 3)},${px(fy)} L${px(fx - 2)},${px(fy + 4)} Z`,
    }, toggle);
    g.setAttribute("data-bynk-foldable", n.ref.id);
    g.setAttribute("aria-expanded", String(n.expanded));
  }
}

/** One compartment line: its own element, linked to its source; an
 *  operation also has a ↗ that opens its sequence diagram. */
function drawItem(item: StructItem, owner: StructNode, at: { x: number; w: number; y: number }, parent: Element): void {
  const g = svg("g", { class: `bynk-item bynk-item--${item.role}` }, parent);
  svgText(item.text, { class: "bynk-item-text", x: px(at.x + 12), y: px(at.y) }, g);
  const what = item.role === "operation" ? `Operation ${item.text} of ${owner.name}` : `${item.text}, of ${owner.name}`;
  identify(g, item.ref, what);
  if (item.role === "operation") drawOpenLink(item.ref.id, `Open the sequence diagram of ${owner.name} ${item.text}`, at.x + at.w - 12, at.y - 4, parent);
}

/** A ↗ link: its own focusable button, marked `data-bynk-open` so the
 *  interaction layer opens what it leads to rather than revealing source. Its
 *  ref is the element's id plus `.open`. */
function drawOpenLink(id: string, description: string, x: number, y: number, parent: Element): void {
  const link = svg("g", {
    class: "bynk-ref-link",
    "data-bynk-ref": `${id}.open`,
    "data-bynk-focusable": "",
    "data-bynk-open": "",
    tabindex: "-1",
    role: "button",
    "aria-label": description,
  }, parent);
  svg("rect", { class: "bynk-ref-hit", x: px(x - 7), y: px(y - 7), width: 14, height: 14 }, link);
  svgText("↗", { class: "bynk-ref-glyph", x: px(x), y: px(y + 4), "text-anchor": "middle" }, link);
  svgTitle(`${description}.`, link);
}

/** A port on a component's border, with the UML ball (provided) or socket
 *  (required) outside it, and its interface's name. */
function drawPort(p: PlacedPort, owner: StructNode, parent: Element): void {
  const { x, y, w, h } = p.box;
  const g = svg("g", { class: `bynk-port bynk-port--${p.port.kind}` }, parent);
  // One target for the square, its ball or socket, and its name.
  const l0 = p.label;
  const hx = Math.min(x - 18, l0.x);
  const hy = Math.min(y, l0.y);
  svg("rect", {
    class: "bynk-ref-hit",
    x: px(hx),
    y: px(hy),
    width: px(Math.max(x + w + 18, l0.x + l0.w) - hx),
    height: px(Math.max(y + h, l0.y + l0.h) - hy),
  }, g);
  svg("rect", { class: "bynk-port-box", x: px(x), y: px(y), width: px(w), height: px(h) }, g);
  const cy = y + h / 2;
  if (p.side === "left") {
    const ox = x;
    svg("path", { class: "bynk-port-stem", d: `M${px(ox)},${px(cy)} H${px(ox - 6)}` }, g);
    if (p.port.kind === "provided") svg("circle", { class: "bynk-port-ball", cx: px(ox - 11), cy: px(cy), r: 5 }, g);
    else svg("path", { class: "bynk-port-socket", d: `M${px(ox - 8)},${px(cy - 7)} A7,7 0 0,1 ${px(ox - 8)},${px(cy + 7)}` }, g);
  } else {
    const ox = x + w;
    svg("path", { class: "bynk-port-stem", d: `M${px(ox)},${px(cy)} H${px(ox + 6)}` }, g);
    if (p.port.kind === "provided") svg("circle", { class: "bynk-port-ball", cx: px(ox + 11), cy: px(cy), r: 5 }, g);
    else svg("path", { class: "bynk-port-socket", d: `M${px(ox + 13)},${px(cy - 7)} A7,7 0 0,0 ${px(ox + 13)},${px(cy + 7)}` }, g);
  }
  const l = p.label;
  svgText(p.port.name, { class: "bynk-port-label", x: px(l.x + l.w / 2), y: px(l.y + l.h / 2 + 4), "text-anchor": "middle" }, g);
  const what = p.port.kind === "provided" ? "Provided interface" : "Required interface";
  identify(g, p.port.ref, `${what} ${p.port.name} of ${owner.name}`);
}

function drawEdge(p: PlacedStructEdge, names: Map<string, string>, parent: Element): void {
  const e = p.edge;
  if (p.points.length < 2) return;
  const g = svg("g", {
    class: [
      "bynk-sedge",
      `bynk-sedge--${e.kind}`,
      e.cycle ? "bynk-cycle" : "",
      e.flag ? `bynk-flag-${e.flag.toLowerCase()}` : "",
      e.diff ? `bynk-diff-${e.diff}` : "",
    ].filter(Boolean).join(" "),
  }, parent);
  // JSON, not a joined string: a tag (a handler's name) is the model's text.
  if (e.tags && e.tags.length > 0) g.setAttribute("data-bynk-tags", JSON.stringify(e.tags));
  const d = p.points.map((pt, i) => `${i === 0 ? "M" : "L"}${px(pt.x)},${px(pt.y)}`).join(" ");
  svg("path", { class: "bynk-hit", d }, g);
  // An assembly connector is a plain line: the ball and socket say which way.
  const head = e.kind === "assembly" ? {} : { "marker-end": "url(#bynk-struct-open)" };
  svg("path", { class: "bynk-sedge-line", d, ...head }, g);
  if (p.label) {
    const l = p.label;
    svg("rect", { class: "bynk-sedge-label-box", x: px(l.x), y: px(l.y), width: px(l.w), height: px(l.h), rx: 2 }, g);
    svgText(l.text, { class: "bynk-sedge-label", x: px(l.x + l.w / 2), y: px(l.y + l.h / 2 + 4), "text-anchor": "middle" }, g);
  }
  const from = names.get(e.source) ?? e.source;
  const to = names.get(e.target) ?? e.target;
  const what = e.label ? `: ${e.label}` : "";
  const cycle = e.cycle ? " (a consumes cycle)" : "";
  const diff = e.diff ? ` (${MARK_WORD[e.diff]})` : "";
  identify(g, e.ref, `${from} ${EDGE_WORD[e.kind]} ${to}${what}${cycle}${diff}`, e.note);
}
