// The structure-diagram part of the diagram IR (model-diagrams track §4.2,
// slice 4): nested nodes and typed edges, for the architecture map now and
// the component view next. Identity and UML meaning, no coordinates; ELK
// lays it out (`layout.ts`).

import type { ArchLoc } from "../../webview/architectureTypes";

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
  | "provider";

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
}

export type StructEdgeKind =
  /** `consumes`: one context depends on another's services. */
  | "consumes"
  /** A capability bound from a unit outside the project (`bynk`). */
  | "wires"
  /** An actor calling into the system. */
  | "calls"
  | "emits"
  | "subscribes";

export interface StructEdge {
  ref: StructRef;
  kind: StructEdgeKind;
  source: string;
  target: string;
  label: string | null;
  cycle: boolean;
}

export interface StructDiagram {
  /** Top-level nodes; members nest in `children`. */
  nodes: StructNode[];
  edges: StructEdge[];
}
