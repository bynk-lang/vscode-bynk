// #153: how a model diff is drawn on the existing architecture map and agent
// state diagram. The diff is carried as marks next to the merged before-and-
// after model, so `architecture-gen.ts` and `state-gen.ts` stay the only
// places that turn a model into Mermaid text. Pure (no DOM, no `vscode`).

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

/** The colours a diff is drawn in. `classDef` splits its properties on commas,
 *  so every value must be a hex colour (the webview resolves the theme's). */
export interface DiffPalette {
  added: string;
  removed: string;
  changed: string;
}

export const DEFAULT_DIFF_PALETTE: DiffPalette = { added: "#81b88b", removed: "#c74e39", changed: "#e2c08d" };

/** The `classDef` lines for the three marks: added green, changed amber and
 *  removed as a dashed, faded ghost. Appended after a view's own classDefs so
 *  its stroke wins. */
export function diffClassDefs(p: DiffPalette): string[] {
  return [
    `classDef diffAdded stroke:${p.added},stroke-width:3px;`,
    `classDef diffChanged stroke:${p.changed},stroke-width:3px;`,
    `classDef diffRemoved stroke:${p.removed},stroke-width:2px,stroke-dasharray:4 3,opacity:0.6;`,
  ];
}
