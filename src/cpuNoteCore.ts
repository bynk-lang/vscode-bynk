// #225: the CPU-time note on a request trace.
//
// A `request` event (bynk v0.639.1, `bynk/src/trace.rs`) carries wall-clock
// durations: the request's `duration_ms` and each step's `ms`. Workers limit
// CPU time, which is never more than wall-clock time, and a step is a call the
// handler waits on (a capability, a Worker, an agent), which is not CPU time in
// this Worker. So no CPU time is measured here and none is claimed. What is
// measured is the time *outside* the traced steps: the handler's own work, plus
// anything untraced. That is the nearest bound the data gives to the handler's
// CPU time, and is what is compared with the limit:
//
//   - if the steps add up to more than the request (they overlapped, so what
//     lies outside them cannot be told), the whole wall-clock time is used;
//   - under half the limit: no note (an ordinary request on the free plan takes
//     longer than 5 ms in all, and gets none);
//   - at least half the limit: a note that says so, that the time is wall-clock
//     in `bynk dev`, that CPU time is lower and not measured, and which steps
//     were slowest (their time is waiting, and is not counted).
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

/** The time a request spent outside its traced steps: its own work, plus
 *  anything untraced. When the steps add up to more than the request they
 *  overlapped, and the request's whole time is returned. */
export function ownMs(trace: CpuTrace): number {
  const stepped = trace.steps.reduce((sum, s) => sum + Math.max(0, s.ms), 0);
  return stepped > trace.durationMs ? trace.durationMs : trace.durationMs - stepped;
}

/** The note for one request on `plan`, or `undefined` when it is not close. */
export function cpuNote(trace: CpuTrace, plan: Plan): CpuNote | undefined {
  const limit = limitOf("cpuTime", plan);
  if (limit === null || !Number.isFinite(trace.durationMs)) return undefined;
  const own = ownMs(trace);
  if (own < limit * CPU_NOTE_RATIO) return undefined;
  const level = own >= limit ? "over" : "near";
  const slowest = trace.steps
    .filter((s) => s.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, CPU_NOTE_STEPS)
    .map((s) => ({ target: s.target, ms: s.ms }));
  const where = slowest.length > 0 ? ` The calls that took the longest, whose waiting is not CPU time: ${slowest.map((s) => `${s.target} (${formatMs(s.ms)})`).join(", ")}.` : "";
  const head = `Of this request's ${formatMs(trace.durationMs)} of wall-clock time in bynk dev, ${formatMs(own)} was outside the traced calls: ${level === "over" ? "at or over" : "over half of"} the ${formatLimit("cpuTime", plan)} CPU limit of the ${planName(plan)}.`;
  const caveat =
    level === "over"
      ? " Workers limit CPU time, which is lower than wall-clock time, so the CPU time may well be under the limit; it is not measured here."
      : " Workers limit CPU time, which is lower than wall-clock time; it is not measured here.";
  return { level, text: head + caveat + where, slowest };
}
