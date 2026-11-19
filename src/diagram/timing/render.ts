// The request timing diagram, end to end (#218): sources → timelines → layout →
// drawing, plus what the page needs to work with the result (each bar's call
// site by id, for click-to-source).

import {
  buildComparison,
  buildTimeline,
  type Comparison,
  TIMING_NOTE,
  type Timeline,
  type TimingSource,
} from "../../requestTimingCore";
import { formatMs, type TraceLocation } from "../../requestTraceCore";
import type { TextMeasurer } from "../measure";
import type { Drawing } from "../viewport";
import { drawTiming } from "./draw";
import { layoutTiming, type PlacedBar, type TimingScene } from "./layout";

export interface TimingRender {
  drawing: Drawing;
  scene: TimingScene;
  /** The timeline, or the first of a comparison. */
  timeline: Timeline;
  comparison?: Comparison;
  /** Each bar's call site, by id: what click opens. */
  locations: Map<string, TraceLocation>;
}

function heading(t: Timeline, who: string): string {
  const ctx = t.context ? ` (${t.context})` : "";
  return `${who}${t.route}${ctx} → ${t.status}, ${formatMs(t.durationMs)}${t.fault ? `: ${t.fault}` : ""}`;
}

function describe(p: PlacedBar): string {
  const { bar } = p;
  const outcome = bar.outcome === "ok" ? "" : bar.outcome === "fault" ? ", failed" : ", pending";
  const what = bar.kind === "request" ? `Request ${bar.label}` : `${bar.kind === "call" ? "Call" : bar.kind === "agent" ? "Agent call" : "Capability call"} ${bar.label}`;
  const delta = p.delta ? `, ${p.delta.text} against the other trace` : "";
  const only = p.only ? ", in this trace only" : "";
  const crit = bar.critical ? ", on the longest chain" : "";
  return `${what}: ${formatMs(bar.ms)}${outcome}${crit}${delta}${only}`;
}

export function renderTiming(
  source: TimingSource,
  compare: TimingSource | undefined,
  opts: { measure: TextMeasurer; fontFamily: string },
): TimingRender {
  const comparison = compare ? buildComparison(source, compare) : undefined;
  const timeline = comparison ? comparison.a : buildTimeline(source);
  const scene = layoutTiming(
    {
      timelines: comparison
        ? [
            { timeline: comparison.a, heading: heading(comparison.a, "A  ") },
            { timeline: comparison.b, heading: heading(comparison.b, "B  ") },
          ]
        : [{ timeline, heading: heading(timeline, "") }],
      comparison,
      footer: TIMING_NOTE,
    },
    opts.measure,
  );
  const drawing = drawTiming(scene, {
    title: comparison ? `Request timing: ${timeline.route}, two requests` : `Request timing: ${timeline.route}`,
    fontFamily: opts.fontFamily,
    describe,
  });
  const locations = new Map<string, TraceLocation>();
  for (const p of scene.bars) if (p.bar.at) locations.set(p.bar.id, p.bar.at);
  return { drawing, scene, timeline, ...(comparison ? { comparison } : {}), locations };
}
