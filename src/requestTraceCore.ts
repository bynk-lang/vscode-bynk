// #143: the dependency-free core of request traces — the `request` event
// `bynk dev --trace-events` writes per request (bynk#3580, ADR 0860; shipped
// v0.627.1–v0.632.2), the bounded store the editor keeps them in, and how a
// trace is laid over a handler's sequence diagram. No `vscode` import, so the
// unit tests compile against it directly; `requestTraces.ts` wires it to the
// editor.
//
// The event is as bynk v0.639.1 writes it: `bynk/src/trace.rs` (`RawTrace`,
// `TraceStep`, `TraceFault`, :17–:80), `bynk/src/dev.rs` (the `request` event,
// pinned at :3001), and the `Request traces` reference in
// `site/src/content/docs/docs/bynk-cli.md` (:341). A step carries kinds,
// targets, spans, timings and outcomes, never argument values.
//
// Parsers are total: a field the driver adds is ignored, and anything
// malformed is `undefined`.

import type { Message, Position, Range, SequenceModel } from "./webview/types";

export type StepKind = "capability" | "call" | "agent";
export type StepOutcome = "ok" | "fault" | "pending";

/** The `.bynk` call site of a step: project-relative path, 1-based line and column. */
export interface TraceSpan {
  file: string;
  line: number;
  col: number;
}

export interface TraceStep {
  kind: StepKind;
  /** What was called: `Db.query`, `shop.payment.authorise`, `Ledger.tally`. */
  target: string;
  span: TraceSpan | null;
  ms: number;
  outcome: StepOutcome;
  /** A `call` step (v0.632.2): the id of the callee's own request event. */
  request?: string;
}

export interface TraceFault {
  /** The error's first line. */
  message: string;
  /** Its stack frames, frames into generated code already at their `.bynk` location. */
  frames: string[];
}

export interface RequestTrace {
  /** The worker directory that served it, as in `serving`. */
  context: string;
  id: string;
  /** `null` for a request from outside; else the calling request's id. */
  parent: string | null;
  /** `<METHOD> <path>`. */
  route: string;
  status: number;
  durationMs: number;
  steps: TraceStep[];
  /** More steps happened than are listed (at most 200 are kept). */
  truncated: boolean;
  fault: TraceFault | null;
  /** When the editor received it (milliseconds); not on the wire. */
  receivedAt: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSpan(raw: unknown): TraceSpan | null {
  if (!isObject(raw) || typeof raw.file !== "string") return null;
  if (!Number.isInteger(raw.line) || !Number.isInteger(raw.col)) return null;
  const line = raw.line as number;
  const col = raw.col as number;
  return line >= 1 && col >= 1 ? { file: raw.file, line, col } : null;
}

const KINDS: readonly string[] = ["capability", "call", "agent"];

function parseStep(raw: unknown): TraceStep | undefined {
  if (!isObject(raw) || typeof raw.kind !== "string" || !KINDS.includes(raw.kind) || typeof raw.target !== "string") {
    return undefined;
  }
  const outcome: StepOutcome = raw.outcome === "fault" || raw.outcome === "pending" ? raw.outcome : "ok";
  const step: TraceStep = {
    kind: raw.kind as StepKind,
    target: raw.target,
    span: parseSpan(raw.span),
    ms: typeof raw.ms === "number" && Number.isFinite(raw.ms) ? raw.ms : 0,
    outcome,
  };
  if (typeof raw.request === "string") step.request = raw.request;
  return step;
}

/** The `fault` field: v0.639.1 writes `{ message, frames }`; `null` for none.
 *  A bare string (the Worker's raw stack, as before the driver maps it) is
 *  read too, its first line the message. */
function parseFault(raw: unknown): TraceFault | null {
  if (typeof raw === "string") {
    const [message = "", ...rest] = raw.split(/\r?\n/);
    return { message, frames: rest.map((l) => l.trim()).filter(Boolean) };
  }
  if (!isObject(raw) || typeof raw.message !== "string") return null;
  const frames = Array.isArray(raw.frames) ? raw.frames.filter((f): f is string => typeof f === "string") : [];
  return { message: raw.message, frames };
}

/** Read a `request` event's object (`event` already checked by the caller). */
export function parseRequestEvent(obj: Record<string, unknown>, receivedAt: number): RequestTrace | undefined {
  if (typeof obj.id !== "string" || typeof obj.route !== "string" || !Array.isArray(obj.steps)) return undefined;
  const steps: TraceStep[] = [];
  for (const s of obj.steps) {
    const step = parseStep(s);
    if (step) steps.push(step);
  }
  return {
    context: typeof obj.context === "string" ? obj.context : "",
    id: obj.id,
    parent: typeof obj.parent === "string" ? obj.parent : null,
    route: obj.route,
    status: typeof obj.status === "number" ? obj.status : 0,
    durationMs: typeof obj.duration_ms === "number" && Number.isFinite(obj.duration_ms) ? obj.duration_ms : 0,
    steps,
    truncated: obj.truncated === true,
    fault: parseFault(obj.fault),
    receivedAt,
  };
}

/** How many traces are kept per handler (a context and route), and how many
 *  handlers; the oldest go first. Held in memory only: nothing is written to
 *  disk or to a log, since a route can carry an id or a token. */
export const MAX_TRACES_PER_HANDLER = 20;
export const MAX_TRACED_HANDLERS = 100;

export class TraceStore {
  private readonly byHandler = new Map<string, RequestTrace[]>();

  /** Add a trace; returns it. A handler used again moves to the back of the eviction order. */
  add(trace: RequestTrace): RequestTrace {
    const key = `${trace.context}\u0000${trace.route}`;
    const list = this.byHandler.get(key) ?? [];
    this.byHandler.delete(key);
    list.push(trace);
    while (list.length > MAX_TRACES_PER_HANDLER) list.shift();
    this.byHandler.set(key, list);
    while (this.byHandler.size > MAX_TRACED_HANDLERS) {
      const oldest = this.byHandler.keys().next().value;
      if (oldest === undefined) break;
      this.byHandler.delete(oldest);
    }
    return trace;
  }

  /** Every trace, newest first. */
  all(): RequestTrace[] {
    return [...this.byHandler.values()].flat().sort((a, b) => b.receivedAt - a.receivedAt);
  }

  byId(id: string): RequestTrace | undefined {
    return this.all().find((t) => t.id === id);
  }

  clear(): void {
    this.byHandler.clear();
  }
}

// -- What the page is given: a trace with its locations resolved. --

/** A location in a `.bynk` file, as the page reveals it. */
export interface TraceLocation {
  uri: string;
  range: Range;
}

export interface StepView extends Omit<TraceStep, "span"> {
  /** The call site, resolved to a document and a 0-based range; `null` without a span. */
  at: TraceLocation | null;
}

export interface FrameView {
  text: string;
  /** Where the frame is, when it names a `.bynk` location. */
  at: TraceLocation | null;
}

export interface TraceView {
  context: string;
  id: string;
  parent: string | null;
  route: string;
  status: number;
  durationMs: number;
  steps: StepView[];
  truncated: boolean;
  fault: { message: string; frames: FrameView[] } | null;
  receivedAt: number;
  /** For each `call` step (by index), the callee's own request, when the
   *  editor saw it: the two events joined into one call tree. */
  callees: Record<number, { id: string; context: string; route: string; status: number; durationMs: number }>;
}

/** A location in 1-based `line:col` as a zero-width 0-based range. */
export function pointRange(line: number, col: number): Range {
  const p: Position = { line: Math.max(0, line - 1), character: Math.max(0, col - 1) };
  return { start: p, end: p };
}

/** Parse a stack frame the driver has put at a `.bynk` location:
 *  `at f (src/a.bynk:9:1)` or `at src/a.bynk:9:1` (project-relative or
 *  absolute). `undefined` for a frame that is not in a `.bynk` file. */
export function parseFrameLocation(frame: string): { file: string; line: number; col: number } | undefined {
  const m = /([^\s()]+\.bynk):(\d+):(\d+)\)?\s*$/.exec(frame.trim());
  if (!m) return undefined;
  const line = Number(m[2]);
  const col = Number(m[3]);
  return line >= 1 && col >= 1 ? { file: m[1], line, col } : undefined;
}

/** Turn a stored trace into what the page shows. `resolve` maps a path as the
 *  driver writes it to a document URI (the wrapper joins it onto the session's
 *  project root and refuses a path that leaves it); `joined` finds a call
 *  step's callee request by id. */
export function toTraceView(
  trace: RequestTrace,
  resolve: (file: string) => string | undefined,
  joined: (id: string) => RequestTrace | undefined,
): TraceView {
  const locate = (file: string, line: number, col: number): TraceLocation | null => {
    const uri = resolve(file);
    return uri ? { uri, range: pointRange(line, col) } : null;
  };
  const callees: TraceView["callees"] = {};
  const steps: StepView[] = trace.steps.map((s, i) => {
    const { span, ...rest } = s;
    if (s.request) {
      const callee = joined(s.request);
      if (callee) {
        callees[i] = { id: callee.id, context: callee.context, route: callee.route, status: callee.status, durationMs: callee.durationMs };
      }
    }
    return { ...rest, at: span ? locate(span.file, span.line, span.col) : null };
  });
  return {
    context: trace.context,
    id: trace.id,
    parent: trace.parent,
    route: trace.route,
    status: trace.status,
    durationMs: trace.durationMs,
    steps,
    truncated: trace.truncated,
    fault: trace.fault
      ? {
          message: trace.fault.message,
          frames: trace.fault.frames.map((text) => {
            const f = parseFrameLocation(text);
            return { text, at: f ? locate(f.file, f.line, f.col) : null };
          }),
        }
      : null,
    receivedAt: trace.receivedAt,
    callees,
  };
}

/** `3.1 ms`, `12 ms`, `1.2 s`: three significant figures at most. */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  if (ms >= 10) return `${ms.toFixed(0)} ms`;
  return `${ms.toFixed(1)} ms`;
}

// -- Laying a trace over a handler's sequence diagram. --

export type MarkState = "hit" | "fault" | "pending" | "miss";

/** What a trace did at one drawn element, by its IR id (`m3`, `b1`, `b1.0`). */
export interface Mark {
  state: MarkState;
  /** How many steps landed here (a call in a loop lands on one message many times). */
  count: number;
  /** Their total time. */
  ms: number;
}

export interface TraceOverlay {
  marks: Map<string, Mark>;
  /** Indices of steps that are on no message of this diagram (a call this
   *  diagram does not draw, a step with no span, or one in another file). */
  unmatched: number[];
}

function after(a: Position, b: Position): boolean {
  return a.line > b.line || (a.line === b.line && a.character >= b.character);
}

function contains(r: Range, p: Position): boolean {
  return after(p, r.start) && after(r.end, p);
}

function size(r: Range): number {
  return (r.end.line - r.start.line) * 100_000 + (r.end.character - r.start.character);
}

/** The message a step's call site is on: the smallest call or send whose range
 *  holds it; failing that, the first on the same line (a span may point at
 *  the callee name, where the model's range starts at the receiver, or the
 *  reverse). Replies and state writes are never a step. */
export function messageForStep(model: SequenceModel, at: Position): number | undefined {
  let best: number | undefined;
  let bestSize = Infinity;
  let sameLine: number | undefined;
  model.messages.forEach((m: Message, i) => {
    if (m.kind !== "Call" && m.kind !== "Send") return;
    if (contains(m.range, at) && size(m.range) < bestSize) {
      best = i;
      bestSize = size(m.range);
    } else if (sameLine === undefined && m.range.start.line === at.line) {
      sameLine = i;
    }
  });
  return best ?? sameLine;
}

const SEVERITY: Record<MarkState, number> = { miss: 0, hit: 1, pending: 2, fault: 3 };

function worse(a: MarkState, b: MarkState): MarkState {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/** Lay `trace` over `model` (the sequence model of the document `uri`). Steps
 *  are matched to messages by call site, so only steps in this document count.
 *  A message no step landed on is `miss`, to be drawn faded; a fragment is
 *  taken when something inside it was, and an operand that has calls of its
 *  own but none of them hit is `miss` too. An operand with no calls cannot be
 *  told either way, so it carries no mark: nothing here is inferred. */
export function overlayTrace(model: SequenceModel, uri: string, trace: TraceView): TraceOverlay {
  const marks = new Map<string, Mark>();
  const unmatched: number[] = [];
  const hits = new Map<number, Mark>();

  trace.steps.forEach((step, i) => {
    if (!step.at || step.at.uri !== uri) {
      unmatched.push(i);
      return;
    }
    const index = messageForStep(model, step.at.range.start);
    if (index === undefined) {
      unmatched.push(i);
      return;
    }
    const state: MarkState = step.outcome === "fault" ? "fault" : step.outcome === "pending" ? "pending" : "hit";
    const prev = hits.get(index);
    hits.set(index, {
      state: prev ? worse(prev.state, state) : state,
      count: (prev?.count ?? 0) + 1,
      ms: (prev?.ms ?? 0) + step.ms,
    });
  });

  model.messages.forEach((m, i) => {
    if (m.kind !== "Call" && m.kind !== "Send") return;
    marks.set(`m${i}`, hits.get(i) ?? { state: "miss", count: 0, ms: 0 });
  });

  // Fragments and operands, from the messages inside them (nested blocks included).
  const touched = (blockId: number, branch: number | null): { calls: number; hit: number } => {
    let calls = 0;
    let hit = 0;
    const block = model.blocks.find((b) => b.id === blockId);
    if (!block) return { calls, hit };
    block.branches.forEach((br, b) => {
      if (branch !== null && b !== branch) return;
      for (const id of br.messageIds) {
        const m = model.messages[id];
        if (!m || (m.kind !== "Call" && m.kind !== "Send")) continue;
        calls++;
        if (hits.has(id)) hit++;
      }
      for (const child of model.blocks.filter((c) => c.parent === blockId && c.parentBranch === b)) {
        const inner = touched(child.id, null);
        calls += inner.calls;
        hit += inner.hit;
      }
    });
    return { calls, hit };
  };
  for (const block of model.blocks) {
    if (block.kind === "Collapsed") continue;
    const whole = touched(block.id, null);
    if (whole.calls > 0) marks.set(`b${block.id}`, { state: whole.hit > 0 ? "hit" : "miss", count: whole.hit, ms: 0 });
    block.branches.forEach((_, b) => {
      const op = touched(block.id, b);
      if (op.calls > 0) marks.set(`b${block.id}.${b}`, { state: op.hit > 0 ? "hit" : "miss", count: op.hit, ms: 0 });
    });
  }
  return { marks, unmatched };
}

/** Whether `trace` belongs on the diagram of `model` in `uri`: one of its steps
 *  is on a message here, or its route is what triggers the handler. */
export function traceRelevant(model: SequenceModel, uri: string, trace: TraceView): boolean {
  if (overlayTrace(model, uri, trace).unmatched.length < trace.steps.length) return true;
  const t = model.trigger;
  return t?.kind === "Request" && sameRoute(t.label, trace.route);
}

/** `POST /orders` against a handler's trigger label, ignoring case and spacing. */
export function sameRoute(label: string, route: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toUpperCase();
  return norm(label) === norm(route);
}

// -- Comparing two traces. --

export interface CompareRow {
  kind: StepKind;
  target: string;
  /** Milliseconds in each trace (`undefined`: the step did not happen there). */
  a?: number;
  b?: number;
  /** `b - a` when both ran. */
  delta?: number;
  outcomeA?: StepOutcome;
  outcomeB?: StepOutcome;
}

/** Align two traces' steps by kind and target, the n-th occurrence of each
 *  against the n-th, in the order of `a` then the steps only `b` took. */
export function compareTraces(a: TraceView, b: TraceView): CompareRow[] {
  const key = (s: StepView, seen: Map<string, number>): string => {
    const base = `${s.kind}\u0000${s.target}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}\u0000${n}`;
  };
  const seenA = new Map<string, number>();
  const bByKey = new Map<string, StepView>();
  const seenB = new Map<string, number>();
  for (const s of b.steps) bByKey.set(key(s, seenB), s);
  const rows: CompareRow[] = [];
  const used = new Set<string>();
  for (const s of a.steps) {
    const k = key(s, seenA);
    const other = bByKey.get(k);
    if (other) used.add(k);
    rows.push({
      kind: s.kind,
      target: s.target,
      a: s.ms,
      b: other?.ms,
      delta: other ? other.ms - s.ms : undefined,
      outcomeA: s.outcome,
      outcomeB: other?.outcome,
    });
  }
  for (const [k, s] of bByKey) {
    if (!used.has(k)) rows.push({ kind: s.kind, target: s.target, b: s.ms, outcomeB: s.outcome });
  }
  return rows;
}
