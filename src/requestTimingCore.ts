// #218: the dependency-free core of the request timing diagram — a UML timing
// diagram of one request (or two of the same route, stacked). No `vscode`
// import and no DOM, so the unit tests compile against it directly;
// `diagram/timing/` lays it out and draws it, `requestTiming.ts` wires it to
// the editor, and `webview/timing.ts` is the page.
//
// What the data supports. A `request` event (bynk v0.639.1, `bynk/src/trace.rs`
// `TraceStep`, ADR 0860) gives each step a duration, `ms`, and the order the
// steps ran in. It gives no start offset. So overlap and the gaps between
// steps cannot be known, and nothing here pretends otherwise: the steps of one
// request are laid end to end in the order they ran, starting at 0, and a call
// step's callee (joined by `request`/`parent`, v0.632.2) starts where that call
// step does. `TIMING_NOTE` says so on the page and in every export. If Bynk
// adds a per-step start time, `layoutSteps` is the one place that changes.

import {
  compareTraces,
  formatMs,
  routeShape,
  type StepKind,
  type StepOutcome,
  type StepView,
  type TraceLocation,
  type TraceView,
} from "./requestTraceCore";

/** The truthful-timing caveat, shown in the legend and written into exports. */
export const TIMING_NOTE =
  "Durations only; start times not reported. Steps are drawn end to end in the order they ran, so overlap and gaps between them are not shown. Per-step start times are proposed in bynk-lang/bynk#3787.";

/** The longest chain's definition, for the legend. With durations only every
 *  step of a request runs one after another, so every step is on the true
 *  critical path; what is outlined is where most of the time went: the longest
 *  step at each level, followed into its callee when the callee was traced too.
 *  Not called the critical path, which a per-step start time (bynk-lang/bynk#3787)
 *  would make computable. */
export const CRITICAL_NOTE =
  "Longest chain (outlined): the longest step at each level, followed into the callee where it was traced. With durations only every step runs in turn, so this is where most of the time went.";

/** The most requests one diagram nests: a trace's callees, transitively. */
export const MAX_NESTED_REQUESTS = 40;

export type RowKind = "request" | StepKind;

/** One lifeline: a participant of one request. */
export interface TimingRow {
  id: string;
  /** `GET /a`, `Db`, `Ledger`, `shop.payment`. */
  label: string;
  /** Under the label: the Worker that served a request. */
  detail?: string;
  kind: RowKind;
  /** How far in this row sits: 0 for the diagram's own request. */
  depth: number;
}

/** One bar on a row: a step, or a whole request. */
export interface TimingBar {
  id: string;
  row: string;
  /** What it stands for: `Db.query`, or the request's route. */
  label: string;
  kind: RowKind;
  /** Milliseconds from the request's start (the diagram's own request, not the callee's). */
  start: number;
  end: number;
  ms: number;
  outcome: StepOutcome;
  /** The `.bynk` call site, when the step has one; what click opens. */
  at: TraceLocation | null;
  /** On the longest chain. */
  critical: boolean;
  /** For a call step whose callee was traced: that request's id. */
  callee?: string;
}

export interface Timeline {
  /** The request this draws. */
  requestId: string;
  route: string;
  context: string;
  status: number;
  durationMs: number;
  rows: TimingRow[];
  bars: TimingBar[];
  /** The time the diagram runs to: the latest end of anything on it. */
  end: number;
  /** Bar ids on the longest chain, outermost first. */
  critical: string[];
  /** Calls whose callee request was not seen (not traced, or already evicted). */
  unjoined: number;
  /** More steps happened than the trace lists. */
  truncated: boolean;
  /** A failed request: its first fault line. */
  fault: string | null;
}

/** What the page is given for one request: the trace and every callee it joins. */
export interface TimingSource {
  trace: TraceView;
  /** The callees' traces by request id, transitively. */
  nested: Record<string, TraceView>;
}

/** Collect `root`'s callees, transitively, from `lookup` (the store's views):
 *  each once, so a request that names its own ancestor cannot loop, and at
 *  most `MAX_NESTED_REQUESTS`. */
export function collectNested(root: TraceView, lookup: (id: string) => TraceView | undefined): TimingSource {
  const nested: Record<string, TraceView> = {};
  const seen = new Set<string>([root.id]);
  const queue: TraceView[] = [root];
  while (queue.length > 0 && Object.keys(nested).length < MAX_NESTED_REQUESTS) {
    const t = queue.shift() as TraceView;
    for (const callee of Object.values(t.callees)) {
      if (seen.has(callee.id)) continue;
      seen.add(callee.id);
      const view = lookup(callee.id);
      if (!view) continue;
      nested[view.id] = view;
      queue.push(view);
    }
  }
  return { trace: root, nested };
}

/** A step's participant: `Db.query` → `Db`, `shop.payment.authorise` →
 *  `shop.payment`; a target with no dot is its own. */
export function participantOf(target: string): string {
  const dot = target.lastIndexOf(".");
  return dot > 0 ? target.slice(0, dot) : target;
}

/** Where each step of one request starts and ends: end to end in order, from
 *  `origin`. The one place the "no start offset" assumption lives. */
export function layoutSteps(steps: readonly Pick<StepView, "ms">[], origin: number): Array<{ start: number; end: number }> {
  let at = origin;
  return steps.map((s) => {
    const start = at;
    at += Math.max(0, s.ms);
    return { start, end: at };
  });
}

/** Build the timeline of `source.trace`. `prefix` namespaces every id, so two
 *  timelines stacked in one comparison never share one. */
export function buildTimeline(source: TimingSource, prefix = ""): Timeline {
  const rows: TimingRow[] = [];
  const bars: TimingBar[] = [];
  const rowIndex = new Map<string, TimingRow>();
  let unjoined = 0;
  let nextBar = 0;
  const used = new Set<string>();

  const addRow = (row: TimingRow): TimingRow => {
    const known = rowIndex.get(row.id);
    if (known) return known;
    rowIndex.set(row.id, row);
    rows.push(row);
    return row;
  };
  const barId = (): string => `${prefix}t${nextBar++}`;

  /** A request laid out: what the critical-path walk needs of it. */
  interface Placed {
    request: string;
    steps: readonly StepView[];
    stepBar: (i: number) => string;
    nestedBar: string;
  }
  const calleeOf = new Map<string, (i: number) => Placed | undefined>();

  /** Lay out `trace` as a request starting at `origin` on its own row at `depth`. */
  const place = (trace: TraceView, origin: number, depth: number, rowKey: string): Placed => {
    used.add(trace.id);
    const requestRow = addRow({
      id: rowKey,
      label: trace.route,
      detail: trace.context || undefined,
      kind: "request",
      depth,
    });
    const positions = layoutSteps(trace.steps, origin);
    const total = positions.length > 0 ? (positions[positions.length - 1]?.end ?? origin) - origin : 0;
    const requestBar = barId();
    // The request's own span: what it reported, or what its steps add up to if
    // that is longer (a step total past the reported duration is the data's, not ours to trim).
    const span = Math.max(trace.durationMs, total);
    bars.push({
      id: requestBar,
      row: requestRow.id,
      label: trace.route,
      kind: "request",
      start: origin,
      end: origin + span,
      ms: trace.durationMs,
      outcome: trace.status >= 500 ? "fault" : "ok",
      at: null,
      critical: false,
    });
    const stepBars: string[] = [];
    const nestedAt = new Map<number, Placed>();
    trace.steps.forEach((step, i) => {
      const pos = positions[i] ?? { start: origin, end: origin };
      const rowId = `${rowKey}|${step.kind}|${participantOf(step.target)}`;
      const row = addRow({
        id: rowId,
        label: participantOf(step.target),
        kind: step.kind,
        depth: depth + 1,
      });
      const id = barId();
      stepBars.push(id);
      const calleeInfo = trace.callees[i];
      bars.push({
        id,
        row: row.id,
        label: step.target,
        kind: step.kind,
        start: pos.start,
        end: pos.end,
        ms: step.ms,
        outcome: step.outcome,
        at: step.at,
        critical: false,
        ...(calleeInfo ? { callee: calleeInfo.id } : {}),
      });
      if (step.kind === "call" && step.request !== undefined) {
        const calleeTrace = source.nested[step.request];
        if (calleeTrace && !used.has(calleeTrace.id)) {
          nestedAt.set(i, place(calleeTrace, pos.start, depth + 2, `${rowKey}#${i}:${calleeTrace.id}`));
        } else if (!calleeTrace) {
          unjoined++;
        }
      }
    });
    const result: Placed = { request: trace.id, steps: trace.steps, stepBar: (i) => stepBars[i] as string, nestedBar: requestBar };
    calleeOf.set(requestBar, (i) => nestedAt.get(i));
    return result;
  };

  const root = place(source.trace, 0, 0, `${prefix}r`);

  // The longest chain: walk from the root through each level's heaviest step.
  const path: string[] = [root.nestedBar];
  let level: Placed = root;
  for (let guard = 0; guard <= MAX_NESTED_REQUESTS; guard++) {
    let best = -1;
    level.steps.forEach((s, i) => {
      if (best < 0 || s.ms > (level.steps[best]?.ms ?? 0)) best = i;
    });
    if (best < 0) break;
    path.push(level.stepBar(best));
    const next = calleeOf.get(level.nestedBar)?.(best);
    if (!next) break;
    path.push(next.nestedBar);
    level = next;
  }
  const onPath = new Set(path);
  for (const b of bars) b.critical = onPath.has(b.id);

  const end = bars.reduce((m, b) => Math.max(m, b.end), 0);
  const trace = source.trace;
  return {
    requestId: trace.id,
    route: trace.route,
    context: trace.context,
    status: trace.status,
    durationMs: trace.durationMs,
    rows,
    bars,
    end,
    critical: path,
    unjoined,
    truncated: trace.truncated,
    fault: trace.fault?.message ?? null,
  };
}

/** The change between two timelines of the same route. */
export interface Comparison {
  a: Timeline;
  b: Timeline;
  /** The end of the longer of the two: both are drawn to one scale. */
  end: number;
  /** For each bar of `b` that has a counterpart in `a` among the requests'
   *  own steps: `b.ms - a.ms`, by `b`'s bar id. */
  deltas: Record<string, number>;
  /** `b`'s duration against `a`'s. */
  totalDelta: number;
  /** Steps only one trace took, as bar ids. */
  onlyA: string[];
  onlyB: string[];
}

/** Stack two traces on one scale and align their own steps with the existing
 *  `compareTraces` alignment (kind, target, n-th occurrence). Steps inside a
 *  callee are not aligned: a callee is its own request, and the two traces may
 *  have reached different ones. */
export function buildComparison(a: TimingSource, b: TimingSource): Comparison {
  const ta = buildTimeline(a, "a:");
  const tb = buildTimeline(b, "b:");
  const stepBars = (t: Timeline, trace: TraceView): string[] =>
    // The root request's step bars, in step order: the bars on rows directly
    // under the root request, i.e. ids `t1, t2, …` that are not inside a callee.
    t.bars.filter((bar) => bar.kind !== "request" && t.rows.find((r) => r.id === bar.row)?.depth === 1).map((bar) => bar.id).slice(0, trace.steps.length);
  const sa = stepBars(ta, a.trace);
  const sb = stepBars(tb, b.trace);
  const deltas: Record<string, number> = {};
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const row of compareTraces(a.trace, b.trace)) {
    const barA = row.indexA === undefined ? undefined : sa[row.indexA];
    const barB = row.indexB === undefined ? undefined : sb[row.indexB];
    if (barA && barB && row.delta !== undefined) deltas[barB] = row.delta;
    else if (barA && !barB) onlyA.push(barA);
    else if (barB && !barA) onlyB.push(barB);
  }
  return {
    a: ta,
    b: tb,
    end: Math.max(ta.end, tb.end),
    deltas,
    totalDelta: b.trace.durationMs - a.trace.durationMs,
    onlyA,
    onlyB,
  };
}

/** `+1.2 ms` or `−0.4 ms`; empty for no change. */
export function formatDelta(delta: number): string {
  if (Math.abs(delta) < 0.05) return "";
  return `${delta > 0 ? "+" : "−"}${formatMs(Math.abs(delta))}`;
}

/** A row of the trace picker: when it ran, what, and how it went. */
export function traceChoiceLabel(t: TraceView, time: string): string {
  return `${t.route} · ${t.status} · ${formatMs(t.durationMs)} · ${time}`;
}

/** Whether two traces are the same route in the same Worker: what a comparison needs. */
export function sameRouteShape(a: TraceView, b: TraceView): boolean {
  return a.context === b.context && routeShape(a.route) === routeShape(b.route);
}

// -- Time axis. --

/** A step for the axis that gives about `target` ticks across `end`: 1, 2 or 5
 *  times a power of ten. */
export function niceStep(end: number, target = 6): number {
  if (!(end > 0)) return 1;
  const raw = end / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  const mult = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return mult * pow;
}

/** The ticks from 0 to past `end`, each a multiple of `niceStep`; the last is
 *  the first at or beyond `end`, so the axis covers the whole diagram. */
export function axisTicks(end: number): number[] {
  const step = niceStep(end);
  const ticks: number[] = [];
  const decimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  const n = Math.ceil(end / step - 1e-9);
  for (let i = 0; i <= Math.max(n, 1); i++) ticks.push(Number((i * step).toFixed(decimals + 1)));
  return ticks;
}

/** An axis label: `0`, `5 ms`, `1.5 s`; unit on every tick but 0. */
export function tickLabel(ms: number): string {
  if (ms === 0) return "0";
  if (ms >= 1000) return `${Number((ms / 1000).toFixed(2))} s`;
  return `${Number(ms.toFixed(3))} ms`;
}

// -- Copy as Mermaid: a `gantt` chart. --

function ganttText(text: string): string {
  // A task name is split at its first `:`; `#` and `;` start comments and end lines.
  return text.replace(/[:;#]/g, "·").replace(/\s+/g, " ").trim();
}

/** Mermaid's `%L` is the millisecond within the current second, so it wraps at
 *  1 s: a longer request needs seconds too (`%S`), and a minute-long one minutes. */
export function ganttAxisFormat(endMs: number): string {
  if (endMs < 1000) return "%L ms";
  if (endMs < 60_000) return "%S.%L s";
  return "%M:%S.%L";
}

function wholeMs(ms: number): number {
  return Math.max(1, Math.round(ms));
}

function ganttSections(t: Timeline, title: string, deltas: Record<string, number> | undefined, lines: string[], ids: { n: number }): void {
  lines.push(`  section ${ganttText(title)}`);
  const rowOf = new Map(t.rows.map((r) => [r.id, r]));
  const onPath = new Set(t.critical);
  for (const bar of t.bars) {
    const row = rowOf.get(bar.row);
    const who = bar.kind === "request" ? `${bar.label} (${row?.detail ?? "request"})` : bar.label;
    const delta = deltas?.[bar.id];
    const d = delta === undefined ? "" : ` ${formatDelta(delta)}`.trimEnd();
    const name = `${onPath.has(bar.id) ? "★ " : ""}${who} ${formatMs(bar.ms)}${d ? ` ${d}` : ""}`;
    const tag = bar.outcome === "fault" ? "crit, " : bar.outcome === "pending" ? "active, " : "done, ";
    lines.push(`  ${ganttText(name)} :${tag}g${ids.n++}, ${Math.round(bar.start)}, ${wholeMs(bar.end - bar.start)}ms`);
  }
}

/** The timeline (or the stacked pair) as a Mermaid `gantt` chart, for "Copy as
 *  Mermaid". Mermaid's gantt takes whole milliseconds, so times are rounded
 *  (a bar is at least 1 ms); a comment says so, and what the legend says. A
 *  failing step is `crit` (red), a pending one `active`, the rest `done`; a
 *  critical-path step is marked ★ (the `crit` tag is taken). */
export function toMermaidGantt(timeline: Timeline, comparison?: Comparison): string {
  const lines = [
    "gantt",
    `  title ${ganttText(comparison ? `${timeline.route}: two requests` : `${timeline.route} → ${timeline.status}, ${formatMs(timeline.durationMs)}`)}`,
    "  dateFormat x",
    `  axisFormat ${ganttAxisFormat(comparison ? comparison.end : timeline.end)}`,
    `  %% ${TIMING_NOTE}`,
    "  %% Times are rounded to whole milliseconds. ★ marks the longest chain; a red bar failed, an active one was still pending.",
  ];
  const ids = { n: 0 };
  if (comparison) {
    ganttSections(comparison.a, `A: ${comparison.a.route}, ${comparison.a.status}, ${formatMs(comparison.a.durationMs)}`, undefined, lines, ids);
    ganttSections(comparison.b, `B: ${comparison.b.route}, ${comparison.b.status}, ${formatMs(comparison.b.durationMs)}`, comparison.deltas, lines, ids);
  } else {
    ganttSections(timeline, `${timeline.route}`, undefined, lines, ids);
  }
  return lines.join("\n") + "\n";
}
