// #225: the CPU-time note on a request trace.
//
// A `request` event (bynk v0.639.1, `bynk/src/trace.rs`) carries wall-clock
// durations: the request's `duration_ms` and each step's `ms`. Workers limit
// CPU time, which is never more than wall-clock time (waiting on a call is not
// CPU). So no CPU time is measured here and none is claimed:
//
//   - a request whose wall-clock time is well under the CPU limit cannot be
//     near it, and gets no note;
//   - one that is at least half the limit gets a note that says the time is
//     wall-clock and the CPU time is lower, and names the steps that took the
//     time, which are where to look;
//   - one at or over the limit says the same, and that CPU time may still be
//     well under it.
//
// If Bynk reports a CPU time per step, this is the one place that changes.

import { formatLimit, limitOf, planName, type Plan } from "./platformLimitsCore";
import { formatMs } from "./requestTraceCore";

/** A note appears from this share of the CPU limit, in wall-clock time. */
export const CPU_NOTE_RATIO = 0.5;

/** How many of the slowest steps a note names. */
export const CPU_NOTE_STEPS = 3;

/** What a trace is read from: a request's duration and its steps. */
export interface CpuTrace {
  durationMs: number;
  steps: ReadonlyArray<{ target: string; ms: number }>;
}

export interface CpuNote {
  /** `near`: at least half the limit; `over`: at or past it. */
  level: "near" | "over";
  /** One paragraph, for the timing diagram's legend. */
  text: string;
  /** The steps that took the longest, slowest first. */
  slowest: Array<{ target: string; ms: number }>;
}

/** The note for one request on `plan`, or `undefined` when it is not close. */
export function cpuNote(trace: CpuTrace, plan: Plan): CpuNote | undefined {
  const limit = limitOf("cpuTime", plan);
  if (limit === null || !Number.isFinite(trace.durationMs)) return undefined;
  const wall = trace.durationMs;
  if (wall < limit * CPU_NOTE_RATIO) return undefined;
  const level = wall >= limit ? "over" : "near";
  const slowest = trace.steps
    .filter((s) => s.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, CPU_NOTE_STEPS)
    .map((s) => ({ target: s.target, ms: s.ms }));
  const where = slowest.length > 0 ? ` The steps that took the longest: ${slowest.map((s) => `${s.target} (${formatMs(s.ms)})`).join(", ")}.` : "";
  const head =
    level === "over"
      ? `This request took ${formatMs(wall)} of wall-clock time in bynk dev, at or over the ${formatLimit("cpuTime", plan)} CPU limit of the ${planName(plan)}.`
      : `This request took ${formatMs(wall)} of wall-clock time in bynk dev, over half of the ${formatLimit("cpuTime", plan)} CPU limit of the ${planName(plan)}.`;
  const caveat =
    level === "over"
      ? " Workers limit CPU time, which is lower than wall-clock time (time spent waiting on a call is not CPU time), so the CPU time may well be under the limit; it is not measured here."
      : " Workers limit CPU time, which is lower than wall-clock time (time spent waiting on a call is not CPU time); it is not measured here.";
  return { level, text: head + caveat + where, slowest };
}
