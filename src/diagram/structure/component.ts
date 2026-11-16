// The component view (model-diagrams track §8, slice 5): one context opened
// up as a UML component diagram with composite structure, from the same
// `bynk/architectureModel` the map draws (D4).
//
// - Inside the context: its services, agents and providers as parts. A
//   service lists its handlers as operations; an agent its key, its state and
//   its handlers.
// - On its border: a provided port per service (what other contexts consume,
//   and the HTTP surface), and a required port per capability it needs from
//   outside and per consumed service it calls. Delegation connectors join
//   each port to the parts that realise or need it.
// - Outside, in grey, one level deep: the actors and contexts that call in,
//   on the left; the units that satisfy its requirements, on the right.
//   Assembly connectors join them to the ports.
//
// Every element links to its source. An operation's ↗ opens its sequence
// diagram; a neighbouring context's ↗ opens its own component view (§9).

import type { ArchCall, ArchHandlerUses, ArchLoc, ArchModel, ArchNode } from "../../webview/architectureTypes";
import { ids } from "./architecture";
import type { StructDiagram, StructEdge, StructEdgeKind, StructItem, StructNode, StructPort } from "./ir";

export const componentIds = {
  provided: (unit: string, service: string): string => `pp:${unit}/${service}`,
  requiredCapability: (unit: string, from: string, cap: string): string => `rp:${unit}/cap:${from}/${cap}`,
  requiredService: (unit: string, target: string, service: string): string => `rp:${unit}/svc:${target}/${service}`,
  requiredUnit: (unit: string, target: string): string => `rp:${unit}/unit:${target}`,
  operation: (unit: string, container: string, handler: string): string => `op:${unit}/${container}/${handler}`,
  attribute: (unit: string, agent: string, what: "key" | "state"): string => `at:${unit}/${agent}/${what}`,
};

/** What the page needs beyond the drawing: where each ↗ leads. */
export interface ComponentLinks {
  /** Operation id → its handler's source, to open its sequence diagram. */
  sequences: Map<string, ArchLoc>;
  /** Neighbour id → the unit whose component view it opens. */
  components: Map<string, string>;
}

export interface ComponentView {
  diagram: StructDiagram;
  links: ComponentLinks;
}

/** Every file a unit's declarations come from. */
function unitFiles(n: ArchNode): Set<string> {
  const files = new Set<string>([n.loc.uri]);
  for (const x of [...n.services, ...n.agents, ...n.capabilities, ...n.providers]) files.add(x.loc.uri);
  for (const h of n.uses ?? []) files.add(h.member.loc.uri);
  return files;
}

/** The unit `uri` belongs to: the one that declares something in it. */
export function unitOfUri(model: ArchModel, uri: string): string | null {
  return model.nodes.find((n) => unitFiles(n).has(uri))?.name ?? null;
}

const PROTOCOL_PORT: Record<string, string> = { http: "http", websocket: "websocket", cron: "cron", queue: "queue", events: "events", email: "email" };

function node(id: string, kind: StructNode["kind"], name: string, stereotype: string | null, loc: ArchLoc | null): StructNode {
  return { ref: { id, loc }, kind, name, stereotype, detail: null, children: [], expandable: false, expanded: false, cycle: false };
}

/** Build the component view of `unit`, or `null` when the model has no such
 *  unit. */
export function toComponentDiagram(model: ArchModel, unit: string): ComponentView | null {
  const subject = model.nodes.find((n) => n.name === unit);
  if (!subject) return null;
  const units = new Map(model.nodes.map((n) => [n.name, n]));
  const handlers = subject.uses ?? [];
  const links: ComponentLinks = { sequences: new Map(), components: new Map() };

  const edges: StructEdge[] = [];
  const edgeIndex = new Map<string, StructEdge>();
  const edge = (kind: StructEdgeKind, source: string, target: string, label: string | null, loc: ArchLoc | null): void => {
    const key = `${kind}:${source}->${target}`;
    const seen = edgeIndex.get(key);
    if (seen) {
      if (label && !(seen.label ?? "").split(", ").includes(label)) seen.label = seen.label ? `${seen.label}, ${label}` : label;
      return;
    }
    const e: StructEdge = { ref: { id: `e:${key}`, loc }, kind, source, target, label, cycle: false };
    edgeIndex.set(key, e);
    edges.push(e);
  };

  const operations = (kind: "service" | "agent" | "provider", container: string): StructItem[] =>
    handlers
      .filter((h) => h.member.kind === kind && h.member.container === container)
      .map((h) => {
        const id = componentIds.operation(unit, container, h.member.handler);
        if (kind !== "provider") links.sequences.set(id, h.member.loc);
        return { ref: { id, loc: h.member.loc }, text: h.member.handler, role: "operation" as const };
      });

  // -- The parts. --
  const parts: StructNode[] = [];
  const partOf = (h: ArchHandlerUses): string | null => {
    const m = h.member;
    if (m.kind === "service") return ids.service(unit, m.container);
    if (m.kind === "agent") return ids.agent(unit, m.container);
    const p = subject.providers.find((x) => x.providerName === m.container);
    return p ? ids.provider(unit, p.capability) : null;
  };
  for (const s of subject.services) {
    const part = node(ids.service(unit, s.name), "service", s.name, s.protocol && s.protocol !== "call" ? `${s.protocol} service` : "service", s.loc);
    part.items = operations("service", s.name);
    if (part.items.length === 0 && !subject.uses) part.detail = `${s.handlerCount} handler${s.handlerCount === 1 ? "" : "s"}`;
    parts.push(part);
  }
  for (const a of subject.agents) {
    const part = node(ids.agent(unit, a.name), "agent", a.name, "agent", a.loc);
    const items: StructItem[] = [];
    if (a.key) items.push({ ref: { id: componentIds.attribute(unit, a.name, "key"), loc: a.loc }, text: `key ${a.key}`, role: "attribute" });
    if (a.state && a.state.length > 0) {
      items.push({ ref: { id: componentIds.attribute(unit, a.name, "state"), loc: a.loc }, text: `store ${a.state.join(", ")}`, role: "attribute" });
    }
    items.push(...operations("agent", a.name));
    part.items = items;
    parts.push(part);
  }
  for (const p of subject.providers) {
    const part = node(ids.provider(unit, p.capability), "provider", p.providerName, p.external ? "external provider" : "provider", p.loc);
    part.detail = `provides ${p.capability}`;
    part.items = operations("provider", p.providerName);
    parts.push(part);
  }

  // -- Ports: provided on the left, required on the right. --
  const ports: StructPort[] = [];
  const portIds = new Set<string>();
  /** A required port → the unit that satisfies it. */
  const satisfiedBy = new Map<string, string>();
  const port = (id: string, name: string, kind: StructPort["kind"], loc: ArchLoc | null, from?: string): string => {
    if (!portIds.has(id)) {
      portIds.add(id);
      ports.push({ ref: { id, loc }, name, kind });
      if (from !== undefined) satisfiedBy.set(id, from);
    }
    return id;
  };
  for (const s of subject.services) {
    const protocol = s.protocol && PROTOCOL_PORT[s.protocol];
    const id = port(componentIds.provided(unit, s.name), protocol ? `${s.name} · ${protocol}` : s.name, "provided", s.loc);
    edge("delegates", id, ids.service(unit, s.name), null, s.loc);
  }

  // What each part needs and calls.
  const localProvider = (cap: string): string | null =>
    subject.providers.some((p) => p.capability === cap) ? ids.provider(unit, cap) : null;
  for (const h of handlers) {
    const part = partOf(h);
    if (!part) continue;
    for (const u of h.uses) {
      if (u.from === unit || u.from === null) {
        const provider = localProvider(u.capability);
        if (provider && provider !== part) edge("invokes", part, provider, u.capability, u.loc);
        continue;
      }
      const id = port(componentIds.requiredCapability(unit, u.from, u.capability), u.capability, "required", u.loc, u.from);
      edge("delegates", part, id, null, u.loc);
    }
    for (const c of h.calls ?? []) callEdge(c, part);
  }

  function callEdge(c: ArchCall, part: string): void {
    if (c.kind === "agent") {
      if (c.unit === unit) edge("invokes", part, ids.agent(unit, c.container), c.handler ?? null, c.loc);
      return;
    }
    const id = port(componentIds.requiredService(unit, c.unit, c.container), `${c.unit}.${c.container}`, "required", c.loc, c.unit);
    edge("delegates", part, id, null, c.loc);
  }

  // An older server's model carries no `uses`: fall back to the unit's
  // consumed capabilities and its `consumes` edges, undelegated.
  if (!subject.uses) {
    for (const c of subject.capabilities) {
      if (!c.local && c.from) port(componentIds.requiredCapability(unit, c.from, c.name), c.name, "required", c.loc, c.from);
    }
  }
  for (const e of model.edges.filter((x) => x.from === unit && x.to !== unit)) {
    const covered = [...satisfiedBy.values()].includes(e.to);
    if (!covered) port(componentIds.requiredUnit(unit, e.to), e.to, "required", e.loc, e.to);
  }

  // -- Outside: callers on the left, providers on the right. --
  const left: StructNode[] = [];
  const right: StructNode[] = [];
  const neighbour = (name: string, side: StructNode[]): string => {
    const n = units.get(name);
    const id = n ? ids.unit(name) : ids.platform(name);
    if (![...left, ...right].some((x) => x.ref.id === id)) {
      const kind = n ? (n.kind === "Adapter" ? "adapter" : "context") : "platform";
      const out = node(id, kind, name, kind, n?.loc ?? null);
      out.muted = true;
      if (n) {
        out.opens = true;
        links.components.set(id, name);
      }
      side.push(out);
    }
    return id;
  };

  const actors = new Set<string>();
  for (const s of subject.services) {
    for (const a of s.actors ?? []) {
      const id = ids.actor(a);
      if (!actors.has(a)) {
        actors.add(a);
        left.push(node(id, "actor", a, null, null));
      }
      // The port's own label already names the protocol.
      edge("assembly", id, componentIds.provided(unit, s.name), null, s.loc);
    }
  }
  for (const e of model.edges.filter((x) => x.to === unit && x.from !== unit)) {
    const consumer = units.get(e.from);
    const id = neighbour(e.from, left);
    const called = new Set<string>();
    for (const h of consumer?.uses ?? []) {
      for (const c of h.calls ?? []) {
        if (c.kind === "service" && c.unit === unit && subject.services.some((s) => s.name === c.container)) called.add(c.container);
      }
    }
    if (called.size === 0) edge("assembly", id, ids.unit(unit), null, e.loc);
    for (const svc of called) edge("assembly", id, componentIds.provided(unit, svc), null, e.loc);
  }

  for (const [id, target] of satisfiedBy) {
    if (target === unit) continue;
    edge("assembly", id, neighbour(target, right), null, ports.find((p) => p.ref.id === id)?.ref.loc ?? null);
  }

  const kind = subject.kind === "Adapter" ? "adapter" : "context";
  const center: StructNode = {
    ...node(ids.unit(unit), kind, unit, kind, subject.loc),
    children: parts,
    expanded: parts.length > 0,
    ports,
  };
  // Only edges between drawn elements: `uses` can name a member the
  // declarations no longer have (a model taken mid-edit).
  const nodes = [...left, center, ...right];
  const present = new Set<string>(portIds);
  const walk = (ns: StructNode[]): void => {
    for (const n of ns) {
      present.add(n.ref.id);
      walk(n.children);
    }
  };
  walk(nodes);
  return { diagram: { nodes, edges: edges.filter((e) => present.has(e.source) && present.has(e.target)) }, links };
}
