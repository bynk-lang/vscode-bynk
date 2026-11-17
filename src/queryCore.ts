// #148: the Bynk Query view's logic — ready-made questions about a project,
// answered from `bynk/architectureModel` (and, for what no test reached, the
// last coverage run). Dependency-free: no `vscode`, so the unit tests compile
// against it directly; `queryView.ts` holds the tree and the commands.
//
// What each question reads, and from which Bynk release:
//   - events: `ArchModel.events`, each event's emitters and subscribers
//     (bynk#3583, v0.625.3);
//   - capabilities: each context's declared and consumed capabilities and
//     providers, and each handler's resolved `given` with the suites that
//     `stub` it (`ArchNode.uses`, bynk#3583, v0.625.3);
//   - reachability: those `given`s, followed backwards through each handler's
//     `calls` (v0.634.4) to the handlers that reach them, across contexts;
//   - untested: handlers, routes and agent transitions whose lines no test ran
//     in the last coverage run. Coverage is line-level and whole-run
//     (ADR 0514), so "untested" means "no line ran" and never says which test
//     reached what (see `modelCoverageCore.ts`).
//
// An older server sends none of the later fields; each answer says what it
// could not tell rather than report an empty list as "nothing".

import { type CoverageMark, type ModelCoverage, rangeMark, stateCoverage } from "./modelCoverageCore";
import type { ArchCall, ArchHandlerUses, ArchLoc, ArchMember, ArchModel, ArchNode } from "./webview/architectureTypes";
import type { AgentStateModel, StateEdge } from "./webview/stateTypes";
import type { Range } from "./webview/types";

/** One line of an answer: what it is, where it is, and a note. */
export interface Row {
  label: string;
  description?: string;
  loc: ArchLoc | null;
}

/** `commerce.Orders.place`: a handler by its unit, service or agent and name. */
export function memberLabel(m: Pick<ArchMember, "unit" | "container" | "handler">): string {
  return `${m.unit}.${m.container}.${m.handler}`;
}

const memberRow = (m: ArchMember, description?: string): Row => ({
  label: memberLabel(m),
  ...(description ? { description } : {}),
  loc: m.loc,
});

const byLabel = (a: Row, b: Row): number => a.label.localeCompare(b.label);

// -------------------------------------------------------------- events

export interface EventAnswer {
  /** `owner.Name`. */
  name: string;
  loc: ArchLoc;
  emitters: Row[];
  subscribers: Row[];
}

/** Every declared event with who emits it and who subscribes (`delivery` says
 *  how: a queue, a cron trigger, a websocket, a direct subscription).
 *  `undefined` when the server predates events (v0.625.3). */
export function eventsQuery(model: ArchModel): EventAnswer[] | undefined {
  if (!model.events) return undefined;
  return model.events
    .map((e) => ({
      name: `${e.owner}.${e.name}`,
      loc: e.loc,
      emitters: e.emitters.map((x) => memberRow(x.member)).sort(byLabel),
      subscribers: e.subscribers.map((x) => memberRow(x.member, x.delivery)).sort(byLabel),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// -------------------------------------------------------- capabilities

export interface CapabilityRowAnswer {
  capability: string;
  /** The unit declaring it (`bynk` for the toolchain's own); `null` when this
   *  unit does. */
  from: string | null;
  /** The provider bound to it in this unit, if any. */
  providedBy?: { name: string; external: boolean };
  /** Handlers whose `given` resolves to it. */
  usedBy: Row[];
  /** Suites that `stub` it for one of those handlers. */
  stubbedIn: Row[];
  loc: ArchLoc | null;
}

export interface ContextCapabilities {
  unit: string;
  kind: ArchNode["kind"];
  loc: ArchLoc;
  rows: CapabilityRowAnswer[];
}

/** Per context or adapter, every capability it declares, consumes or provides,
 *  and which of its handlers use it (`given`) and which suites `stub` it: what
 *  the code in the unit can touch. A used capability the unit's own table does
 *  not list (an inherited `given`) is added. `usedBy` is empty for one
 *  declared and never used, and for a server that predates `uses`. */
export function capabilitiesQuery(model: ArchModel): ContextCapabilities[] {
  return model.nodes
    .map((node) => {
      const rows = new Map<string, CapabilityRowAnswer>();
      const key = (cap: string, from: string | null): string => `${from ?? node.name}\0${cap}`;
      const row = (cap: string, from: string | null, loc: ArchLoc | null): CapabilityRowAnswer => {
        const k = key(cap, from);
        let r = rows.get(k);
        if (!r) {
          r = { capability: cap, from, usedBy: [], stubbedIn: [], loc };
          rows.set(k, r);
        }
        return r;
      };
      for (const c of node.capabilities) row(c.name, c.local ? null : c.from, c.loc);
      for (const p of node.providers) {
        const r = [...rows.values()].find((x) => x.capability === p.capability);
        const target = r ?? row(p.capability, null, p.loc);
        target.providedBy = { name: p.providerName, external: p.external };
      }
      for (const h of node.uses ?? []) {
        for (const u of h.uses) {
          const from = u.from === node.name ? null : u.from;
          const r = rows.get(key(u.capability, from)) ?? row(u.capability, from, u.loc);
          const label = memberLabel(h.member);
          if (!r.usedBy.some((x) => x.label === label)) r.usedBy.push(memberRow(h.member, u.inherited ? "inherited" : undefined));
          for (const s of u.stubbedIn) {
            if (!r.stubbedIn.some((x) => x.label === s.suite)) r.stubbedIn.push({ label: s.suite, loc: s.loc });
          }
        }
      }
      const list = [...rows.values()];
      for (const r of list) {
        r.usedBy.sort(byLabel);
        r.stubbedIn.sort(byLabel);
      }
      list.sort((a, b) => a.capability.localeCompare(b.capability));
      return { unit: node.name, kind: node.kind, loc: node.loc, rows: list };
    })
    .sort((a, b) => a.unit.localeCompare(b.unit));
}

// -------------------------------------------------------- reachability

export interface CapabilityChoice {
  capability: string;
  /** The declaring unit, as `ArchUse.from` has it. */
  from: string | null;
  /** How many handlers have it in their own `given`. */
  users: number;
}

const capabilityName = (c: { capability: string; from: string | null }): string =>
  c.from ? `${c.from}.${c.capability}` : c.capability;

export const choiceLabel = capabilityName;

/** The capabilities some handler's `given` resolves to, to pick from. */
export function capabilityChoices(model: ArchModel): CapabilityChoice[] {
  const counts = new Map<string, CapabilityChoice>();
  for (const n of model.nodes) {
    for (const h of n.uses ?? []) {
      for (const u of h.uses) {
        const k = capabilityName(u);
        const c = counts.get(k) ?? { capability: u.capability, from: u.from, users: 0 };
        c.users++;
        counts.set(k, c);
      }
    }
  }
  return [...counts.values()].sort((a, b) => capabilityName(a).localeCompare(capabilityName(b)));
}

export interface Reaching {
  row: Row;
  /** `true`: the handler's own `given` names the capability. */
  direct: boolean;
  /** Calls from this handler to one that uses it, nearest first; empty when
   *  direct. */
  path: string[];
}

export interface ReachAnswer {
  capability: string;
  reaching: Reaching[];
  /** The server sends no `calls` (before v0.634.4): only direct uses are
   *  listed, and a handler that gets there by calling another is missing. */
  callsUnknown: boolean;
}

const memberKey = (m: Pick<ArchMember, "unit" | "kind" | "container" | "handler">): string =>
  `${m.unit}\0${m.kind}\0${m.container}\0${m.handler}`;

/** The members a call reaches: the named agent handler, or every handler of a
 *  service (a service call names no handler). */
function callees(members: readonly ArchHandlerUses[], call: ArchCall): ArchHandlerUses[] {
  return members.filter(
    (h) =>
      h.member.kind === call.kind &&
      h.member.unit === call.unit &&
      h.member.container === call.container &&
      (call.handler === undefined || h.member.handler === call.handler),
  );
}

/** Every handler from which the capability can be reached: those that `given`
 *  it, and those that call one that can reach it, across contexts, however
 *  deep. Each carries the shortest chain of calls. */
export function reachability(model: ArchModel, choice: Pick<CapabilityChoice, "capability" | "from">): ReachAnswer {
  const all = model.nodes.flatMap((n) => n.uses ?? []);
  const callsUnknown = all.length > 0 && all.every((h) => h.calls === undefined);
  const wanted = capabilityName(choice);
  const direct = all.filter((h) => h.uses.some((u) => capabilityName(u) === wanted));

  // Callers of each member, from the forward `calls`.
  const callersOf = new Map<string, ArchHandlerUses[]>();
  for (const h of all) {
    for (const call of h.calls ?? []) {
      for (const callee of callees(all, call)) {
        const k = memberKey(callee.member);
        const list = callersOf.get(k) ?? [];
        if (!list.includes(h)) list.push(h);
        callersOf.set(k, list);
      }
    }
  }

  const found = new Map<string, Reaching>();
  const queue: ArchHandlerUses[] = [];
  for (const h of direct) {
    found.set(memberKey(h.member), { row: memberRow(h.member, "given"), direct: true, path: [] });
    queue.push(h);
  }
  // Breadth first, so each handler's chain is the shortest.
  for (let i = 0; i < queue.length; i++) {
    const h = queue[i];
    const here = found.get(memberKey(h.member)) as Reaching;
    for (const caller of callersOf.get(memberKey(h.member)) ?? []) {
      const k = memberKey(caller.member);
      if (found.has(k)) continue;
      found.set(k, {
        row: memberRow(caller.member, `calls ${here.row.label}`),
        direct: false,
        path: [here.row.label, ...here.path],
      });
      queue.push(caller);
    }
  }
  const reaching = [...found.values()].sort(
    (a, b) => Number(b.direct) - Number(a.direct) || a.path.length - b.path.length || byLabel(a.row, b.row),
  );
  return { capability: wanted, reaching, callsUnknown };
}

// ------------------------------------------------------------ untested

/** A handler with its whole-declaration range (from the document's symbols;
 *  the model's own `loc` is the name only), and its container's protocol. */
export interface HandlerSite {
  member: ArchMember;
  /** `null` when the declaration's range could not be found. */
  range: Range | null;
  /** The service's protocol (`http`, `call`, …) when it is a service. */
  protocol?: string;
}

export interface UntestedAnswer {
  /** `from http` routes no line of which ran. */
  routes: Row[];
  /** Other handlers no line of which ran. */
  handlers: Row[];
  /** Agent state transitions no line of which ran. */
  transitions: Row[];
  /** Handlers and transitions that ran in part, as a lead to look at. */
  partial: Row[];
  /** What was measured, for the "N of M" lines. */
  measured: { routes: number; handlers: number; transitions: number };
}

/** The handlers, routes and state transitions the last coverage run did not
 *  reach. `coverage` is keyed by document URI; a file the run did not list is
 *  unmeasured, and so is a handler whose lines hold no executable statement,
 *  so neither is reported. */
export function untestedQuery(
  sites: readonly HandlerSite[],
  coverage: Readonly<Record<string, ModelCoverage | undefined>>,
  agents: ReadonlyArray<{ unit: string; agent: string; uri: string; model: AgentStateModel }>,
): UntestedAnswer {
  const out: UntestedAnswer = { routes: [], handlers: [], transitions: [], partial: [], measured: { routes: 0, handlers: 0, transitions: 0 } };
  for (const s of sites) {
    const cov = coverage[s.member.loc.uri];
    if (!cov || !s.range) continue;
    const mark = rangeMark(cov, s.range);
    if (mark === "unmeasured") continue;
    const isRoute = s.protocol === "http";
    out.measured[isRoute ? "routes" : "handlers"]++;
    place(out, mark, memberRow(s.member), isRoute ? "routes" : "handlers");
  }
  for (const a of agents) {
    const cov = coverage[a.uri];
    if (!cov) continue;
    for (const machine of a.model.machines) {
      const sc = stateCoverage(machine, cov);
      machine.edges.forEach((e, i) => {
        if (e.to.kind === "Unchanged" || sc.edges[i] === "unmeasured") return;
        out.measured.transitions++;
        place(out, sc.edges[i], transitionRow(a, machine.field, e), "transitions");
      });
    }
  }
  for (const list of [out.routes, out.handlers, out.transitions, out.partial]) list.sort(byLabel);
  return out;
}

function place(out: UntestedAnswer, mark: CoverageMark, row: Row, into: "routes" | "handlers" | "transitions"): void {
  if (mark === "uncovered") out[into].push(row);
  else if (mark === "partial") out.partial.push({ ...row, description: row.description ? `${row.description}; partly tested` : "partly tested" });
}

const target = (e: StateEdge): string => (e.to.kind === "State" ? e.to.state : "computed");

function transitionRow(a: { unit: string; agent: string; uri: string }, field: string, e: StateEdge): Row {
  const from = e.from.length > 0 ? [...e.from].sort().join(" | ") : "*";
  return {
    label: `${a.unit}.${a.agent}.${e.handler}: ${from} → ${target(e)}`,
    description: field,
    loc: { uri: a.uri, range: e.range },
  };
}
