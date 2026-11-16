// Sequence-diagram layout: the IR plus a text measurer → a positioned scene
// (model-diagrams track §4.3). Pure and deterministic.
//
// Lifelines are columns and events are rows. Column gaps grow until every
// message label fits between its endpoints. Rows run top to bottom in event
// order, so an edit that adds a message only moves the rows below it. A combined
// fragment is the bounding box of what it holds, plus padding, so nested
// fragments nest by construction. Activation bars (UML execution
// specifications) run on the entry lifeline for the whole interaction and on a
// callee from a synchronous call to its reply.

import type { FontRole, TextMeasurer } from "../measure";
import type {
  ArrowKind,
  FragmentEvent,
  Lifeline,
  LifelineKind,
  NoteTone,
  SequenceDiagram,
  SequenceEvent,
  SourceRef,
} from "./ir";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedLifeline {
  ref: SourceRef;
  kind: LifelineKind;
  name: string;
  stereotype: string | null;
  /** The lifeline's centre. */
  x: number;
  head: Box;
  lineTop: number;
  lineBottom: number;
}

/** Text as drawn (truncated when long) and in full (for the tooltip). */
export interface Label {
  text: string;
  full: string;
}

export interface PlacedMessage {
  type: "message";
  ref: SourceRef;
  arrow: ArrowKind;
  label: Label;
  /** Indices into `SequenceScene.lifelines`. */
  from: number;
  to: number;
  x1: number;
  x2: number;
  y: number;
  /** A message to the same lifeline, drawn as a loop to its right. */
  self: boolean;
  /** Where the label's text is anchored (it sits above the line). */
  labelX: number;
  labelAnchor: "middle" | "start";
}

export interface PlacedNote {
  type: "note";
  ref: SourceRef;
  tone: NoteTone;
  label: Label;
  box: Box;
}

export interface PlacedOperand {
  ref: SourceRef;
  guard: Label;
  /** The top of the operand: its separator line, for every operand but the first. */
  y: number;
  /** The guard's baseline and its left edge. */
  guardY: number;
  guardX: number;
}

export interface PlacedFragment {
  type: "fragment";
  ref: SourceRef;
  operator: FragmentEvent["operator"];
  box: Box;
  /** The pentagon in the top-left corner that names the operator. Its right
   *  end holds the fold toggle (`foldX`). */
  tab: Box;
  /** The fold toggle's centre. */
  foldX: number;
  foldY: number;
  /** Folded: drawn as its header and a one-line summary, contents hidden. Only
   *  the first operand is listed (its guard shows in the header). */
  folded: boolean;
  summary: (Label & { x: number; y: number }) | null;
  operands: PlacedOperand[];
}

export interface LayoutOptions {
  /** The fragments (by IR id) to draw folded. */
  folded?: ReadonlySet<string>;
}

export interface PlacedActivation {
  lifeline: number;
  box: Box;
}

export type PlacedItem = PlacedMessage | PlacedNote | PlacedFragment;

export interface SequenceScene {
  width: number;
  height: number;
  lifelines: PlacedLifeline[];
  /** In event order; a fragment comes before what it holds. */
  items: PlacedItem[];
  activations: PlacedActivation[];
}

const M = {
  margin: 16,
  headH: 48,
  headPadX: 12,
  minColW: 90,
  minGap: 120,
  labelPad: 24,
  firstRow: 28,
  msgRow: 34,
  selfRow: 44,
  selfLoopW: 30,
  selfLoopH: 16,
  noteH: 24,
  noteMinW: 80,
  notePadX: 10,
  noteRow: 34,
  fragPad: 12,
  tabH: 18,
  tabPadX: 8,
  operandHead: 22,
  fragBottom: 8,
  fragAfter: 12,
  actW: 10,
  actOverhang: 10,
  maxLabel: 64,
  foldW: 14,
  foldedBody: 24,
};

/** What a fragment holds, counted through nested fragments: for a folded
 *  fragment's summary and extent. */
function summarise(f: FragmentEvent): { lifelines: Set<number>; messages: number; notes: number } {
  const out = { lifelines: new Set<number>(), messages: 0, notes: 0 };
  const walk = (events: SequenceEvent[]): void => {
    for (const e of events) {
      if (e.type === "message") {
        out.messages++;
        out.lifelines.add(e.from);
        out.lifelines.add(e.to);
      } else if (e.type === "note") {
        out.notes++;
        out.lifelines.add(e.over);
      } else {
        for (const op of e.operands) walk(op.events);
      }
    }
  };
  for (const op of f.operands) walk(op.events);
  return out;
}

function label(full: string): Label {
  const chars = Array.from(full);
  const text = chars.length > M.maxLabel ? `${chars.slice(0, M.maxLabel - 1).join("")}…` : full;
  return { text, full };
}

export function layoutSequence(diagram: SequenceDiagram, measure: TextMeasurer, opts: LayoutOptions = {}): SequenceScene {
  const folded = opts.folded ?? new Set<string>();
  const w = (text: string, role: FontRole): number => measure.width(text, role);
  const lifelines = diagram.lifelines;
  const n = lifelines.length;
  const entry = Math.max(0, lifelines.findIndex((l) => l.kind === "entry"));

  // -- Columns. --
  const headW = lifelines.map((l: Lifeline) => {
    const name = w(l.name, "name") + 2 * M.headPadX;
    const stereo = l.stereotype ? w(`«${l.stereotype}»`, "small") + 2 * M.headPadX : 0;
    return l.kind === "actor" ? Math.max(60, w(l.name, "name") + 8) : Math.max(M.minColW, name, stereo);
  });
  const gaps = Array.from({ length: Math.max(0, n - 1) }, (_, i) =>
    Math.max(M.minGap, headW[i] / 2 + headW[i + 1] / 2 + M.labelPad),
  );
  let rightExtra = 0;

  const constraints: Array<{ a: number; b: number; need: number }> = [];
  const collect = (events: SequenceEvent[]): void => {
    for (const e of events) {
      if (e.type === "message") {
        const lw = w(label(e.label).text, "label");
        if (e.from === e.to) {
          const need = M.selfLoopW + lw + M.labelPad;
          if (e.from < n - 1) constraints.push({ a: e.from, b: e.from + 1, need: need + headW[e.from + 1] / 2 });
          else rightExtra = Math.max(rightExtra, need);
        } else {
          constraints.push({ a: Math.min(e.from, e.to), b: Math.max(e.from, e.to), need: lw + M.labelPad });
        }
      } else if (e.type === "fragment") {
        for (const op of e.operands) collect(op.events);
      }
    }
  };
  collect(diagram.events);
  constraints.sort((p, q) => p.b - p.a - (q.b - q.a));
  for (const c of constraints) {
    let span = 0;
    for (let i = c.a; i < c.b; i++) span += gaps[i];
    if (span < c.need) gaps[c.b - 1] += c.need - span;
  }

  const xs: number[] = [];
  let x = M.margin + (headW[0] ?? M.minColW) / 2;
  for (let i = 0; i < n; i++) {
    xs.push(x);
    x += gaps[i] ?? 0;
  }

  // -- Rows. --
  const items: PlacedItem[] = [];
  const messages: PlacedMessage[] = [];
  let y = M.margin + M.headH + M.firstRow;

  interface Extent {
    min: number;
    max: number;
  }
  const grow = (into: Extent, min: number, max: number): void => {
    into.min = Math.min(into.min, min);
    into.max = Math.max(into.max, max);
  };

  const place = (events: SequenceEvent[]): Extent => {
    const ext: Extent = { min: Infinity, max: -Infinity };
    for (const e of events) {
      if (e.type === "message") {
        const l = label(e.label);
        const lw = w(l.text, "label");
        const x1 = xs[e.from] ?? xs[entry];
        const x2 = xs[e.to] ?? xs[entry];
        if (e.from === e.to) {
          const m: PlacedMessage = {
            type: "message", ref: e.ref, arrow: e.arrow, label: l, from: e.from, to: e.to,
            x1, x2, y, self: true, labelX: x1 + M.selfLoopW + 6, labelAnchor: "start",
          };
          items.push(m);
          messages.push(m);
          grow(ext, x1, x1 + M.selfLoopW + 6 + lw);
          y += M.selfRow;
        } else {
          const m: PlacedMessage = {
            type: "message", ref: e.ref, arrow: e.arrow, label: l, from: e.from, to: e.to,
            x1, x2, y, self: false, labelX: (x1 + x2) / 2, labelAnchor: "middle",
          };
          items.push(m);
          messages.push(m);
          grow(ext, Math.min(x1, x2), Math.max(x1, x2));
          y += M.msgRow;
        }
      } else if (e.type === "note") {
        const l = label(e.text);
        const nw = Math.max(M.noteMinW, w(l.text, "small") + 2 * M.notePadX);
        const cx = xs[e.over] ?? xs[entry];
        const box = { x: cx - nw / 2, y: y - M.noteH / 2 - 4, w: nw, h: M.noteH };
        items.push({ type: "note", ref: e.ref, tone: e.tone, label: l, box });
        grow(ext, box.x, box.x + box.w);
        y += M.noteRow;
      } else {
        const top = y - M.msgRow / 2 - 6;
        const operator = e.operator;
        const tabW = w(operator, "small") + 2 * M.tabPadX + 6 + M.foldW;
        const isFolded = folded.has(e.ref.id);
        const frag: PlacedFragment = {
          type: "fragment",
          ref: e.ref,
          operator,
          box: { x: 0, y: top, w: 0, h: 0 },
          tab: { x: 0, y: top, w: tabW, h: M.tabH },
          foldX: 0,
          foldY: top + M.tabH / 2,
          folded: isFolded,
          summary: null,
          operands: [],
        };
        items.push(frag);
        if (isFolded) {
          // Header and a summary line; the contents are not placed. The box
          // spans the lifelines its contents touch.
          const { lifelines: touched, messages, notes } = summarise(e);
          const xsTouched = [...touched].map((i) => xs[i] ?? xs[entry]);
          const lo = xsTouched.length > 0 ? Math.min(...xsTouched) : xs[entry];
          const hi = xsTouched.length > 0 ? Math.max(...xsTouched) : xs[entry];
          const guard = label(e.operands[0]?.guard ? `[${e.operands[0].guard}]` : "");
          const parts = [
            e.operands.length > 1 ? `${e.operands.length} branches` : null,
            messages > 0 ? `${messages} message${messages === 1 ? "" : "s"}` : null,
            notes > 0 ? `${notes} note${notes === 1 ? "" : "s"}` : null,
          ].filter(Boolean);
          const summary = label(`folded: ${parts.join(", ") || "empty"}`);
          const minW = Math.max(tabW + w(guard.text, "small") + 16, w(summary.text, "small") + 24);
          let left = lo - 40;
          let right = hi + 40;
          if (right - left < minW) right = left + minW;
          const h = M.tabH + M.foldedBody;
          frag.box = { x: left, y: top, w: right - left, h };
          frag.tab.x = left;
          frag.foldX = left + tabW - M.foldW / 2 - 2;
          if (e.operands[0]) {
            frag.operands.push({ ref: e.operands[0].ref, guard, y: top, guardY: top + 13, guardX: left + tabW + 8 });
          }
          // Start the summary clear of the entry's activation bar, which runs
          // through the box.
          const entryX = xs[entry];
          const sx = entryX >= left && entryX <= right ? Math.max(left + 10, entryX + M.actW / 2 + 8) : left + 10;
          if (sx + w(summary.text, "small") + 10 > right) right = sx + w(summary.text, "small") + 10;
          frag.box.w = right - left;
          frag.summary = { ...summary, x: sx, y: top + M.tabH + 15 };
          grow(ext, left, right);
          y = top + h + M.fragAfter + M.msgRow / 2;
          continue;
        }
        const inner: Extent = { min: Infinity, max: -Infinity };
        let minW = 0;
        // The extra 6 keeps a nested fragment's top clear of this one's tab.
        y = top + M.tabH + M.operandHead + 6;
        e.operands.forEach((op, i) => {
          const guard = label(op.guard ? `[${op.guard}]` : "");
          const gw = w(guard.text, "small");
          let opTop = top;
          if (i > 0) {
            opTop = y - M.msgRow / 2 - 2;
            y = opTop + M.operandHead + M.msgRow / 2 + 6;
          }
          frag.operands.push({ ref: op.ref, guard, y: opTop, guardY: i === 0 ? top + 13 : opTop + 14, guardX: 0 });
          minW = Math.max(minW, i === 0 ? tabW + gw + 16 : gw + 16);
          const got = place(op.events);
          grow(inner, got.min, got.max);
        });
        if (!Number.isFinite(inner.min)) {
          inner.min = xs[entry] - 60;
          inner.max = xs[entry] + 60;
        }
        let left = inner.min - M.fragPad;
        let right = inner.max + M.fragPad;
        if (right - left < minW) right = left + minW;
        const bottom = y - M.msgRow / 2 + M.fragBottom;
        frag.box = { x: left, y: top, w: right - left, h: bottom - top };
        frag.tab.x = left;
        frag.foldX = left + tabW - M.foldW / 2 - 2;
        frag.operands.forEach((op, i) => (op.guardX = i === 0 ? left + frag.tab.w + 8 : left + 8));
        grow(ext, left, right);
        y = bottom + M.fragAfter + M.msgRow / 2;
      }
    }
    return ext;
  };
  place(diagram.events);
  const lastY = y - M.msgRow / 2;

  // -- Activations. --
  const activations: PlacedActivation[] = [];
  const bar = (lifeline: number, from: number, to: number): PlacedActivation => ({
    lifeline,
    box: { x: xs[lifeline] - M.actW / 2, y: from, w: M.actW, h: Math.max(to - from, 8) },
  });
  if (n > 0 && items.length > 0) {
    const first = items[0];
    const firstY = first.type === "message" ? first.y : first.box.y;
    activations.push(bar(entry, firstY - 2, lastY));
  }
  const open = new Map<number, number[]>();
  for (const m of messages) {
    if (m.self) continue;
    const { from, to } = m;
    if (m.arrow === "sync" && to !== entry && lifelines[to]?.kind !== "actor") {
      open.set(to, [...(open.get(to) ?? []), m.y]);
    } else if (m.arrow === "reply") {
      const stack = open.get(from);
      const start = stack?.pop();
      if (start !== undefined) activations.push(bar(from, start, m.y));
    }
  }
  for (const [lifeline, starts] of open) for (const s of starts) activations.push(bar(lifeline, s, s + 16));

  // Arrows meet the side of an active bar, not its centre line.
  const activeAt = (lifeline: number, at: number): boolean =>
    activations.some((a) => a.lifeline === lifeline && a.box.y - 0.5 <= at && at <= a.box.y + a.box.h + 0.5);
  for (const m of messages) {
    if (m.self) {
      if (activeAt(m.from, m.y)) {
        m.x1 += M.actW / 2;
        m.x2 += M.actW / 2;
        m.labelX += M.actW / 2;
      }
      continue;
    }
    const dir = Math.sign(m.x2 - m.x1);
    if (activeAt(m.from, m.y)) m.x1 += (dir * M.actW) / 2;
    if (activeAt(m.to, m.y)) m.x2 -= (dir * M.actW) / 2;
  }

  // -- Lifelines. --
  const lineBottom = lastY + M.actOverhang + 8;
  const placed: PlacedLifeline[] = lifelines.map((l, i) => ({
    ref: l.ref,
    kind: l.kind,
    name: l.name,
    stereotype: l.stereotype,
    x: xs[i],
    head: { x: xs[i] - headW[i] / 2, y: M.margin, w: headW[i], h: M.headH },
    lineTop: M.margin + M.headH,
    lineBottom,
  }));

  // -- Fit: shift right so nothing starts left of the margin; size the canvas. --
  let minX = Infinity;
  let maxX = -Infinity;
  const fit = (lo: number, hi: number): void => {
    minX = Math.min(minX, lo);
    maxX = Math.max(maxX, hi);
  };
  for (const l of placed) fit(l.head.x, l.head.x + l.head.w);
  for (const it of items) {
    if (it.type === "message") fit(Math.min(it.x1, it.x2), Math.max(it.x1, it.x2) + (it.self ? M.selfLoopW + rightExtra : 0));
    else fit(it.box.x, it.box.x + it.box.w);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
  }
  const dx = M.margin - minX;
  const shift = (b: Box): void => void (b.x += dx);
  for (const l of placed) {
    l.x += dx;
    shift(l.head);
  }
  for (const it of items) {
    if (it.type === "message") {
      it.x1 += dx;
      it.x2 += dx;
      it.labelX += dx;
    } else if (it.type === "note") {
      shift(it.box);
    } else {
      shift(it.box);
      shift(it.tab);
      it.foldX += dx;
      if (it.summary) it.summary.x += dx;
      for (const op of it.operands) op.guardX += dx;
    }
  }
  for (const a of activations) shift(a.box);

  return {
    width: Math.ceil(maxX - minX + 2 * M.margin),
    height: Math.ceil(lineBottom + M.margin),
    lifelines: placed,
    items,
    activations,
  };
}
