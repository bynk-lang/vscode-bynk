// The sequence diagram, end to end: model → IR → layout → SVG → interaction.

import type { Range, SequenceModel } from "../../webview/types";
import type { DiagramHost } from "../interact";
import { wireInteraction } from "../interact";
import type { TextMeasurer } from "../measure";
import { toSequenceDiagram } from "./adapter";
import { drawSequence } from "./draw";
import type { SequenceDiagram, SequenceEvent } from "./ir";
import { layoutSequence } from "./layout";

export interface SequenceRenderOptions {
  measure: TextMeasurer;
  fontFamily: string;
  host: DiagramHost;
}

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

/** Draw `model` as an interactive SVG. */
export function renderSequence(model: SequenceModel, opts: SequenceRenderOptions): SVGSVGElement {
  const diagram = toSequenceDiagram(model);
  const scene = layoutSequence(diagram, opts.measure);
  const entry = diagram.lifelines.find((l) => l.kind === "entry");
  const svg = drawSequence(scene, {
    title: entry ? `Sequence diagram of ${entry.name}` : "Sequence diagram",
    fontFamily: opts.fontFamily,
  });
  wireInteraction(svg, rangesOf(diagram), opts.host);
  return svg;
}
