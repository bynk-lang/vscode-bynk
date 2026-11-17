// A state field's machine as a structure diagram (model-diagrams track §10,
// slice 6), in UML state machine notation: the initial pseudo-state, each
// state a rounded box, a transition per (from, to) a handler can produce
// labelled with its handlers. ADR 0536's rules carry over: a computed write
// lands on a dashed `?` state, a state unreachable from the initial one is
// dimmed, an unchanged outcome is a self-loop only on request (or when a
// `transition` refuses it), and a handler with too many paths is a note.
//
// The grouping and the labels are `webview/state-gen.ts`'s, which the
// "Copy as Mermaid" exporter shares, so the two always agree.

import type { ArchLoc } from "../../webview/architectureTypes";
import { groupTransitions, transitionLabel } from "../../webview/state-gen";
import type { StateMachine } from "../../webview/stateTypes";
import type { Range } from "../../webview/types";
import type { StructDiagram, StructEdge, StructNode } from "./ir";

export interface StateDiagramOptions {
  /** The document the machine's ranges are in. */
  uri: string;
  /** Draw unchanged outcomes as self-loops. */
  showUnchanged: boolean;
  /** Whether elements open their source. `false` between two revisions of a
   *  model diff, where nothing is in the working tree. */
  linked?: boolean;
  /** #145: the state a live instance is in; that node is drawn current. */
  current?: string | null;
}

export const stateIds = {
  initial: "initial",
  state: (name: string): string => `state:${name}`,
  computed: "state:?",
  transition: (from: string, to: string): string => `tr:${from}->${to}`,
  truncated: "note:truncated",
};

function node(id: string, kind: StructNode["kind"], name: string, loc: ArchLoc | null): StructNode {
  return { ref: { id, loc }, kind, name, stereotype: null, detail: null, children: [], expandable: false, expanded: false, cycle: false };
}

export function toStateDiagram(machine: StateMachine, opts: StateDiagramOptions): StructDiagram {
  const linked = opts.linked !== false && machine.diff !== "removed";
  const at = (range: Range): ArchLoc | null => (linked ? { uri: opts.uri, range } : null);
  const nodes: StructNode[] = [];
  const edges: StructEdge[] = [];
  const groups = groupTransitions(machine, { showUnchanged: opts.showUnchanged });

  const hasInitial = machine.initial !== null && machine.states.includes(machine.initial);
  if (hasInitial && machine.initial !== null) {
    nodes.push(node(stateIds.initial, "initial", "initial", null));
  }
  for (const s of machine.states) {
    const mark = machine.diffStates?.[s];
    // A state has no source location of its own: it opens the field.
    const n = node(stateIds.state(s), "state", s, mark === "removed" ? null : at(machine.fieldRange));
    if (!machine.reachable.includes(s)) n.dimmed = true;
    if (s === machine.initial) n.note = "The initial state.";
    if (opts.current === s) n.current = true;
    if (mark) n.diff = mark;
    nodes.push(n);
  }
  if (groups.some((g) => g.to === "?")) {
    const q = node(stateIds.computed, "computed", "?", null);
    q.note = "Where a computed write lands: the new state depends on a value.";
    nodes.push(q);
  }
  if (machine.truncated.length > 0) {
    const names = machine.truncated.map((h) => `${h}()`).join(", ");
    nodes.push(node(stateIds.truncated, "note", `${names}: too many paths to analyse`, null));
  }

  if (hasInitial && machine.initial !== null) {
    edges.push({
      ref: { id: stateIds.transition("[*]", machine.initial), loc: null },
      kind: "transition",
      source: stateIds.initial,
      target: stateIds.state(machine.initial),
      label: null,
      cycle: false,
    });
  }
  for (const g of groups) {
    const lines = g.edges.map((e) => [`${e.handler}()`, ...e.guards.map((x) => `when ${x}`)].join(" "));
    if (g.flag) {
      const verb = g.flag === "Known" ? "violates" : "may violate";
      lines.push(`${verb} ${g.violated.join(", ")} at commit`);
    }
    const e: StructEdge = {
      ref: { id: stateIds.transition(g.from, g.to), loc: g.diff === "removed" ? null : at(g.edges[0].range) },
      kind: "transition",
      source: stateIds.state(g.from),
      target: g.to === "?" ? stateIds.computed : stateIds.state(g.to),
      label: transitionLabel(g),
      cycle: false,
      tags: g.handlers,
      note: lines.join("\n"),
    };
    if (g.flag) e.flag = g.flag;
    if (g.diff) e.diff = g.diff;
    edges.push(e);
  }
  return { nodes, edges };
}
