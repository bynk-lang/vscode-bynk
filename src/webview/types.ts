// #846: hand-mirrored TS types for `bynk-lsp`'s `bynk/sequenceModel` wire
// shape (`bynk-lsp/src/sequence_request.rs`). No codegen exists in this repo
// for LSP payload types (no `schemars`/similar), so this is maintained by
// hand alongside the Rust side — the same posture every other custom
// LSP-adjacent shape in this extension takes.

import type { TraceView } from "../requestTraceCore";

export type ParticipantKind = "Entry" | "Capability" | "Context" | "Agent" | "Actor";
/** `StateWrite` (#2194): an agent handler's write to its own state (`status :=
 *  Placed`, `items.put(id, …)`). `from === to ===` the entry; rendered as a
 *  note over the entry lifeline, not an arrow. */
export type MessageKind = "Call" | "Return" | "Send" | "StateWrite";
/** `Break` (model-diagrams slice 3): a `?`, the handler's early return. */
export type AltKind = "If" | "Match" | "Collapsed" | "Break";

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Participant {
  id: number;
  kind: ParticipantKind;
  name: string;
  range: Range | null;
  /** Model-diagrams slice 3: an agent's key expression as called (`client`),
   *  or `…` when calls disagree. Absent from older servers. */
  key?: string | null;
}

/** Model-diagrams slice 3: the handler a boundary call reaches. */
export interface Callee {
  /** The consumed context; `null` for an agent of the caller's own context. */
  unit: string | null;
  owner: string;
  /** `null` for a service's unnamed `on call`. */
  method: string | null;
  /** The handler's declaration, when the server found it. */
  location: { uri: string; range: Range } | null;
}

/** Model-diagrams slice 3: what starts the handler. */
export interface Trigger {
  kind: "Request" | "Call" | "Schedule" | "Event" | "Message" | "Connection" | "Rejected";
  label: string;
}

export interface Message {
  from: number;
  to: number;
  kind: MessageKind;
  label: string;
  range: Range;
  block: number | null;
  /** Model-diagrams slice 3: for a call to an agent or a consumed context.
   *  Absent from older servers. */
  callee?: Callee | null;
}

export interface Branch {
  label: string;
  messageIds: number[];
  /** The value the handler yields on this branch (`Ok(view)`) — rendered as a
   *  note over the entry lifeline so a return-gating block (whose branches
   *  call no lifeline) has content instead of collapsing to an empty `alt`.
   *  `null` when the tail carries no distinguishable reply. */
  reply: string | null;
  /** ADR 0853: the arm's own source range. Absent from older servers. */
  range?: Range;
}

export interface AltBlock {
  id: number;
  kind: AltKind;
  branches: Branch[];
  range: Range;
  parent: number | null;
  parentBranch: number | null;
  /** Model-diagrams slice 3 (ADR 0858): nesting depth, 0 at the top. */
  depth?: number;
}

export interface SequenceModel {
  participants: Participant[];
  messages: Message[];
  blocks: AltBlock[];
  /** Model-diagrams slice 3. Absent from older servers. */
  trigger?: Trigger;
}

/** The payload the extension host embeds into the webview — the model plus
 *  the document URI every range in it is relative to (the model itself
 *  carries no URI; the request that produced it already knows one file). */
export interface SequencePayload {
  model: SequenceModel;
  uri: string;
  /** #143: the request traces from the running dev server that belong on this
   *  handler's diagram, newest first. Absent when there are none. */
  traces?: TraceView[];
}

/** A click-to-code message the webview posts back to the extension host. */
export interface RevealMessage {
  type: "reveal";
  uri: string;
  range: Range;
}
