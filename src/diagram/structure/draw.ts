// Draw a laid-out structure scene as SVG, in UML notation (model-diagrams
// track §5): units are components (with the component icon), `consumes` is a
// usage dependency (a dashed line, open head), an actor's call is an
// association into the system, and event flows are dotted. Every element that
// stands for something in the model carries `data-bynk-ref`; those with a
// source are focusable buttons (the shared interaction layer, `../interact.ts`).

import { px, svg, svgText, svgTitle } from "../svg";
import type { Drawing } from "../viewport";
import type { StructEdge, StructNode, StructRef } from "./ir";
import { nodeLines, type PlacedStructEdge, type PlacedStructNode, type StructScene } from "./layout";

const EDGE_WORD: Record<StructEdge["kind"], string> = {
  consumes: "consumes",
  wires: "uses capabilities from",
  calls: "calls",
  emits: "emits",
  subscribes: "is subscribed to by",
};

function identify(el: SVGElement, ref: StructRef, description: string): void {
  el.setAttribute("data-bynk-ref", ref.id);
  if (!ref.loc) {
    el.setAttribute("aria-label", description);
    return;
  }
  el.setAttribute("data-bynk-focusable", "");
  el.setAttribute("tabindex", "-1");
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", description);
  svgTitle(`${description}\nClick to show the source.`, el);
}

function describe(n: StructNode): string {
  const what = n.stereotype ? `«${n.stereotype}» ${n.name}` : n.name;
  const extra = n.detail ? `, ${n.detail}` : "";
  const folded = n.expandable ? (n.expanded ? ", open" : ", closed") : "";
  const cycle = n.cycle ? ", on a consumes cycle" : "";
  return `${what}${extra}${folded}${cycle}`;
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
  const nodesG = svg("g", { class: "bynk-snodes" }, body);
  const edgesG = svg("g", { class: "bynk-sedges" }, body);
  for (const p of scene.nodes) drawNode(p, nodesG);
  for (const e of scene.edges) drawEdge(e, names, edgesG);
  return { head, body, width: scene.width, headHeight: 0, bodyHeight: scene.height };
}

function drawNode(p: PlacedStructNode, parent: Element): void {
  const n = p.node;
  const { x, y, w, h } = p.box;
  const g = svg("g", { class: `bynk-snode bynk-snode--${n.kind}${n.cycle ? " bynk-cycle" : ""}${n.expanded ? " bynk-snode--open" : ""}` }, parent);
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
  const rx = n.kind === "event" ? Math.min(h / 2, 14) : 3;
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
  const cx = n.expanded ? x + 12 : x + (w - (n.expandable ? 18 : 0)) / 2;
  const anchor = n.expanded ? "start" : "middle";
  const startY = n.expanded ? y + 18 : y + h / 2 - ((lines.length - 1) * 16) / 2 + 4;
  lines.forEach((l, i) => {
    svgText(l.text, {
      class: l.role === "name" ? "bynk-name" : i === 0 && n.stereotype ? "bynk-stereotype" : "bynk-detail",
      x: px(cx),
      y: px(startY + i * 16),
      "text-anchor": anchor,
    }, g);
  });
  identify(g, n.ref, describe(n));
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

function drawEdge(p: PlacedStructEdge, names: Map<string, string>, parent: Element): void {
  const e = p.edge;
  if (p.points.length < 2) return;
  const g = svg("g", { class: `bynk-sedge bynk-sedge--${e.kind}${e.cycle ? " bynk-cycle" : ""}` }, parent);
  const d = p.points.map((pt, i) => `${i === 0 ? "M" : "L"}${px(pt.x)},${px(pt.y)}`).join(" ");
  svg("path", { class: "bynk-hit", d }, g);
  svg("path", { class: "bynk-sedge-line", d, "marker-end": "url(#bynk-struct-open)" }, g);
  if (p.label) {
    const l = p.label;
    svg("rect", { class: "bynk-sedge-label-box", x: px(l.x), y: px(l.y), width: px(l.w), height: px(l.h), rx: 2 }, g);
    svgText(l.text, { class: "bynk-sedge-label", x: px(l.x + l.w / 2), y: px(l.y + l.h / 2 + 4), "text-anchor": "middle" }, g);
  }
  const from = names.get(e.source) ?? e.source;
  const to = names.get(e.target) ?? e.target;
  const what = e.label ? `: ${e.label}` : "";
  const cycle = e.cycle ? " (a consumes cycle)" : "";
  identify(g, e.ref, `${from} ${EDGE_WORD[e.kind]} ${to}${what}${cycle}`);
}
