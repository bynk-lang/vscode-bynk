// Lay out a request timing diagram (#218): a UML timing diagram, one lifeline
// per row and a shared time axis. Pure: the same timelines and measurer give
// the same scene, so the tests assert exact positions.
//
// One timeline, or two stacked on one scale for a comparison. Each timeline is
// a heading line then its rows; every bar is placed by its start and end on
// the shared scale, with a floor of `MIN_BAR` pixels so a 0.1 ms step is still
// there to hover and click.

import { axisTicks, type Comparison, formatDelta, type TimingBar, type Timeline, tickLabel } from "../../requestTimingCore";
import { formatMs } from "../../requestTraceCore";
import type { TextMeasurer } from "../measure";

export const ROW_H = 28;
export const BAR_H = 14;
export const HEADING_H = 26;
export const AXIS_H = 30;
export const FOOTER_H = 28;
/** The widest the plotted time axis is, before zoom. */
export const PLOT_W = 720;
export const MIN_BAR = 3;
const MIN_GUTTER = 120;
const MAX_GUTTER = 300;
const INDENT = 14;
const PAD = 12;

export interface PlacedBar {
  bar: TimingBar;
  x: number;
  w: number;
  y: number;
  /** Where the label goes: inside the bar, after it, or nowhere (it would collide). */
  label: { text: string; placement: "inside" | "after" | "none"; x: number };
  /** `+1.2 ms` against the other trace, when comparing. */
  delta?: { text: string; slower: boolean; x: number };
  /** Present in this trace only, when comparing. */
  only?: boolean;
}

export interface PlacedRow {
  id: string;
  label: string;
  detail?: string;
  kind: string;
  depth: number;
  y: number;
  labelX: number;
}

export interface PlacedHeading {
  text: string;
  y: number;
  failed: boolean;
}

export interface TimingScene {
  width: number;
  /** The top strip (the axis), pinned as the body scrolls. */
  headHeight: number;
  height: number;
  /** The x of time 0 and of the end of the axis. */
  x0: number;
  x1: number;
  gutter: number;
  ticks: Array<{ ms: number; x: number; label: string }>;
  headings: PlacedHeading[];
  rows: PlacedRow[];
  bars: PlacedBar[];
  /** Where the footnote (what the timing does not say) goes. */
  footer: { y: number; text: string };
  /** The axis' end, in ms. */
  end: number;
}

export interface TimingInput {
  /** One timeline, or the two of a comparison (A above B). */
  timelines: Array<{ timeline: Timeline; heading: string }>;
  comparison?: Comparison;
  footer: string;
}

/** The scale: pixels per millisecond for `end` over `PLOT_W`. */
export function scaleFor(end: number): number {
  return PLOT_W / (end > 0 ? end : 1);
}

export function layoutTiming(input: TimingInput, measure: TextMeasurer): TimingScene {
  const timelines = input.timelines;
  const longest = Math.max(0, ...timelines.map((t) => t.timeline.end));
  const end = longest > 0 ? longest : 1;
  const ticks = axisTicks(end);
  const axisEnd = ticks[ticks.length - 1] ?? end;
  const scale = scaleFor(axisEnd);

  // The label gutter holds the widest row label (indented), within bounds.
  let gutter = MIN_GUTTER;
  for (const t of timelines) {
    for (const r of t.timeline.rows) {
      const w = measure.width(r.label, "name") + r.depth * INDENT + 2 * PAD;
      const d = r.detail ? measure.width(r.detail, "small") + r.depth * INDENT + 2 * PAD : 0;
      gutter = Math.max(gutter, w, d);
    }
  }
  gutter = Math.min(MAX_GUTTER, Math.ceil(gutter));
  const x0 = gutter;
  const x1 = x0 + PLOT_W;
  const width = x1 + 80;

  const headings: PlacedHeading[] = [];
  const rows: PlacedRow[] = [];
  const bars: PlacedBar[] = [];
  let y = 0;
  const only = new Set([...(input.comparison?.onlyA ?? []), ...(input.comparison?.onlyB ?? [])]);

  for (const { timeline, heading } of timelines) {
    headings.push({ text: heading, y: y + HEADING_H - 8, failed: timeline.status >= 500 });
    y += HEADING_H;
    const rowY = new Map<string, number>();
    for (const r of timeline.rows) {
      rowY.set(r.id, y);
      rows.push({ id: r.id, label: r.label, detail: r.detail, kind: r.kind, depth: r.depth, y, labelX: PAD + r.depth * INDENT });
      y += ROW_H;
    }
    const byRow = new Map<string, TimingBar[]>();
    for (const b of timeline.bars) byRow.set(b.row, [...(byRow.get(b.row) ?? []), b]);
    for (const b of timeline.bars) {
      const top = (rowY.get(b.row) ?? 0) + (ROW_H - BAR_H) / 2;
      const x = x0 + b.start * scale;
      const w = Math.max(MIN_BAR, (b.end - b.start) * scale);
      const text = formatMs(b.ms);
      const textW = measure.width(text, "small");
      let placement: "inside" | "after" | "none" = "none";
      let labelX = x;
      if (w >= textW + 8) {
        placement = "inside";
        labelX = x + w / 2;
      } else {
        // After the bar, when no later bar on the same row starts before the text ends.
        const room = x + w + 4 + textW;
        const clash = (byRow.get(b.row) ?? []).some((o) => o !== b && o.start >= b.start && x0 + o.start * scale < room + 4);
        if (!clash && room <= width - 4) {
          placement = "after";
          labelX = x + w + 4;
        }
      }
      const placed: PlacedBar = { bar: b, x, w, y: top, label: { text, placement, x: labelX } };
      const delta = input.comparison?.deltas[b.id];
      if (delta !== undefined) {
        const t = formatDelta(delta);
        const after = x + w + 4 + (placement === "after" ? textW + 6 : 0);
        if (t) placed.delta = { text: t, slower: delta > 0, x: after };
      }
      if (only.has(b.id)) placed.only = true;
      bars.push(placed);
    }
  }

  const headHeight = AXIS_H;
  const bodyEnd = y + 6;
  const footerY = bodyEnd + 18;
  return {
    width,
    headHeight,
    height: headHeight + footerY + FOOTER_H - 18,
    x0,
    x1,
    gutter,
    ticks: ticks.map((ms) => ({ ms, x: x0 + ms * scale, label: tickLabel(ms) })),
    headings: headings.map((h) => ({ ...h, y: h.y + headHeight })),
    rows: rows.map((r) => ({ ...r, y: r.y + headHeight })),
    bars: bars.map((b) => ({ ...b, y: b.y + headHeight })),
    footer: { y: headHeight + footerY, text: input.footer },
    end: axisEnd,
  };
}
