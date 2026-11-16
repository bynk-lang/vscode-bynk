// `ArchModel` (the `bynk/architectureModel` wire shape) → the structure IR:
// the architecture map as a system view (model-diagrams track §7.2).
//
// - The project's contexts and adapters sit inside a system boundary, as
//   «context» and «adapter» components. A collapsed one says what it holds;
//   an expanded one nests its services, agents, capabilities and providers
//   inside itself (ADR 0302's context-level default, now expanded in place).
// - `consumes` edges run between them, labelled by what is selected. A
//   `consumes` cycle (a checker error) is marked on its nodes and edges.
// - Outside the boundary: the actors that call in (each service's `actors`,
//   bynk-lang/bynk#3654), and units the system binds capabilities from that
//   are not project units (the built-in `bynk` surface), as «platform».
// - Events (ADR 0854), when shown: an «event» node between its emitters and
//   subscribers.
//
// Every newer field is optional: an older server's model draws the units, the
// `consumes` edges and the platform wiring (from `capabilities`), without
// actors or events.

import type { ArchLoc, ArchMember, ArchModel, ArchNode } from "../../webview/architectureTypes";
import type { StructDiagram, StructEdge, StructEdgeKind, StructNode } from "./ir";

export interface ArchitectureOptions {
  /** The units (by name) the reader opened. */
  expanded: ReadonlySet<string>;
  /** Draw events and their emit/subscribe edges. */
  events: boolean;
}

export const ids = {
  unit: (name: string): string => `u:${name}`,
  boundary: "system",
  platform: (name: string): string => `x:${name}`,
  actor: (name: string): string => `actor:${name}`,
  event: (owner: string, name: string): string => `ev:${owner}/${name}`,
  service: (unit: string, name: string): string => `svc:${unit}/${name}`,
  agent: (unit: string, name: string): string => `agent:${unit}/${name}`,
  capability: (unit: string, name: string): string => `cap:${unit}/${name}`,
  provider: (unit: string, cap: string): string => `prov:${unit}/${cap}`,
};

const PROTOCOL_WORD: Record<string, string> = {
  http: "http",
  websocket: "websocket",
  cron: "cron",
  queue: "queue",
  events: "events",
  email: "email",
};

function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** A collapsed unit's contents in one line: `http · 2 services · 1 agent`. */
function summary(n: ArchNode): string | null {
  const protocols = [...new Set(n.services.map((s) => s.protocol).filter((p): p is string => !!p && p in PROTOCOL_WORD))];
  const parts = [
    ...protocols.map((p) => PROTOCOL_WORD[p]),
    n.services.length > 0 ? plural(n.services.length, "service") : null,
    n.agents.length > 0 ? plural(n.agents.length, "agent") : null,
    local(n) > 0 ? plural(local(n), "capability", "capabilities") : null,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function local(n: ArchNode): number {
  return n.capabilities.filter((c) => c.local).length;
}

function memberCount(n: ArchNode): number {
  return n.services.length + n.agents.length + local(n) + n.providers.length;
}

function leaf(id: string, kind: StructNode["kind"], name: string, stereotype: string | null, loc: ArchLoc | null, detail: string | null = null): StructNode {
  return { ref: { id, loc }, kind, name, stereotype, detail, children: [], expandable: false, expanded: false, cycle: false };
}

function unitNode(n: ArchNode, expanded: boolean): StructNode {
  const kind = n.kind === "Adapter" ? "adapter" : "context";
  const children: StructNode[] = expanded
    ? [
        ...n.services.map((s) =>
          leaf(
            ids.service(n.name, s.name),
            "service",
            s.name,
            s.protocol && s.protocol !== "call" ? `${s.protocol} service` : "service",
            s.loc,
            plural(s.handlerCount, "handler"),
          ),
        ),
        ...n.agents.map((a) => leaf(ids.agent(n.name, a.name), "agent", a.name, "agent", a.loc, plural(a.handlerCount, "handler"))),
        ...n.capabilities
          .filter((c) => c.local)
          .map((c) => leaf(ids.capability(n.name, c.name), "capability", c.name, "capability", c.loc)),
        ...n.providers.map((p) => leaf(ids.provider(n.name, p.capability), "provider", `${p.capability} = ${p.providerName}`, "provider", p.loc)),
      ]
    : [];
  return {
    ref: { id: ids.unit(n.name), loc: n.loc },
    kind,
    name: n.name,
    stereotype: kind,
    detail: expanded ? null : summary(n),
    children,
    expandable: memberCount(n) > 0,
    expanded: expanded && memberCount(n) > 0,
    cycle: false,
    // Model-diagrams slice 5: a unit's ↗ opens its component view.
    opens: true,
  };
}

/** The node a member's edges attach to: the member when its unit is open,
 *  else the unit. */
function memberNode(m: ArchMember, expanded: ReadonlySet<string>, units: ReadonlySet<string>): string | null {
  if (!units.has(m.unit)) return null;
  if (!expanded.has(m.unit)) return ids.unit(m.unit);
  if (m.kind === "service") return ids.service(m.unit, m.container);
  if (m.kind === "agent") return ids.agent(m.unit, m.container);
  return ids.unit(m.unit);
}

/** The units on a `consumes` cycle, and the edges inside one (Tarjan's
 *  strongly connected components). */
export function consumesCycles(model: ArchModel): { units: Set<string>; edges: Set<number> } {
  const names = model.nodes.map((n) => n.name);
  const out = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of model.edges) out.get(e.from)?.push(e.to);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const comp = new Map<string, number>();
  let comps = 0;
  const visit = (v: string): void => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) {
        if (!out.has(w)) continue;
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.set(w, comps);
      } while (w !== v);
      comps++;
    }
  };
  for (const n of names) if (!idx.has(n)) visit(n);
  const size = new Map<number, number>();
  for (const c of comp.values()) size.set(c, (size.get(c) ?? 0) + 1);
  const units = new Set<string>();
  const edges = new Set<number>();
  model.edges.forEach((e, i) => {
    const same = comp.has(e.from) && comp.get(e.from) === comp.get(e.to);
    if (same && (e.from === e.to || (size.get(comp.get(e.from)!) ?? 0) > 1)) {
      edges.add(i);
      units.add(e.from);
      units.add(e.to);
    }
  });
  return { units, edges };
}

export function toArchitectureDiagram(model: ArchModel, opts: ArchitectureOptions): StructDiagram {
  const units = new Set(model.nodes.map((n) => n.name));
  const cycles = consumesCycles(model);
  const inside: StructNode[] = model.nodes.map((n) => {
    const node = unitNode(n, opts.expanded.has(n.name));
    node.cycle = cycles.units.has(n.name);
    return node;
  });
  const outside: StructNode[] = [];
  const edges: StructEdge[] = [];
  const seen = new Map<string, StructEdge>();
  const edge = (kind: StructEdgeKind, source: string, target: string, label: string | null, loc: ArchLoc | null, cycle = false): void => {
    const key = `${kind}|${source}|${target}`;
    const had = seen.get(key);
    if (had) {
      // Merge labels of parallel edges of one kind.
      if (label && had.label && !had.label.split(", ").includes(label)) had.label = `${had.label}, ${label}`;
      return;
    }
    const e: StructEdge = { ref: { id: `e${edges.length}`, loc }, kind, source, target, label, cycle };
    seen.set(key, e);
    edges.push(e);
  };

  // `consumes` between project units.
  model.edges.forEach((e, i) => {
    if (!units.has(e.from) || !units.has(e.to)) return;
    edge("consumes", ids.unit(e.from), ids.unit(e.to), e.capabilities.length > 0 ? e.capabilities.join(", ") : null, e.loc, cycles.edges.has(i));
  });

  // Capabilities bound from outside the project (the `bynk` surface): the
  // units the system relies on but does not contain. A unit already linked
  // by `consumes` carries its selection on that edge.
  const consumed = new Set(model.edges.map((e) => `${e.from}|${e.to}`));
  const platforms = new Map<string, StructNode>();
  const platform = (name: string): string => {
    const id = ids.platform(name);
    if (!platforms.has(name)) platforms.set(name, leaf(id, "platform", name, "platform", null));
    return id;
  };
  for (const n of model.nodes) {
    const fromUses = (n.uses ?? []).flatMap((h) => h.uses.map((u) => ({ member: h.member, use: u })));
    if (fromUses.length > 0) {
      for (const { member, use } of fromUses) {
        if (!use.from || use.from === n.name || units.has(use.from)) continue;
        const source = memberNode(member, opts.expanded, units) ?? ids.unit(n.name);
        edge("wires", source, platform(use.from), use.capability, use.loc);
      }
    } else {
      for (const c of n.capabilities) {
        if (c.local || !c.from || units.has(c.from) || consumed.has(`${n.name}|${c.from}`)) continue;
        edge("wires", ids.unit(n.name), platform(c.from), c.name, c.loc);
      }
    }
  }
  outside.push(...platforms.values());

  // Actors calling in (bynk-lang/bynk#3654).
  const actors = new Map<string, StructNode>();
  for (const n of model.nodes) {
    for (const s of n.services) {
      for (const a of s.actors ?? []) {
        if (!actors.has(a)) actors.set(a, leaf(ids.actor(a), "actor", a, null, null));
        const target = opts.expanded.has(n.name) ? ids.service(n.name, s.name) : ids.unit(n.name);
        edge("calls", ids.actor(a), target, s.protocol && s.protocol !== "call" ? s.protocol : null, s.loc);
      }
    }
  }
  outside.unshift(...actors.values());

  // Events (ADR 0854).
  if (opts.events) {
    for (const ev of model.events ?? []) {
      const id = ids.event(ev.owner, ev.name);
      if (ev.emitters.length === 0 && ev.subscribers.length === 0) continue;
      inside.push(leaf(id, "event", ev.name, "event", ev.loc));
      for (const em of ev.emitters) {
        const from = memberNode(em.member, opts.expanded, units);
        if (from) edge("emits", from, id, null, em.loc);
      }
      for (const sub of ev.subscribers) {
        const to = memberNode(sub.member, opts.expanded, units);
        if (to) edge("subscribes", id, to, sub.delivery === "all" ? null : sub.delivery, sub.loc);
      }
    }
  }

  const boundary: StructNode = {
    ref: { id: ids.boundary, loc: null },
    kind: "boundary",
    name: "system",
    stereotype: null,
    detail: null,
    children: inside,
    expandable: false,
    expanded: true,
    cycle: false,
  };
  return { nodes: [...outside.filter((n) => n.kind === "actor"), boundary, ...outside.filter((n) => n.kind !== "actor")], edges };
}
