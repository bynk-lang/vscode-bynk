// #153: how a model diff is drawn on the existing architecture map and agent
// state diagram. The diff is carried as marks next to the merged before-and-
// after model. Model-diagrams slice 6: the engine's adapters draw them
// (`diagram/structure/architecture.ts`, `stateMachine.ts`) as CSS classes over
// the theme's git colours; the Mermaid exporters still name them as classes.
// Pure (no DOM, no `vscode`).

import type { ArchEdge } from "./architectureTypes";

/** How an element differs between the two revisions. */
export type DiffMark = "added" | "removed" | "changed";

/** The prefix a label carries so a mark does not depend on colour alone. */
export const MARK_SIGN: Record<DiffMark, string> = { added: "+", removed: "−", changed: "~" };

/** The class a marked Mermaid node is given (`classDef` names). */
export const markClass = (m: DiffMark): string =>
  m === "added" ? "diffAdded" : m === "removed" ? "diffRemoved" : "diffChanged";

/** Marks for the architecture map, keyed by what `architectureKeys` produces. */
export interface ArchMarks {
  /** By context or adapter name. A surviving context is `changed` when it, or
   *  any of its members, differs. */
  nodes: Record<string, DiffMark>;
  /** By `memberKey`. */
  members: Record<string, DiffMark>;
  /** By `edgeKey`. */
  edges: Record<string, DiffMark>;
}

export type MemberKind = "capability" | "provider" | "service" | "agent";

export const memberKey = (node: string, kind: MemberKind, name: string): string =>
  `${node}\u0000${kind}\u0000${name}`;

export const edgeKey = (e: Pick<ArchEdge, "from" | "to">): string => `${e.from} → ${e.to}`;
