// The sequence diagram, end to end: model → IR → layout → drawing, plus what
// the page needs to work with the result (source ranges by id, which folded
// fragment hides an element, default folds).

import type { Position, Range, SequenceModel } from "../../webview/types";
import type { TextMeasurer } from "../measure";
import { toSequenceDiagram } from "./adapter";
import { drawSequence, type SequenceDrawing } from "./draw";
import type { SequenceDiagram, SequenceEvent } from "./ir";
import { layoutSequence } from "./layout";

/** Fragments nested this deep or deeper start folded (model-diagrams §6.1.4):
 *  the outermost two levels stay open, as the server's old depth cut did. */
export const DEFAULT_FOLD_DEPTH = 2;

/** Every IR id with a source range, for the interaction layer. */
export function rangesOf(diagram: SequenceDiagram): Map<string, Range> {
  const ranges = new Map<string, Range>();
  for (const l of diagram.lifelines) if (l.ref.range) ranges.set(l.ref.id, l.ref.range);
  const walk = (events: SequenceEvent[]): void => {
    for (const e of events) {
      if (e.ref.range) ranges.set(e.ref.id, e.ref.range);
      if (e.type === "fragment") {
        for (const op of e.operands) {
          if (op.ref.range) ranges.set(op.ref.id, op.ref.range);
          walk(op.events);
        }
      }
    }
  };
  walk(diagram.events);
  return ranges;
}

/** Each fragment's nesting depth (0 for a top-level one), by IR id. */
export function fragmentDepths(diagram: SequenceDiagram): Map<string, number> {
  const depths = new Map<string, number>();
  const walk = (events: SequenceEvent[], depth: number): void => {
    for (const e of events) {
      if (e.type !== "fragment") continue;
      depths.set(e.ref.id, depth);
      for (const op of e.operands) walk(op.events, depth + 1);
    }
  };
  walk(diagram.events, 0);
  return depths;
}

/** The fragments to draw folded: those at `DEFAULT_FOLD_DEPTH` or deeper,
 *  unless the reader opened them, plus any the reader folded. */
export function foldedSet(diagram: SequenceDiagram, overrides: ReadonlyMap<string, boolean>): Set<string> {
  const folded = new Set<string>();
  for (const [id, depth] of fragmentDepths(diagram)) {
    if (overrides.get(id) ?? depth >= DEFAULT_FOLD_DEPTH) folded.add(id);
  }
  return folded;
}

/** For each element inside a folded fragment, the outermost folded fragment
 *  that hides it (what to point at instead). */
export function hiddenBy(diagram: SequenceDiagram, folded: ReadonlySet<string>): Map<string, string> {
  const hidden = new Map<string, string>();
  const walk = (events: SequenceEvent[], under: string | null): void => {
    for (const e of events) {
      if (under) hidden.set(e.ref.id, under);
      if (e.type !== "fragment") continue;
      const inner = under ?? (folded.has(e.ref.id) ? e.ref.id : null);
      e.operands.forEach((op, i) => {
        // A folded fragment still draws its first operand's guard.
        if (under) hidden.set(op.ref.id, under);
        else if (inner && i > 0) hidden.set(op.ref.id, inner);
        walk(op.events, inner);
      });
    }
  };
  walk(diagram.events, null);
  return hidden;
}

function contains(r: Range, p: Position): boolean {
  const after = (a: Position, b: Position): boolean => a.line > b.line || (a.line === b.line && a.character >= b.character);
  return after(p, r.start) && after(r.end, p);
}

function span(r: Range): number {
  return (r.end.line - r.start.line) * 100_000 + (r.end.character - r.start.character);
}

/** The element for a cursor at `p`: the smallest source range that contains
 *  it, or, where that element is folded away, the fragment that hides it.
 *  Lifelines are skipped: their range is a declaration elsewhere. */
export function elementAt(
  ranges: ReadonlyMap<string, Range>,
  hidden: ReadonlyMap<string, string>,
  p: Position,
): string | null {
  // On a tie (several elements share one range: a reply note and its block,
  // say), prefer a message, then the fragment itself, then its operand, then
  // a note.
  const rank = (id: string): number => (id.startsWith("m") ? 3 : id.startsWith("b") ? (id.includes(".") ? 1 : 2) : 0);
  let best: string | null = null;
  let bestSpan = Infinity;
  for (const [id, r] of ranges) {
    if (id.startsWith("p") || !contains(r, p)) continue;
    const s = span(r);
    if (s < bestSpan || (s === bestSpan && best !== null && rank(id) > rank(best))) {
      best = id;
      bestSpan = s;
    }
  }
  return best ? (hidden.get(best) ?? best) : null;
}

export interface SequenceRender {
  drawing: SequenceDrawing;
  diagram: SequenceDiagram;
  ranges: Map<string, Range>;
  hidden: Map<string, string>;
  folded: Set<string>;
}

/** Lay out and draw `model`, with `overrides` (fragment id → folded) applied
 *  over the default folds. */
export function renderSequence(
  model: SequenceModel,
  opts: { measure: TextMeasurer; fontFamily: string; overrides?: ReadonlyMap<string, boolean> },
): SequenceRender {
  const diagram = toSequenceDiagram(model);
  const folded = foldedSet(diagram, opts.overrides ?? new Map());
  const scene = layoutSequence(diagram, opts.measure, { folded });
  const entry = diagram.lifelines.find((l) => l.kind === "entry");
  const drawing = drawSequence(scene, {
    title: entry ? `Sequence diagram of ${entry.name}` : "Sequence diagram",
    fontFamily: opts.fontFamily,
  });
  return { drawing, diagram, ranges: rangesOf(diagram), hidden: hiddenBy(diagram, folded), folded };
}
