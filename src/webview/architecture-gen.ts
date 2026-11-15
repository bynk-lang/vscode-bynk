// #851: pure `ArchModel` -> Mermaid `flowchart` text generation. Kept
// separate from `architecture.ts`'s DOM/webview glue for the same reason
// `mermaid-gen.ts` (#846) is separate from `main.ts`: no dependency on a
// browser or VS Code webview host, so it's directly unit-testable.
//
// Click-to-code: unlike the sequence view (whose `sequenceDiagram` render
// has no reliable per-element id, forcing a DOM-order zip — see
// `participant-map.ts`'s long war story), Mermaid's `flowchart` gives every
// node a stable id in the rendered SVG (`id="flowchart-<mermaidId>-<n>"`,
// preserving the id this module assigns). So instead of an order-based zip,
// `clickTargets` maps each mermaid node id directly to what clicking it
// should do — the caller (`architecture.ts`) looks elements up by id, which
// survives Mermaid's dagre layout reordering the DOM (a real risk for a
// non-linear diagram, unlike the strictly left-to-right sequence view).
//
// DECISION A (context-level nodes, expand-on-demand): every context/adapter
// is one compact node by default. A synthetic "expand" node, linked by a
// dotted edge, toggles that one context into its declaration-level members
// (capabilities/providers/services/agents) on the *next* render — expansion
// state lives in the caller (`architecture.ts`) and is threaded back in via
// `expanded`; this module stays a pure `(model, expanded) -> text` function,
// re-invoked on every toggle rather than mutating the rendered SVG in place.

import type {
  ArchAgent,
  ArchCapability,
  ArchEdge,
  ArchLoc,
  ArchModel,
  ArchNode,
  ArchProvider,
  ArchService,
} from "./architectureTypes";
import { type ArchMarks, type DiffMark, edgeKey, markClass, MARK_SIGN, memberKey } from "./diffMarks";

export type ClickTarget =
  | { kind: "reveal"; loc: ArchLoc }
  | { kind: "toggle"; name: string };

export interface ArchMermaidResult {
  text: string;
  /** Mermaid node id -> the click behaviour for that node. */
  clickTargets: Map<string, ClickTarget>;
  /** #153: for a diff, the zero-based index of each marked link (what
   *  `linkStyle` addresses) and its mark. The caller styles them, since the
   *  colours come from the theme. */
  linkMarks: Array<{ index: number; mark: DiffMark }>;
}

function esc(label: string): string {
  return label.replace(/"/g, "&quot;").replace(/\n/g, " ").trim();
}

/** `flowchart` node ids must be identifier-like — a qualified name's dots
 *  and any other punctuation are not safe there (the label carries the real
 *  display name instead), so nodes are addressed by array index. */
function contextId(i: number): string {
  return `ctx${i}`;
}

function toggleId(i: number): string {
  return `${contextId(i)}_t`;
}

function memberId(i: number, m: number): string {
  return `${contextId(i)}_m${m}`;
}

/** A label with its mark's sign in front, so a diff does not rely on colour. */
function signed(label: string, mark: DiffMark | undefined): string {
  return mark ? `${MARK_SIGN[mark]} ${label}` : label;
}

/** `model` as a `flowchart`. With `marks` (#153) it is the merged before-and-
 *  after model of a diff: marked nodes, members and links are styled, and a
 *  `removed` element — a ghost, with no working-tree location — is not
 *  clickable. */
export function toMermaidArch(
  model: ArchModel,
  expanded: ReadonlySet<string>,
  marks?: ArchMarks,
): ArchMermaidResult {
  const lines: string[] = ["flowchart LR"];
  const clickTargets = new Map<string, ClickTarget>();
  const linkMarks: ArchMermaidResult["linkMarks"] = [];
  let links = 0;
  /** Count a link and style it when it is marked. */
  const link = (text: string, mark: DiffMark | undefined): void => {
    lines.push(text);
    if (mark) linkMarks.push({ index: links, mark });
    links++;
  };
  const memberLine = (
    id: string,
    ownerId: string,
    label: string,
    loc: ArchLoc,
    mark: DiffMark | undefined,
  ): void => {
    lines.push(`  ${id}("${esc(signed(label, mark))}"):::memberNode`);
    if (mark) lines.push(`  class ${id} ${markClass(mark)};`);
    link(`  ${ownerId} --- ${id}`, mark);
    if (mark !== "removed") clickTargets.set(id, { kind: "reveal", loc });
  };
  const idByName = new Map<string, string>();
  model.nodes.forEach((n, i) => idByName.set(n.name, contextId(i)));

  model.nodes.forEach((node: ArchNode, i) => {
    const id = contextId(i);
    const isExpanded = expanded.has(node.name);
    const cls = node.kind === "Adapter" ? "adapterNode" : "contextNode";
    const nodeMark = marks?.nodes[node.name];
    lines.push(`  ${id}["${esc(signed(node.name, nodeMark))}"]:::${cls}`);
    if (nodeMark) lines.push(`  class ${id} ${markClass(nodeMark)};`);
    if (nodeMark !== "removed") clickTargets.set(id, { kind: "reveal", loc: node.loc });

    const tId = toggleId(i);
    const hasMembers =
      node.capabilities.length + node.providers.length + node.services.length + node.agents.length > 0;
    if (hasMembers) {
      lines.push(`  ${tId}(("${isExpanded ? "−" : "+"}")):::toggleNode`);
      link(`  ${id} -.- ${tId}`, undefined);
      clickTargets.set(tId, { kind: "toggle", name: node.name });
    }

    if (isExpanded) {
      let m = 0;
      const markOf = (kind: Parameters<typeof memberKey>[1], name: string) =>
        marks?.members[memberKey(node.name, kind, name)];
      const emitCapability = (c: ArchCapability): void => {
        const label = c.local ? `${c.name} (capability)` : `${c.name} (from ${c.from ?? "?"})`;
        memberLine(memberId(i, m++), id, label, c.loc, markOf("capability", c.name));
      };
      const emitProvider = (p: ArchProvider): void => {
        memberLine(memberId(i, m++), id, `${p.capability} = ${p.providerName}`, p.loc, markOf("provider", p.capability));
      };
      const emitService = (s: ArchService): void => {
        memberLine(memberId(i, m++), id, `service ${s.name} (${s.handlerCount})`, s.loc, markOf("service", s.name));
      };
      const emitAgent = (a: ArchAgent): void => {
        memberLine(memberId(i, m++), id, `agent ${a.name} (${a.handlerCount})`, a.loc, markOf("agent", a.name));
      };
      node.capabilities.forEach(emitCapability);
      node.providers.forEach(emitProvider);
      node.services.forEach(emitService);
      node.agents.forEach(emitAgent);
    }
  });

  for (const edge of reachableEdges(model)) {
    const from = idByName.get(edge.from);
    const to = idByName.get(edge.to);
    if (!from || !to) continue;
    const mark = marks?.edges[edgeKey(edge)];
    const label = edge.capabilities.length > 0 ? esc(edge.capabilities.join(", ")) : "";
    const shown = mark ? esc(signed(label, mark)) : label;
    link(label || mark ? `  ${from} -->|"${shown}"| ${to}` : `  ${from} --> ${to}`, mark);
  }

  return { text: lines.join("\n"), clickTargets, linkMarks };
}

/** Every edge in `model` whose endpoints both resolved to a rendered node —
 *  a defensive floor (the server itself never emits a dangling edge, see
 *  `bynk-ide`'s `architecture.rs` module doc) that also protects the loop
 *  above: without it, a dangling edge's `idByName.get` miss would still be
 *  caught by the `if (!from || !to) continue` there, but factoring the
 *  filter out keeps that loop's job to just "render", not "validate". */
export function reachableEdges(model: ArchModel): ArchEdge[] {
  const names = new Set(model.nodes.map((n) => n.name));
  return model.edges.filter((e) => names.has(e.from) && names.has(e.to));
}
