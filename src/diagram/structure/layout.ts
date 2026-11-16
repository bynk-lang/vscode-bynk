// Structure-diagram layout: the IR plus a text measurer → a positioned scene,
// by ELK's `layered` algorithm (model-diagrams track §4.3, D2). ELK gives
// nesting (a unit opened around its members, the system boundary around the
// units), orthogonal edge routing, and edge-label placement; our part is to
// size each node from its text and turn ELK's relative coordinates into
// absolute ones.
//
// Node order is the IR's (ELK's `considerModelOrder`), so an edit that adds
// nothing new keeps the picture where it was (goal G3).

import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";

import { FONT_SIZE, type TextMeasurer } from "../measure";
import { MARK_SIGN } from "../../webview/diffMarks";
import type { StructDiagram, StructEdge, StructNode, StructPort } from "./ir";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedStructNode {
  node: StructNode;
  box: Box;
  /** 0 for a top-level node. */
  depth: number;
  /** Its ports, absolute, with their labels (component view). */
  ports: PlacedPort[];
}

export interface PlacedPort {
  port: StructPort;
  /** The port square, straddling the node's border. */
  box: Box;
  /** Which border: provided ports sit on the left, required on the right. */
  side: "left" | "right";
  label: Box;
}

export interface PlacedStructEdge {
  edge: StructEdge;
  /** The route, absolute, start to end. */
  points: { x: number; y: number }[];
  label: (Box & { text: string }) | null;
}

export interface StructScene {
  width: number;
  height: number;
  /** Parents before their children, so drawing in order nests correctly. */
  nodes: PlacedStructNode[];
  edges: PlacedStructEdge[];
}

const M = {
  margin: 16,
  padX: 12,
  line: 16,
  padY: 10,
  minW: 110,
  toggleW: 18,
  actorW: 60,
  actorH: 66,
  headerUnit: 50,
  headerBoundary: 30,
  inner: 14,
  labelPad: 6,
  /** The compartment's rule and its gap above the first item. */
  rule: 8,
  port: 12,
  /** Room for the ball or socket drawn outside a port. */
  portReach: 12,
};

/** A node's text lines, top to bottom, with their type sizes. */
export function nodeLines(n: StructNode): { text: string; role: "small" | "name" }[] {
  const lines: { text: string; role: "small" | "name" }[] = [];
  if (n.stereotype) lines.push({ text: `«${n.stereotype}»`, role: "small" });
  // A diff's mark is a sign as well as a colour.
  lines.push({ text: n.diff ? `${MARK_SIGN[n.diff]} ${n.name}` : n.name, role: "name" });
  if (n.detail) lines.push({ text: n.detail, role: "small" });
  return lines;
}

/** The extra width an open-in-its-own-view link takes in a header. */
const OPEN_W = 18;

/** Width kept clear at the right of a closed node's centred text: the
 *  component icon and the ↗ link on the top row, the fold toggle at mid
 *  height. `draw.ts` centres the text in what is left. */
export function headerReserve(n: StructNode): number {
  const unit = n.kind === "context" || n.kind === "adapter";
  const top = (unit ? 22 : 0) + (n.opens ? OPEN_W : 0);
  return Math.max(top, n.expandable ? M.toggleW : 0);
}

function leafSize(n: StructNode, measure: TextMeasurer): { width: number; height: number } {
  if (n.kind === "actor") return { width: Math.max(M.actorW, measure.width(n.name, "name") + 8), height: M.actorH };
  if (n.kind === "initial") return { width: 18, height: 18 };
  if (n.kind === "note") return { width: measure.width(n.name, "small") + 2 * M.padX + 8, height: 30 };
  const lines = nodeLines(n);
  const items = n.items ?? [];
  const w = Math.max(
    ...lines.map((l) => measure.width(l.text, l.role) + headerReserve(n)),
    ...items.map((i) => measure.width(i.text, "small") + (i.role === "operation" ? OPEN_W : 0)),
  );
  return {
    width: Math.max(M.minW, w + 2 * M.padX),
    height: M.padY * 2 + lines.length * M.line + (items.length > 0 ? M.rule + items.length * M.line : 0),
  };
}

function elkPorts(n: StructNode, measure: TextMeasurer): Pick<ElkNode, "ports"> & { layoutOptions?: Record<string, string> } {
  const ports = n.ports ?? [];
  if (ports.length === 0) return {};
  return {
    ports: ports.map((p) => ({
      id: p.ref.id,
      width: M.port,
      height: M.port,
      layoutOptions: {
        "elk.port.side": p.kind === "provided" ? "WEST" : "EAST",
        "elk.port.borderOffset": String(-M.port / 2),
      },
      labels: [{ text: p.name, width: measure.width(p.name, "small") + 4, height: FONT_SIZE.small + 4 }],
    })),
    layoutOptions: {
      "elk.portConstraints": "FIXED_SIDE",
      "elk.portLabels.placement": "OUTSIDE",
      "elk.spacing.portPort": "30",
      "elk.spacing.portsSurrounding": "[top=40,left=0,bottom=20,right=0]",
    },
  };
}

function toElk(n: StructNode, measure: TextMeasurer): ElkNode {
  const withPorts = elkPorts(n, measure);
  if (n.children.length === 0) {
    return { id: n.ref.id, ...leafSize(n, measure), ...withPorts };
  }
  const top = n.kind === "boundary" ? M.headerBoundary : M.headerUnit;
  // An open unit is at least as wide as its own header.
  const header = Math.max(...nodeLines({ ...n, detail: null }).map((l) => measure.width(l.text, l.role))) + 2 * M.padX + M.toggleW;
  // Ports carry labels outside the border: leave the parts room inside.
  const side = (n.ports ?? []).length > 0 ? M.inner + M.portReach + 30 : M.inner;
  return {
    id: n.ref.id,
    ports: withPorts.ports,
    layoutOptions: {
      ...withPorts.layoutOptions,
      "elk.padding": `[top=${top},left=${side},bottom=${M.inner},right=${side}]`,
      "elk.nodeSize.constraints": "MINIMUM_SIZE",
      "elk.nodeSize.minimum": `(${Math.ceil(header + (n.opens ? OPEN_W : 0))}, ${top + 20})`,
    },
    children: n.children.map((c) => toElk(c, measure)),
  };
}

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.edgeLabel": "4",
  "elk.edgeLabels.placement": "CENTER",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": `[top=${M.margin},left=${M.margin},bottom=${M.margin},right=${M.margin}]`,
};

let elk: InstanceType<typeof ELK> | undefined;

export interface StructLayoutOptions {
  /** Which way the layers run: `RIGHT` (the default; structure reads left to
   *  right) or `DOWN` (a state machine reads top to bottom). */
  direction?: "RIGHT" | "DOWN";
}

/** Lay out `diagram`. Async: ELK answers with a promise. */
export async function layoutStructure(
  diagram: StructDiagram,
  measure: TextMeasurer,
  opts: StructLayoutOptions = {},
): Promise<StructScene> {
  elk ??= new ELK();
  // ELK refuses a graph with an edge to an element it does not have; an
  // adapter should not produce one, but a dropped edge beats no diagram.
  const shapes = new Set<string>();
  const index0 = (ns: StructNode[]): void => {
    for (const n of ns) {
      shapes.add(n.ref.id);
      for (const p of n.ports ?? []) shapes.add(p.ref.id);
      index0(n.children);
    }
  };
  index0(diagram.nodes);
  const drawable = diagram.edges.filter((e) => shapes.has(e.source) && shapes.has(e.target));
  const edges: ElkExtendedEdge[] = drawable.map((e) => ({
    id: e.ref.id,
    sources: [e.source],
    targets: [e.target],
    labels: e.label
      ? [{ text: e.label, width: measure.width(e.label, "small") + 2 * M.labelPad, height: FONT_SIZE.small + 2 * M.labelPad }]
      : [],
  }));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: { ...ROOT_OPTIONS, "elk.direction": opts.direction ?? "RIGHT" },
    children: diagram.nodes.map((n) => toElk(n, measure)),
    edges,
  };
  const out = await elk.layout(graph);

  // Absolute boxes: ELK gives each child relative to its parent.
  const byId = new Map<string, StructNode>();
  const index = (ns: StructNode[]): void => {
    for (const n of ns) {
      byId.set(n.ref.id, n);
      index(n.children);
    }
  };
  index(diagram.nodes);
  const origin = new Map<string, { x: number; y: number }>([["root", { x: 0, y: 0 }]]);
  const nodes: PlacedStructNode[] = [];
  const walk = (parent: ElkNode, ox: number, oy: number, depth: number): void => {
    for (const c of parent.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      origin.set(c.id, { x, y });
      const node = byId.get(c.id);
      if (node) {
        const w = c.width ?? 0;
        const ports: PlacedPort[] = [];
        for (const ep of c.ports ?? []) {
          const port = node.ports?.find((p) => p.ref.id === ep.id);
          if (!port) continue;
          const bx = x + (ep.x ?? 0);
          const by = y + (ep.y ?? 0);
          const l = ep.labels?.[0];
          ports.push({
            port,
            box: { x: bx, y: by, w: ep.width ?? M.port, h: ep.height ?? M.port },
            side: (ep.x ?? 0) + (ep.width ?? 0) / 2 < w / 2 ? "left" : "right",
            label: { x: bx + (l?.x ?? 0), y: by + (l?.y ?? 0), w: l?.width ?? 0, h: l?.height ?? 0 },
          });
        }
        nodes.push({ node, box: { x, y, w, h: c.height ?? 0 }, depth, ports });
      }
      walk(c, x, y, depth + 1);
    }
  };
  walk(out, 0, 0, 0);

  // Edge routes: relative to the edge's container (ELK names it).
  const edgeById = new Map(drawable.map((e) => [e.ref.id, e]));
  const placedEdges: PlacedStructEdge[] = [];
  const collect = (parent: ElkNode): void => {
    for (const e of (parent.edges ?? []) as (ElkExtendedEdge & { container?: string })[]) {
      const edge = edgeById.get(e.id);
      if (!edge) continue;
      const o = origin.get(e.container ?? parent.id) ?? { x: 0, y: 0 };
      const points: { x: number; y: number }[] = [];
      for (const s of e.sections ?? []) {
        points.push({ x: o.x + s.startPoint.x, y: o.y + s.startPoint.y });
        for (const b of s.bendPoints ?? []) points.push({ x: o.x + b.x, y: o.y + b.y });
        points.push({ x: o.x + s.endPoint.x, y: o.y + s.endPoint.y });
      }
      const l = e.labels?.[0];
      const label =
        edge.label && l
          ? { text: edge.label, x: o.x + (l.x ?? 0), y: o.y + (l.y ?? 0), w: l.width ?? 0, h: l.height ?? 0 }
          : null;
      placedEdges.push({ edge, points, label });
    }
    for (const c of parent.children ?? []) collect(c);
  };
  collect(out);
  // Keep the IR's edge order, whatever order ELK reports them in.
  const order = new Map(diagram.edges.map((e, i) => [e.ref.id, i]));
  placedEdges.sort((a, b) => (order.get(a.edge.ref.id) ?? 0) - (order.get(b.edge.ref.id) ?? 0));

  return { width: Math.ceil(out.width ?? 0), height: Math.ceil(out.height ?? 0), nodes, edges: placedEdges };
}
