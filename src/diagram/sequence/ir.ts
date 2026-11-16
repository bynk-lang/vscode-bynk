// The sequence-diagram part of the diagram IR (model-diagrams track §4.2).
//
// A view adapter turns a server model into this; layout and drawing consume it.
// It carries identity (every element has a `ref` with its source range) and
// UML meaning (arrow kinds, fragment operators, stereotypes), and no
// coordinates: layout produces those separately, keyed by the same ids, so a
// change of layout never touches identity.

import type { Range } from "../../webview/types";

/** An element's identity: a stable id within one diagram, and the source range
 *  it stands for (`null` when it has none, like the entry lifeline). */
export interface SourceRef {
  id: string;
  range: Range | null;
}

export type LifelineKind = "actor" | "entry" | "capability" | "context" | "agent";

export interface Lifeline {
  ref: SourceRef;
  kind: LifelineKind;
  name: string;
  /** The UML stereotype shown above the name («capability»), if any. */
  stereotype: string | null;
}

/** UML message kinds: a synchronous call (solid line, filled head), its reply
 *  (dashed line, open head), and an asynchronous send (solid line, open head). */
export type ArrowKind = "sync" | "reply" | "async";

/** What a note says, which decides how it is styled. */
export type NoteTone =
  /** The value a branch yields. */
  | "reply"
  /** Nesting the server did not expand. */
  | "collapsed"
  /** A branch with nothing in it. */
  | "empty"
  /** A write to the agent's own state. */
  | "state";

/** Where a boundary call leads: the callee handler, to open its own diagram
 *  (a UML `ref`, model-diagrams slice 3). */
export interface CalleeLink {
  /** `Limiter.hit`, `platform.Pinger`. */
  name: string;
  location: { uri: string; range: Range };
}

export interface MessageEvent {
  type: "message";
  ref: SourceRef;
  /** Indices into `SequenceDiagram.lifelines`. */
  from: number;
  to: number;
  arrow: ArrowKind;
  label: string;
  /** Set when the server located the handler this call reaches. */
  callee?: CalleeLink;
}

export interface NoteEvent {
  type: "note";
  ref: SourceRef;
  /** The lifeline the note sits over. */
  over: number;
  text: string;
  tone: NoteTone;
}

export interface Operand {
  ref: SourceRef;
  /** The guard, shown in square brackets (`[view.allowed]`). */
  guard: string;
  events: SequenceEvent[];
}

/** A UML combined fragment. */
export interface FragmentEvent {
  type: "fragment";
  ref: SourceRef;
  /** `break` (model-diagrams slice 3): a `?`'s early return. */
  operator: "alt" | "opt" | "break";
  operands: Operand[];
}

export type SequenceEvent = MessageEvent | NoteEvent | FragmentEvent;

/** What starts a handler that has no principal: drawn as a UML found message
 *  (from a filled dot) into the entry lifeline. */
export interface FoundMessage {
  ref: SourceRef;
  label: string;
}

export interface SequenceDiagram {
  lifelines: Lifeline[];
  events: SequenceEvent[];
  /** Model-diagrams slice 3: set when the handler has no principal. */
  found?: FoundMessage;
}
