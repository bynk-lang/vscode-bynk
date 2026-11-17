// #2196: hand-mirrored TS types for `bynk-lsp`'s `bynk/agentStateModel` wire
// shape (`bynk-lsp/src/agent_state_request.rs`), maintained by hand like
// every other custom request's types in this extension.

import type { ModelCoverage } from "../modelCoverageCore";
import type { DiffMark } from "./diffMarks";
import type { Range } from "./types";

export type StateTarget =
  | { kind: "State"; state: string }
  /** A computed write (`status := next(x)`, `status.update(f)`). */
  | { kind: "Unknown" }
  /** No write to the field on this path. */
  | { kind: "Unchanged" };

/** #2197: a `transition` this edge would violate at commit. */
export interface StateViolation {
  transition: string;
  /** The `transition` declaration. */
  range: Range;
  /** `Known`: every way the edge can go violates. `Possible`: a computed
   *  write may land on a violating target. */
  certainty: "Known" | "Possible";
  /** The reachable start states from which it violates. */
  from: string[];
  /** The violating targets. */
  targets: string[];
}

export interface StateEdge {
  handler: string;
  /** The states this path can start in. */
  from: string[];
  /** Conditions on the path that don't constrain the field, as source text. */
  guards: string[];
  to: StateTarget;
  /** The value the handler yields on this path; `null` for unit. */
  outcome: string | null;
  /** The write, or for an unchanged path the tail. */
  range: Range;
  violations: StateViolation[];
  /** #153: client-only, never on the wire. Set on the merged machine a model
   *  diff draws: how this path differs from the other revision. */
  diff?: DiffMark;
}

export interface StateMachine {
  field: string;
  fieldRange: Range;
  states: string[];
  initial: string | null;
  edges: StateEdge[];
  /** Reachable from `initial` (an `Unknown` edge reaches every state). */
  reachable: string[];
  /** #2219: the states the agent can be in after a commit, the only start
   *  states the overlay checks (the genesis commit runs no `transition`).
   *  Absent from an older server. */
  reachableAfterCommit?: string[];
  /** Handlers that exceeded the extractor's path budget. */
  truncated: string[];
  /** #2197: `transition`s on the field outside the evaluated fragment. */
  notEvaluated: Array<{ name: string; range: Range }>;
  /** #153: client-only, never on the wire. Set on the merged machine a model
   *  diff draws: the marks of its states by name, and of the whole machine
   *  when the field exists in only one revision. */
  diffStates?: Record<string, DiffMark>;
  diff?: DiffMark;
}

export interface AgentHandler {
  name: string;
  range: Range;
}

/** #2198: one write on an effect row. */
export interface EffectWrite {
  field: string;
  /** `:=`, or the store operation (`put`, `append`, …). */
  op: string;
  /** The written key or item, when a plain name or literal. */
  key: string | null;
  range: Range;
}

/** #2198: one merged path through a handler. */
export interface EffectRow {
  guards: string[];
  writes: EffectWrite[];
  reads: string[];
  calls: string[];
  outcomes: string[];
}

export interface HandlerEffects {
  handler: string;
  rows: EffectRow[];
  truncated: boolean;
}

/** #3608 (v0.633.5): one declared `invariant` or `transition` of the agent. */
export interface AgentInvariant {
  kind: "invariant" | "transition";
  name: string;
  /** The predicate's source text, as the expression printer prints it. */
  predicate: string;
  range: Range;
  /** The declaration's documentation text; omitted when it has none. */
  doc?: string;
}

export interface AgentStateModel {
  agent: string;
  range: Range;
  handlers: AgentHandler[];
  machines: StateMachine[];
  /** #2198: what each handler writes, reads and calls, path by path.
   *  Absent from an older server. */
  effects?: HandlerEffects[];
  /** #3608 (v0.633.5): the agent's `invariant`s and `transition`s; omitted by
   *  the server when it declares neither, and from an older server. */
  invariants?: AgentInvariant[];
}

export interface AgentStatePayload {
  model: AgentStateModel;
  uri: string;
  /** #144: the last coverage run's lines for this file; client-only, never on
   *  the wire. Absent when there is no run, or it did not measure the file. */
  coverage?: ModelCoverage;
}
