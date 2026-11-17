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

export interface AgentStateModel {
  agent: string;
  range: Range;
  handlers: AgentHandler[];
  machines: StateMachine[];
  /** #2198: what each handler writes, reads and calls, path by path.
   *  Absent from an older server. */
  effects?: HandlerEffects[];
}

/** #145: a live instance of the agent, as `bynk dev inspect agents` lists it. */
export interface LiveInstance {
  /** The page names an instance by this, never by its key: the host maps it
   *  back to a listed instance before it runs anything. */
  ref: string;
  /** The key, rendered in Bynk's terms. */
  key: string;
  context: string;
}

/** #145: what the host knows of the running dev server's instances of this
 *  agent. Absent when no dev server runs (or on the web build). */
export interface LiveInstances {
  instances: LiveInstance[];
  /** A context that could not be asked, or why the listing failed. */
  problems: string[];
}

export interface AgentStatePayload {
  model: AgentStateModel;
  uri: string;
  live?: LiveInstances;
  /** #144: the last coverage run's lines for this file; client-only, never on
   *  the wire. Absent when there is no run, or it did not measure the file. */
  coverage?: ModelCoverage;
}

/** #145: host → page, answering `{type: "inspectInstance"}`. Never part of
 *  the payload, and never logged: it holds the instance's stored values. */
export type InstanceMessage =
  | { type: "instance"; ref: string; agent: string; inspection: InstanceView }
  | { type: "instance"; ref: string; agent: string; failure: string };

/** An inspected instance with its values already rendered as Bynk text. */
export type InstanceView =
  | { exists: false }
  | { exists: true; readable: false; fault: string }
  | {
      exists: true;
      readable: true;
      schema: { text: string; behind: boolean };
      cells: Array<{ name: string; text: string }>;
      /** The state each machine field holds, by field. */
      states: Record<string, string | null>;
      collections: Array<{ name: string; kind: string; size: number | null; shown: number }>;
      /** Oldest first; per machine field, the state before and after. */
      history: Array<{
        handler: string | null;
        at: number;
        changes: Array<{ cell: string; before: string | undefined; after: string }>;
        sizes: Array<{ field: string; before: number | null | undefined; after: number | null }>;
        states: Record<string, { from: string | null; to: string | null }>;
      }>;
    };
