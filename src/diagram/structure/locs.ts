// Every element of a structure diagram that has a source, by IR id: nodes,
// their compartment lines and ports, and edges. What a page hands the
// interaction layer for click-to-code.

import type { ArchLoc } from "../../webview/architectureTypes";
import type { StructDiagram, StructNode } from "./ir";

export function locsOf(diagram: StructDiagram): Map<string, ArchLoc> {
  const out = new Map<string, ArchLoc>();
  const walk = (ns: StructNode[]): void => {
    for (const n of ns) {
      if (n.ref.loc) out.set(n.ref.id, n.ref.loc);
      for (const i of n.items ?? []) if (i.ref.loc) out.set(i.ref.id, i.ref.loc);
      for (const p of n.ports ?? []) if (p.ref.loc) out.set(p.ref.id, p.ref.loc);
      walk(n.children);
    }
  };
  walk(diagram.nodes);
  for (const e of diagram.edges) if (e.ref.loc) out.set(e.ref.id, e.ref.loc);
  return out;
}
