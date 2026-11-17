// #145: the dependency-free core of live agent inspection — `bynk dev inspect`
// (bynk#3581, ADR 0865/0869; shipped v0.629.5–v0.633.2, Worker groups in
// v0.639.0). The argument lists, the parsers for the two JSON answers, the
// rendering of wire-form values in Bynk's own terms, and the history helpers.
// No `vscode` import, so the unit tests compile against it directly;
// `agentInspect.ts` wires it to the editor.
//
import type { InstanceView, LiveInstance } from "./webview/stateTypes";

// Formats are those of bynk v0.639.1: `bynk/src/dev_inspect.rs` (the
// `agents` answer at `run`, :270; the `agent` answer at `read_agent`, :298) and
// the `Inspecting agents` reference in `site/src/content/docs/docs/bynk-cli.md`.
//
// Parsers are total: a field the driver adds is ignored, and anything
// malformed is `undefined`, never a throw.

/** One instance `inspect agents` lists. `key` is in wire form: a string key as
 *  a string, any other key as its JSON value. */
export interface AgentInstanceRef {
  context: string;
  class: string;
  key: unknown;
  id: string;
}

export interface AgentListing {
  agents: AgentInstanceRef[];
  /** A context that could not be reached; the others still answered. */
  errors: Array<{ context: string; error: string }>;
}

/** The stored cells and each collection's size, as a history entry holds them. */
export interface StateSnapshot {
  cells: Record<string, unknown>;
  collections: Record<string, number | null>;
}

/** One committed transition. `old` is `null` for the instance's first
 *  recorded commit; `handler` is `null` for a commit a migration made. A
 *  transition a handler or invariant refuses is never committed, so it has no
 *  entry (ADR 0869). */
export interface HistoryEntry {
  handler: string | null;
  old: StateSnapshot | null;
  new: StateSnapshot;
  /** Milliseconds since the epoch. */
  at: number;
}

export interface CollectionPage {
  kind: string;
  size: number | null;
  entries: unknown[];
  next: string | null;
}

/** What `inspect agent CLASS KEY` answers for an instance. */
export type AgentInspection =
  | { exists: false; context: string; class: string; key: unknown; id: string }
  | {
      exists: true;
      readable: false;
      /** `NewerLayout`, `NewerSchema` or `NoMigrationPath`. */
      fault: string;
      context: string;
      class: string;
      key: unknown;
      id: string;
    }
  | {
      exists: true;
      readable: true;
      context: string;
      class: string;
      key: unknown;
      id: string;
      /** The schema version of the stored record; `null` when absent. */
      version: number | null;
      /** The build's version; `null` when the project has no schema lock. */
      current: number | null;
      layout: number | null;
      migrationPending: boolean;
      cells: Record<string, unknown>;
      collections: Record<string, CollectionPage>;
      history: HistoryEntry[];
    };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse `bynk dev inspect agents`'s stdout. */
export function parseAgentListing(stdout: string): AgentListing | undefined {
  const raw = parseJson(stdout);
  if (!isObject(raw) || !Array.isArray(raw.agents)) return undefined;
  const agents: AgentInstanceRef[] = [];
  for (const a of raw.agents) {
    if (!isObject(a) || typeof a.class !== "string" || typeof a.id !== "string" || !("key" in a)) continue;
    agents.push({ context: typeof a.context === "string" ? a.context : "", class: a.class, key: a.key, id: a.id });
  }
  const errors: AgentListing["errors"] = [];
  for (const e of Array.isArray(raw.errors) ? raw.errors : []) {
    if (isObject(e) && typeof e.error === "string") {
      errors.push({ context: typeof e.context === "string" ? e.context : "", error: e.error });
    }
  }
  return { agents, errors };
}

function parseSnapshot(raw: unknown): StateSnapshot | undefined {
  if (!isObject(raw) || !isObject(raw.cells)) return undefined;
  const collections: Record<string, number | null> = {};
  if (isObject(raw.collections)) {
    for (const [name, size] of Object.entries(raw.collections)) collections[name] = numberOrNull(size);
  }
  return { cells: raw.cells, collections };
}

function parseHistory(raw: unknown): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!isObject(e)) continue;
    const next = parseSnapshot(e.new);
    if (!next) continue;
    const old = e.old === null || e.old === undefined ? null : (parseSnapshot(e.old) ?? null);
    out.push({ handler: typeof e.handler === "string" ? e.handler : null, old, new: next, at: numberOrNull(e.at) ?? 0 });
  }
  return out;
}

function parsePage(raw: unknown): CollectionPage | undefined {
  if (!isObject(raw)) return undefined;
  return {
    kind: typeof raw.kind === "string" ? raw.kind : "",
    size: numberOrNull(raw.size),
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    next: typeof raw.next === "string" ? raw.next : null,
  };
}

/** Parse `bynk dev inspect agent`'s stdout. */
export function parseAgentInspection(stdout: string): AgentInspection | undefined {
  const raw = parseJson(stdout);
  if (!isObject(raw) || typeof raw.class !== "string" || typeof raw.exists !== "boolean") return undefined;
  const base = {
    context: typeof raw.context === "string" ? raw.context : "",
    class: raw.class,
    key: raw.key,
    id: typeof raw.id === "string" ? raw.id : "",
  };
  if (!raw.exists) return { exists: false, ...base };
  if (raw.readable === false) {
    return { exists: true, readable: false, fault: typeof raw.fault === "string" ? raw.fault : "", ...base };
  }
  if (!isObject(raw.cells)) return undefined;
  const collections: Record<string, CollectionPage> = {};
  if (isObject(raw.collections)) {
    for (const [name, page] of Object.entries(raw.collections)) {
      const p = parsePage(page);
      if (p) collections[name] = p;
    }
  }
  return {
    exists: true,
    readable: true,
    ...base,
    version: numberOrNull(raw.version),
    current: numberOrNull(raw.current),
    layout: numberOrNull(raw.layout),
    migrationPending: raw.migrationPending === true,
    cells: raw.cells,
    collections,
    history: parseHistory(raw.history),
  };
}

/** `bynk dev inspect agents`'s arguments, for one class. `--class` is a flag,
 *  so a class name can never be read as another option. */
export function inspectAgentsArgs(className: string, context?: string): string[] {
  const args = ["dev", "inspect", "agents", ".", "--class", className];
  if (context) args.push("--context", context);
  return args;
}

/** The key as the CLI takes it: a string as it is, any other key as JSON. */
export function keyArgument(key: unknown): string {
  return typeof key === "string" ? key : JSON.stringify(key);
}

/** `bynk dev inspect agent CLASS KEY`'s arguments. Options come first and the
 *  positionals after `--`, so a key that starts with `-` is still a key. */
export function inspectAgentArgs(className: string, key: unknown, opts: { context?: string; limit?: number } = {}): string[] {
  const args = ["dev", "inspect", "agent", "--path", "."];
  if (opts.context) args.push("--context", opts.context);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  args.push("--", className, keyArgument(key));
  return args;
}

/** A key for display and for telling two instances apart. */
export function keyText(key: unknown): string {
  return typeof key === "string" ? key : renderWireValue(key);
}

/** An instance's identity within a listing: its context, class and wire key
 *  (two contexts can each have a `Cart` keyed `u1`). */
export function instanceId(ref: { context?: string; class: string; key: unknown }): string {
  return `${ref.context ?? ""}\u0000${ref.class}\u0000${JSON.stringify(ref.key)}`;
}

const MAX_DEPTH = 6;
const MAX_ITEMS = 12;
const MAX_TEXT = 240;

/** Render a wire-form value in Bynk's own terms, as `semanticValues.ts` does
 *  for the debugger: a tagged sum is `Ok(42)`, not `{"tag":"Ok","value":42}`;
 *  a string is double-quoted; a record is `{ a: 1 }`. Total, and bounded so a
 *  large value cannot flood the view. */
export function renderWireValue(value: unknown, depth = 0): string {
  const text = render(value, depth);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function render(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "…";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => render(v, depth + 1));
    if (value.length > MAX_ITEMS) items.push("…");
    return `[${items.join(", ")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (typeof obj.tag === "string") {
    const fields = entries.filter(([k]) => k !== "tag").slice(0, MAX_ITEMS).map(([, v]) => render(v, depth + 1));
    return fields.length > 0 ? `${obj.tag}(${fields.join(", ")})` : obj.tag;
  }
  const parts = entries.slice(0, MAX_ITEMS).map(([k, v]) => `${k}: ${render(v, depth + 1)}`);
  if (entries.length > MAX_ITEMS) parts.push("…");
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
}

/** The state a machine's field holds: the constructor's name for a tagged
 *  value, or the string itself, when it is one of the machine's states. */
export function stateOfCell(value: unknown, states: readonly string[]): string | null {
  const name =
    typeof value === "string" ? value : isObject(value) && typeof value.tag === "string" ? value.tag : undefined;
  return name !== undefined && states.includes(name) ? name : null;
}

/** One step of an instance's history, for the page: the handler, what the
 *  machine's field moved from and to, and the cells that changed. */
export interface HistoryStep {
  handler: string | null;
  at: number;
  /** The machine's state before and after (`null` where unknown or not a state). */
  from: string | null;
  to: string | null;
  /** Cells whose value changed, with before (`undefined` for a first commit) and after, rendered. */
  changes: Array<{ cell: string; before: string | undefined; after: string }>;
  /** Collections whose size changed. */
  sizes: Array<{ field: string; before: number | null | undefined; after: number | null }>;
}

export function historySteps(history: readonly HistoryEntry[], field: string, states: readonly string[]): HistoryStep[] {
  return history.map((e) => {
    const changes: HistoryStep["changes"] = [];
    for (const [cell, after] of Object.entries(e.new.cells)) {
      const before = e.old?.cells[cell];
      const a = renderWireValue(after);
      const b = e.old && cell in e.old.cells ? renderWireValue(before) : undefined;
      if (a !== b) changes.push({ cell, before: b, after: a });
    }
    const sizes: HistoryStep["sizes"] = [];
    for (const [name, after] of Object.entries(e.new.collections)) {
      const before = e.old ? e.old.collections[name] : undefined;
      if (before !== after) sizes.push({ field: name, before, after });
    }
    return {
      handler: e.handler,
      at: e.at,
      from: e.old ? stateOfCell(e.old.cells[field], states) : null,
      to: stateOfCell(e.new.cells[field], states),
      changes,
      sizes,
    };
  });
}

/** Where an instance's schema stands against its class's current version. */
export interface SchemaStanding {
  text: string;
  /** Behind the build: worth a link to the State Migrations view. */
  behind: boolean;
}

export function schemaStanding(
  version: number | null,
  current: number | null,
  migrationPending: boolean,
): SchemaStanding {
  if (version === null) return { text: "schema version unknown", behind: false };
  if (current === null) return { text: `schema v${version} (no schema lock)`, behind: false };
  if (version < current) {
    return {
      text: `schema v${version}, current v${current}${migrationPending ? "; migration pending (shown as stored)" : ""}`,
      behind: true,
    };
  }
  return { text: version === current ? `schema v${version} (current)` : `schema v${version}, current v${current}`, behind: false };
}

/** What the unreadable-record fault means, in words. */
export function faultText(fault: string): string {
  switch (fault) {
    case "NewerLayout":
      return "stored by a newer build (storage layout)";
    case "NewerSchema":
      return "stored by a newer build (schema)";
    case "NoMigrationPath":
      return "no migration path from the stored schema";
    default:
      return fault ? `unreadable (${fault})` : "unreadable";
  }
}

/** Why a `bynk dev inspect` run failed, for the user: the CLI's own message
 *  (it says what to do), without its `bynk: ` prefix. */
export function inspectFailure(stderr: string): string {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.replace(/^bynk:\s*/, "") || "bynk dev inspect failed";
}

/** The instances of `agent` in a listing, as the page is offered them: a
 *  `ref` it can send back, the key in Bynk's terms. Sorted by key text so the
 *  order is stable across refreshes. */
export function liveInstances(listing: AgentListing, agent: string): LiveInstance[] {
  return listing.agents
    .filter((a) => a.class === agent)
    .map((a) => ({ ref: instanceId(a), key: keyText(a.key), context: a.context }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** An inspection as the page shows it: values rendered, the machine states
 *  found, the history reduced to per-field moves. */
export function toInstanceView(
  inspection: AgentInspection,
  machines: ReadonlyArray<{ field: string; states: readonly string[] }>,
): InstanceView {
  if (!inspection.exists) return { exists: false };
  if (!inspection.readable) return { exists: true, readable: false, fault: faultText(inspection.fault) };
  const states: Record<string, string | null> = {};
  for (const m of machines) states[m.field] = stateOfCell(inspection.cells[m.field], m.states);
  const perMachine = machines.map((m) => ({ m, steps: historySteps(inspection.history, m.field, m.states) }));
  return {
    exists: true,
    readable: true,
    schema: schemaStanding(inspection.version, inspection.current, inspection.migrationPending),
    cells: Object.entries(inspection.cells).map(([name, v]) => ({ name, text: renderWireValue(v) })),
    states,
    collections: Object.entries(inspection.collections).map(([name, c]) => ({
      name,
      kind: c.kind,
      size: c.size,
      shown: c.entries.length,
    })),
    history: inspection.history.map((e, i) => {
      const step = historySteps([e], "", [])[0];
      const byField: Record<string, { from: string | null; to: string | null }> = {};
      for (const { m, steps } of perMachine) byField[m.field] = { from: steps[i].from, to: steps[i].to };
      return { handler: e.handler, at: e.at, changes: step.changes, sizes: step.sizes, states: byField };
    }),
  };
}
