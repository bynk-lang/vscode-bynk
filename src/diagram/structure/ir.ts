// The structure-diagram part of the diagram IR (model-diagrams track §4.2,
// slices 4–6): nested nodes and typed edges, for the architecture map, the
// component view and the agent state machine. Identity and UML meaning, no coordinates; ELK
// lays it out (`layout.ts`).

import type { ArchLoc } from "../../webview/architectureTypes";
import type { DiffMark } from "../../webview/diffMarks";

/** An element's identity: a stable id within one diagram, and the source it
 *  stands for (`null` when it has none: the system boundary, an actor). */
export interface StructRef {
  id: string;
  loc: ArchLoc | null;
}

export type StructNodeKind =
  /** The system boundary, around the project's own units. */
  | "boundary"
  | "context"
  | "adapter"
  /** A unit outside the project the system relies on (`bynk`). */
  | "platform"
  | "actor"
  | "event"
  | "service"
  | "agent"
  | "capability"
  | "provider"
  /** State machine (slice 6): a state of the field. */
  | "state"
  /** The initial pseudo-state (UML's filled dot). */
  | "initial"
  /** `?`: where a computed write lands (ADR 0536's dashed state). */
  | "computed"
  /** A note, attached to nothing (a truncated handler). */
  | "note";

export interface StructNode {
  ref: StructRef;
  kind: StructNodeKind;
  name: string;
  /** The UML stereotype shown above the name («context»), if any. */
  stereotype: string | null;
  /** A line under the name: a collapsed unit's contents, a service's route. */
  detail: string | null;
  children: StructNode[];
  /** Whether the node can be opened to show its members, and is. */
  expandable: boolean;
  expanded: boolean;
  /** Part of a `consumes` cycle (a checker error the map makes visible). */
  cycle: boolean;
  /** A compartment under the name (component view): a part's operations, an
   *  agent's key and state. Each line is its own element. */
  items?: StructItem[];
  /** Ports on the node's border (component view): its provided and required
   *  interfaces. */
  ports?: StructPort[];
  /** Drawn in grey: a neighbour outside the view's subject. */
  muted?: boolean;
  /** Offer to open this node in its own, more detailed view (the map's units
   *  open their component view). */
  opens?: boolean;
  /** Drawn faded: a state unreachable from the initial one. */
  dimmed?: boolean;
  /** #145: the state a live agent instance is in now, on the agent state
   *  view; drawn with the engine's current-element emphasis. */
  current?: boolean;
  /** How it differs from the other revision, on a model diff's drawing. */
  diff?: DiffMark;
  /** More to say in its tooltip, under its description. */
  note?: string;
}

/** One line of a node's compartment. */
export interface StructItem {
  ref: StructRef;
  text: string;
  /** "operation" opens its sequence diagram; "attribute" only shows source. */
  role: "operation" | "attribute";
}

/** A port on a node's border, standing for an interface (UML ball and
 *  socket): what the node provides on the left, what it requires on the
 *  right. Edges attach to it by `ref.id`. */
export interface StructPort {
  ref: StructRef;
  name: string;
  kind: "provided" | "required";
}

export type StructEdgeKind =
  /** `consumes`: one context depends on another's services. */
  | "consumes"
  /** A capability bound from a unit outside the project (`bynk`). */
  | "wires"
  /** An actor calling into the system. */
  | "calls"
  | "emits"
  | "subscribes"
  /** Component view: a port delegating to (or from) the part that realises
   *  or needs it. */
  | "delegates"
  /** Component view: an outside component wired to a port (ball in socket). */
  | "assembly"
  /** Component view: one part calling another (a service calling an agent). */
  | "invokes"
  /** State machine: a handler moving the field from one state to another. */
  | "transition";

export interface StructEdge {
  ref: StructRef;
  kind: StructEdgeKind;
  source: string;
  target: string;
  label: string | null;
  cycle: boolean;
  /** A transition a `transition` declaration refuses at commit: `Known`
   *  always, `Possible` when a computed write may land there. */
  flag?: "Known" | "Possible";
  /** How it differs from the other revision, on a model diff's drawing. */
  diff?: DiffMark;
  /** Names it answers to (the handlers on a transition), for highlighting. */
  tags?: string[];
  /** More to say in its tooltip, under its description. */
  note?: string;
}

export interface StructDiagram {
  /** Top-level nodes; members nest in `children`. */
  nodes: StructNode[];
  edges: StructEdge[];
}
