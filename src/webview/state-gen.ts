// #2196: pure `StateMachine` -> Mermaid `stateDiagram-v2` text, and the
// handler x state table's cells. Kept free of the DOM, like `mermaid-gen.ts`
// and `architecture-gen.ts`, so it is unit-testable.
//
// Model-diagrams slice 6: the view now draws with the diagram engine
// (`diagram/structure/stateMachine.ts`), which shares `groupTransitions` and
// `transitionLabel` with this file; the Mermaid text is what "Copy as
// Mermaid" copies. The click-to-code notes below describe the Mermaid
// rendering the view used before, kept for the exporter's ids.
//
// The diagram (track §3.4, #2196 DECISION C):
//   - `[*] --> initial`, then one transition per (from, to) pair a handler can
//     produce, with the handlers that produce it joined on its label;
//   - a computed write (`Unknown`) goes to a `?` pseudo-state;
//   - an unchanged path is a self-loop, hidden unless `showUnchanged`;
//   - a state outside `reachable` is dimmed; a truncated handler is a note.
// States are addressed as `s<index>` (a state name could clash with Mermaid
// syntax), labelled with their real names.
//
// Click-to-code (DECISION D): no Mermaid `click` — in `stateDiagram-v2` it
// only takes a URL, on states only, opened in a new tab. Instead:
//   - states map by DOM id: Mermaid gives each the id `state-<id>-<n>`
//     (`stateDomId`), so `s3`'s node is found by its `state-s3-` prefix;
//   - transition labels map by `edgeOrder`: Mermaid names each transition
//     `edge<n>`, with `n` increasing in statement order, so sorting the label
//     elements by that number recovers this module's emission order whatever
//     order the layout put them in the DOM (`state-map.ts`).

import { type DiffMark, markClass, MARK_SIGN } from "./diffMarks";
import type { StateEdge, StateMachine } from "./stateTypes";

export interface StateMermaidOptions {
  /** Draw unchanged (refused) outcomes as self-loops. Off by default. */
  showUnchanged: boolean;
}

/** One rendered transition: every model edge it stands for. */
export interface TransitionGroup {
  from: string;
  /** A state name, or `"?"` for a computed write. */
  to: string;
  handlers: string[];
  edges: StateEdge[];
  /** #2197: the strongest `transition` violation on this transition, if any. */
  flag: "Known" | "Possible" | null;
  /** The violated `transition`s' names. */
  violated: string[];
  /** #153: how this transition differs from the other revision, when the
   *  machine is the merged one of a model diff. A transition standing for
   *  edges of different marks, or some marked and some not, is `changed`. */
  diff?: DiffMark;
}

export interface StateMermaidResult {
  text: string;
  /** Emission order of the transitions, `[*] --> initial` excluded. */
  edgeOrder: TransitionGroup[];
  /** Whether `[*] --> initial` was emitted (it is the first transition). */
  hasInitial: boolean;
  /** Mermaid state id (`s0`, …, `unknown`) -> state name (`?` for unknown). */
  stateIds: Map<string, string>;
}

export const UNKNOWN_ID = "unknown";

function stateId(i: number): string {
  return `s${i}`;
}

/** Mermaid's state description and transition labels split on `:` and `;`. */
function esc(label: string): string {
  return label.replace(/\s+/g, " ").replace(/[:;]/g, " ").trim();
}

/** The transitions to draw: one per (from, to) a handler can produce, with
 *  every model edge it stands for. Shared by the Mermaid exporter and the
 *  diagram engine (`diagram/structure/stateMachine.ts`, model-diagrams slice
 *  6), so the two always agree:
 *   - a computed write (`Unknown`) goes to `"?"`;
 *   - an unchanged path is a self-loop, kept only with `showUnchanged`, or
 *     when a `transition` refuses it (a flagged edge is never hidden);
 *   - an edge from or to a state the model did not declare is skipped (the
 *     table still lists it). */
export function groupTransitions(machine: StateMachine, opts: StateMermaidOptions): TransitionGroup[] {
  const index = new Set(machine.states);
  const groups: TransitionGroup[] = [];
  const add = (from: string, to: string, edge: StateEdge): void => {
    if (!index.has(from) || (to !== "?" && !index.has(to))) return;
    let g = groups.find((x) => x.from === from && x.to === to);
    if (!g) {
      g = { from, to, handlers: [], edges: [], flag: null, violated: [] };
      groups.push(g);
    }
    if (!g.handlers.includes(edge.handler)) g.handlers.push(edge.handler);
    g.edges.push(edge);
    if (edge.diff !== undefined || g.edges.length > 1) {
      const first = g.edges[0].diff;
      const mark = g.edges.every((x) => x.diff === first) ? first : "changed";
      if (mark) g.diff = mark;
    }
    for (const v of violationsFrom(edge, from)) {
      if (!g.violated.includes(v.transition)) g.violated.push(v.transition);
      if (g.flag !== "Known") g.flag = v.certainty;
    }
  };
  for (const e of machine.edges) {
    for (const from of e.from) {
      if (e.to.kind === "State") add(from, e.to.state, e);
      else if (e.to.kind === "Unknown") add(from, "?", e);
      else if (opts.showUnchanged || violationsFrom(e, from).length > 0) add(from, from, e);
    }
  }
  return groups;
}

/** A transition's label: its handlers, a ⚠ and the refused `transition`s when
 *  flagged, and the diff sign when marked. */
export function transitionLabel(g: TransitionGroup): string {
  const handlers = g.handlers.map((h) => `${h}()`).join(", ");
  const flagged = g.flag ? `⚠ ${handlers} (${g.violated.join(", ")})` : handlers;
  return g.diff ? `${MARK_SIGN[g.diff]} ${flagged}` : flagged;
}

export function toMermaidState(machine: StateMachine, opts: StateMermaidOptions): StateMermaidResult {
  const lines = ["stateDiagram-v2"];
  const stateIds = new Map<string, string>();
  const index = new Map(machine.states.map((s, i) => [s, i]));
  machine.states.forEach((s, i) => {
    stateIds.set(stateId(i), s);
    lines.push(`    state "${esc(s)}" as ${stateId(i)}`);
  });
  const groups = groupTransitions(machine, opts);

  if (groups.some((g) => g.to === "?")) {
    stateIds.set(UNKNOWN_ID, "?");
    lines.push(`    state "?" as ${UNKNOWN_ID}`);
  }

  const idOf = (name: string): string =>
    name === "?" ? UNKNOWN_ID : stateId(index.get(name) ?? 0);

  const hasInitial = machine.initial !== null && index.has(machine.initial);
  if (hasInitial && machine.initial !== null) lines.push(`    [*] --> ${idOf(machine.initial)}`);
  for (const g of groups) lines.push(`    ${idOf(g.from)} --> ${idOf(g.to)} : ${esc(transitionLabel(g))}`);

  if (machine.truncated.length > 0 && machine.states.length > 0) {
    const names = machine.truncated.map((h) => `${h}()`).join(", ");
    lines.push(`    note right of ${stateId(0)} : ${esc(`${names} too many paths to analyse`)}`);
  }

  const dimmed = machine.states
    .map((s, i) => [s, i] as const)
    .filter(([s]) => !machine.reachable.includes(s))
    .map(([, i]) => stateId(i));
  lines.push("    classDef unreachable opacity:0.45,stroke-dasharray:4 3");
  lines.push("    classDef computed stroke-dasharray:4 3");
  if (dimmed.length > 0) lines.push(`    class ${dimmed.join(",")} unreachable`);
  if (stateIds.has(UNKNOWN_ID)) lines.push(`    class ${UNKNOWN_ID} computed`);
  // #153: a diff's marked states. The webview appends the `diff*` classDefs.
  for (const mark of ["added", "changed", "removed"] as const) {
    const ids = machine.states
      .map((s, i) => [s, i] as const)
      .filter(([s]) => machine.diffStates?.[s] === mark)
      .map(([, i]) => stateId(i));
    if (ids.length > 0) lines.push(`    class ${ids.join(",")} ${markClass(mark)}`);
  }

  return { text: lines.join("\n"), edgeOrder: groups, hasInitial, stateIds };
}

/** #2197: the violations of `edge` that apply when it starts in `from`. */
export function violationsFrom(edge: StateEdge, from: string): StateEdge["violations"] {
  return (edge.violations ?? []).filter((v) => v.from.includes(from));
}

/** One cell of the handler x state table: every path of `handler` that can
 *  start in `state`. Empty when the handler has no path from it (a path the
 *  extractor pruned as infeasible). */
export function cellEdges(machine: StateMachine, handler: string, state: string): StateEdge[] {
  return machine.edges.filter((e) => e.handler === handler && e.from.includes(state));
}

/** A cell entry's text: `→ Placed · Ok(())`, `Err(AlreadyPlaced)`, `→ ? · …`. */
export function cellText(edge: StateEdge): string {
  const target =
    edge.to.kind === "State" ? `→ ${edge.to.state}` : edge.to.kind === "Unknown" ? "→ ?" : "";
  const outcome = edge.outcome ?? "";
  return [target, outcome].filter((p) => p !== "").join(" · ") || "()";
}

/** #2198: an effect-row write's label: `lastSeq :=`, `items.put(id, …)`,
 *  `history.append(event)`. */
export function writeText(w: { field: string; op: string; key: string | null }): string {
  if (w.op === ":=") return `${w.field} :=`;
  return w.key === null ? `${w.field}.${w.op}(…)` : `${w.field}.${w.op}(${w.key}${w.op === "put" || w.op === "upsert" || w.op === "update" ? ", …" : ""})`;
}
