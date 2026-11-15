// #153: the graphs of "Bynk: Compare Model with…". The architecture map and
// each changed agent's state diagram are drawn by the views' own generators
// (`webview/architecture-gen.ts`, `webview/state-gen.ts`) from a *merged*
// before-and-after model: every element of the working tree, plus the elements
// only the other revision had, which are kept as ghosts. Each element carries a
// mark (added, removed or changed) that the generators style. Pure (no
// `vscode`, no DOM), so the unit tests compile against it directly.

import type { ModelSnapshot } from "./modelDiffCore";
import { sharedAgents, transitionKey } from "./modelDiffCore";
import type { ArchModel, ArchNode } from "./webview/architectureTypes";
import { type ArchMarks, type DiffMark, edgeKey, type MemberKind, memberKey } from "./webview/diffMarks";
import type { StateEdge, StateMachine } from "./webview/stateTypes";

/** Elements of two keyed lists: those only in `after` are added, only in
 *  `before` removed (and kept, as ghosts), in both and unequal changed (the
 *  `after` version is kept). Returns the merged list and each key's mark. */
function mergeKeyed<T>(
  before: readonly T[],
  after: readonly T[],
  key: (t: T) => string,
  differs: (b: T, a: T) => boolean,
): { items: T[]; marks: Map<string, DiffMark> } {
  const bm = new Map(before.map((t) => [key(t), t]));
  const am = new Map(after.map((t) => [key(t), t]));
  const marks = new Map<string, DiffMark>();
  const items = [...after];
  for (const [k, a] of am) {
    const b = bm.get(k);
    if (b === undefined) marks.set(k, "added");
    else if (differs(b, a)) marks.set(k, "changed");
  }
  for (const [k, b] of bm) {
    if (!am.has(k)) {
      marks.set(k, "removed");
      items.push(b);
    }
  }
  return { items, marks };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

/** The merged architecture model and its marks. A context whose own kind or
 *  any member differs is itself `changed`, so a collapsed box shows that
 *  something inside it moved; every member of an added or removed context
 *  takes the context's mark. */
export function mergeArchitecture(before: ArchModel, after: ArchModel): { model: ArchModel; marks: ArchMarks } {
  const marks: ArchMarks = { nodes: {}, members: {}, edges: {} };
  const nodes = mergeKeyed(before.nodes, after.nodes, (n) => n.name, (b, a) => b.kind !== a.kind);
  const bn = new Map(before.nodes.map((n) => [n.name, n]));
  const merged: ArchNode[] = nodes.items.map((node) => {
    const mark = nodes.marks.get(node.name);
    if (mark) marks.nodes[node.name] = mark;
    const prior = bn.get(node.name);
    // A wholly added or removed context: all its members share its mark.
    const wholesale = mark === "added" || mark === "removed" ? mark : undefined;
    const member = <T>(
      kind: MemberKind,
      priors: readonly T[],
      current: readonly T[],
      key: (t: T) => string,
      differs: (b: T, a: T) => boolean,
    ): T[] => {
      if (wholesale) {
        for (const t of current) marks.members[memberKey(node.name, kind, key(t))] = wholesale;
        return [...current];
      }
      const m = mergeKeyed(priors, current, key, differs);
      for (const [k, v] of m.marks) {
        marks.members[memberKey(node.name, kind, k)] = v;
        marks.nodes[node.name] ??= "changed";
      }
      return m.items;
    };
    const p = wholesale === "removed" || !prior ? undefined : prior;
    return {
      ...node,
      capabilities: member("capability", p?.capabilities ?? [], node.capabilities, (c) => c.name, (b, a) => b.local !== a.local || b.from !== a.from),
      providers: member("provider", p?.providers ?? [], node.providers, (c) => c.capability, (b, a) => b.providerName !== a.providerName || b.external !== a.external),
      services: member("service", p?.services ?? [], node.services, (c) => c.name, (b, a) => b.handlerCount !== a.handlerCount),
      agents: member("agent", p?.agents ?? [], node.agents, (c) => c.name, (b, a) => b.handlerCount !== a.handlerCount),
    };
  });
  const edges = mergeKeyed(before.edges, after.edges, edgeKey, (b, a) => !sameSet(b.capabilities, a.capabilities));
  for (const [k, v] of edges.marks) marks.edges[k] = v;
  return { model: { nodes: merged, edges: edges.items }, marks };
}

/** A removed path is a ghost: its violations were against the other revision's
 *  `transition`s, so they are not drawn. */
const ghostEdge = (e: StateEdge): StateEdge => ({ ...e, violations: [], diff: "removed" });

/** One state field's machine as the diff draws it: the working tree's states
 *  and paths, plus those only the other revision had. `undefined` when a
 *  machine is only in `before` and is wholly a ghost, or only in `after` and is
 *  wholly new — pass `undefined` for the side that lacks it. */
export function mergeMachine(before: StateMachine | undefined, after: StateMachine | undefined): StateMachine | undefined {
  if (!before && !after) return undefined;
  if (!before || !after) {
    const m = (after ?? before)!;
    const mark: DiffMark = after ? "added" : "removed";
    return {
      ...m,
      edges: m.edges.map((e) => (after ? { ...e, diff: mark } : ghostEdge(e))),
      diffStates: Object.fromEntries(m.states.map((s) => [s, mark])),
      diff: mark,
    };
  }
  const diffStates: Record<string, DiffMark> = {};
  const states = mergeKeyed(before.states, after.states, (s) => s, () => false);
  for (const [s, mark] of states.marks) diffStates[s] = mark;
  if (before.initial !== after.initial && after.initial !== null) diffStates[after.initial] ??= "changed";
  const edges = mergeKeyed(before.edges, after.edges, transitionKey, (b, a) => b.outcome !== a.outcome);
  const edgeMarks = edges.marks;
  const merged = edges.items.map((e) => {
    const mark = edgeMarks.get(transitionKey(e));
    return mark === "removed" ? ghostEdge(e) : mark ? { ...e, diff: mark } : e;
  });
  return {
    ...after,
    states: states.items,
    // A removed state is not "unreachable": it is a ghost, and dimming it too
    // would hide that.
    reachable: [...after.reachable, ...before.states.filter((s) => !after.states.includes(s))],
    edges: merged,
    diffStates,
  };
}

/** Whether a merged machine differs from the other revision at all. */
export function machineChanged(m: StateMachine): boolean {
  return m.diff !== undefined || Object.keys(m.diffStates ?? {}).length > 0 || m.edges.some((e) => e.diff !== undefined);
}

/** The agent state diagrams to draw: for each agent both revisions have, each
 *  state field whose machine differs. An agent that is only in one revision is
 *  an architecture entry, drawn on the map, with no state model on one side. */
export interface AgentDiagram {
  key: string;
  /** The working-tree file the agent is declared in, which its states link to. */
  uri: string;
  machines: StateMachine[];
}

/** Everything the diff page draws. */
export interface DiffGraphs {
  architecture: { model: ArchModel; marks: ArchMarks } | null;
  agents: AgentDiagram[];
}

export function buildGraphs(before: ModelSnapshot, after: ModelSnapshot): DiffGraphs {
  const architecture =
    before.architecture && after.architecture ? mergeArchitecture(before.architecture, after.architecture) : null;
  const agents: AgentDiagram[] = [];
  const uris = new Map(
    before.architecture && after.architecture
      ? sharedAgents(before.architecture, after.architecture).map((p) => [p.key, p.after.uri] as const)
      : [],
  );
  for (const [key, a] of Object.entries(after.agents)) {
    const b = before.agents[key];
    if (!b) continue;
    const fields = [...new Set([...b.machines.map((m) => m.field), ...a.machines.map((m) => m.field)])];
    const machines = fields
      .map((f) => mergeMachine(b.machines.find((m) => m.field === f), a.machines.find((m) => m.field === f)))
      .filter((m): m is StateMachine => !!m && machineChanged(m));
    if (machines.length > 0) agents.push({ key, uri: uris.get(key) ?? "", machines });
  }
  return { architecture, agents };
}
