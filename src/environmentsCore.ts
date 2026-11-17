// The dependency-free core of the Environments view (#150): `bynk.deploy.lock`
// read for what is deployed where, the contract diff's service rows read as
// drift, and `bynk migrate status` read as per-environment migration warnings,
// all folded into one tree model. No `vscode` import, so the unit tests compile
// against it directly (see tsconfig.test.json); `environmentsView.ts` wires it
// to the editor.
//
// Everything here is local: the lock, the offline status report and the
// language server's contract diff. Nothing reaches Cloudflare (ADR 0510;
// `migrationsCore.ts` DECISION C), so live instance counts stay in the sweep's
// own terminal.
//
// The lock's format is the driver's `DeployLock` (bynk v0.614.0,
// `bynk/src/deploy/ledger.rs`): TOML, `version = 1`, then
// `[environments.<env>.workers.<worker>]` with `deployed = true` and a
// `[…contracts]` table of service name → contract hash. The ledger records no
// timestamps, so the view cannot say *when* a Worker was last deployed.
//
// A Worker group (`[deploy.workers.<key>]`, bynk v0.634+) is one ledger Worker
// keyed by the group's key; its record also holds `contexts` (the members as of
// the push) and, when `name` overrides the key, `script`
// (`WorkerRecord` in `bynk/src/deploy/ledger.rs`). The view shows such a Worker
// as one group node holding its member contexts.

import { contextFromWorker, groupByKey, groupHolding, sameContext, workerKey, type WorkerGroup } from "./contextNames";
import { type ClassStatus, contextOf, isProductionEnvironment } from "./migrationsCore";
import type { CdService } from "./webview/contractDiffTypes";

// Re-exported so existing importers of these names are unchanged.
export { contextFromWorker, sameContext, workerKey };

/** One Worker the ledger records in an environment. */
export interface WorkerRecord {
  /** The ledger's key: the Worker-directory form of the context (`shop-payment`). */
  worker: string;
  /** Whether a push of it succeeded. */
  deployed: boolean;
  /** Service → contract hash the Worker provides (what is live). `undefined`
   *  when the ledger holds no contract record for it (an older driver's push). */
  contracts: Record<string, string> | undefined;
  /** A group Worker's members as of the push that recorded it (`contexts`);
   *  absent for a context on its own Worker and for a ledger from before groups. */
  contexts?: string[];
  /** The Cloudflare script name when it is not the key (a group's `name`). */
  script?: string;
}

export interface LedgerEnvironment {
  name: string;
  workers: WorkerRecord[];
}

// ---------------------------------------------------------------------------
// A reader for the TOML subset the ledger uses.

/** Split a TOML dotted key (`a."b.c".d`) into its parts; `undefined` if malformed. */
export function splitDottedKey(text: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  const n = text.length;
  for (;;) {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
    let part = "";
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i++];
      for (; i < n && text[i] !== q; i++) {
        if (q === '"' && text[i] === "\\" && i + 1 < n) i++;
        part += text[i];
      }
      if (i >= n) return undefined;
      i++;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!m) return undefined;
      part = m[0];
      i += part.length;
    }
    parts.push(part);
    while (i < n && (text[i] === " " || text[i] === "\t")) i++;
    if (i >= n) return parts;
    if (text[i] !== ".") return undefined;
    i++;
  }
}

/** A `key = value` line, with a basic- or literal-string, boolean or
 *  string-array value (an array on one line; the driver writes it so). */
function keyValue(line: string): { key: string; value: string | boolean | string[] } | undefined {
  const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
  if (!m) return undefined;
  const key = splitDottedKey(m[1]);
  if (!key || key.length !== 1) return undefined;
  const raw = m[2];
  if (raw === "true") return { key: key[0], value: true };
  if (raw === "false") return { key: key[0], value: false };
  if (raw.startsWith("[")) {
    const list = /^\[(.*)\]/.exec(raw);
    if (!list) return undefined;
    return { key: key[0], value: [...list[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((x) => x[1] ?? x[2]) };
  }
  const s = /^"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (s) return { key: key[0], value: s[1].replace(/\\(.)/g, "$1") };
  const l = /^'([^']*)'/.exec(raw);
  if (l) return { key: key[0], value: l[1] };
  return undefined;
}

/** Parse `bynk.deploy.lock`. Lenient: fields it does not know are ignored, so a
 *  driver that adds to the ledger does not break the view. Throws when the text
 *  has no `version` (the driver treats that as corruption too). */
export function parseDeployLock(text: string): LedgerEnvironment[] {
  if (!/^\s*version\s*=\s*\d+/m.test(text)) throw new Error("not a bynk.deploy.lock (no `version`)");
  const envs = new Map<string, Map<string, WorkerRecord>>();
  let target: { env: string; worker: string; table: "worker" | "contracts" } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*(\[\[?)\s*(.*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header && !/^\s*[A-Za-z0-9_"'-]+\s*=/.test(line)) {
      target = undefined;
      if (header[1] === "[[") continue;
      const key = splitDottedKey(header[2]);
      if (!key || key[0] !== "environments" || key.length < 2) continue;
      const env = key[1];
      if (!envs.has(env)) envs.set(env, new Map());
      if (key.length >= 4 && key[2] === "workers") {
        const workers = envs.get(env) as Map<string, WorkerRecord>;
        const worker = key[3];
        if (!workers.has(worker)) workers.set(worker, { worker, deployed: false, contracts: undefined });
        if (key.length === 4) target = { env, worker, table: "worker" };
        else if (key.length === 5 && key[4] === "contracts") {
          const rec = workers.get(worker) as WorkerRecord;
          rec.contracts ??= {};
          target = { env, worker, table: "contracts" };
        }
      }
      continue;
    }
    if (!target) continue;
    const kv = keyValue(line);
    if (!kv) continue;
    const rec = (envs.get(target.env) as Map<string, WorkerRecord>).get(target.worker) as WorkerRecord;
    if (target.table === "worker" && kv.key === "deployed" && typeof kv.value === "boolean") rec.deployed = kv.value;
    else if (target.table === "worker" && kv.key === "contexts" && Array.isArray(kv.value)) rec.contexts = kv.value.length > 0 ? kv.value : undefined;
    else if (target.table === "worker" && kv.key === "script" && typeof kv.value === "string") rec.script = kv.value;
    else if (target.table === "contracts" && typeof kv.value === "string") (rec.contracts as Record<string, string>)[kv.key] = kv.value;
  }
  return [...envs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, workers]) => ({
      name,
      workers: [...workers.values()].sort((a, b) => a.worker.localeCompare(b.worker)),
    }));
}

// ---------------------------------------------------------------------------
// Names

// ---------------------------------------------------------------------------
// Drift

/** How a context's live contracts stand against the working tree. */
export type DriftState = "in-sync" | "compatible" | "breaking" | "changed" | "added" | "removed";

const SEVERITY: Record<DriftState, number> = {
  "in-sync": 0,
  added: 1,
  compatible: 2,
  removed: 3,
  changed: 4,
  breaking: 5,
};

/** One service row's drift: the compatibility verdict when the ledger and the
 *  build both recorded structure, else the bare hash comparison. */
export function serviceDrift(s: CdService): DriftState {
  if (s.status === "added") return "added";
  if (s.status === "removed") return "removed";
  return s.compat?.verdict ?? "changed";
}

/** The worst of some states (`in-sync` for none). */
export function worstDrift(states: DriftState[]): DriftState {
  return states.reduce<DriftState>((w, s) => (SEVERITY[s] > SEVERITY[w] ? s : w), "in-sync");
}

const DRIFT_LABEL: Record<DriftState, string> = {
  "in-sync": "in sync",
  compatible: "compatible change",
  breaking: "breaking change",
  changed: "contract changed",
  added: "new service",
  removed: "service removed",
};

export function driftLabel(s: DriftState): string {
  return DRIFT_LABEL[s];
}

// ---------------------------------------------------------------------------
// Migrations

/** The classes deployed to `environment` whose stored versions lag the current
 *  one: the floor is below the version (records may still sit at an older
 *  version), or a stored version has no migrate path. */
export function migrationWarnings(classes: ClassStatus[], environment: string): ClassStatus[] {
  return classes
    .filter((c) => c.deployedTo.includes(environment) && (c.floor < c.version || c.withoutPath.length > 0))
    .sort((a, b) => a.class.localeCompare(b.class));
}

/** One line for a warning. */
export function migrationWarningText(c: ClassStatus): string {
  const parts = [`v${c.version}, floor ${c.floor}`];
  if (c.floor < c.version) parts.push(`records may be as old as v${c.floor}`);
  if (c.withoutPath.length > 0) parts.push(`no path from ${c.withoutPath.map((v) => `v${v}`).join(", ")}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// The tree

/** What a node stands for, for the wrapper's commands. */
export type EnvNodeData =
  | { kind: "environment"; environment: string }
  | { kind: "context"; environment: string; context: string; drift: DriftState }
  /** A Worker group: one Worker holding `contexts`; deployed, reverted and tailed as a unit. */
  | { kind: "workerGroup"; environment: string; worker: string; contexts: string[]; drift: DriftState }
  | { kind: "migrations"; environment: string }
  | { kind: "migrationClass"; environment: string; class: string }
  | { kind: "service" | "message" };

export interface EnvTreeNode {
  /** Stable within a tree (relative to the project), for expansion state. */
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon name. */
  icon: string;
  /** The `contextValue` the view's menus match. */
  contextValue: string;
  data: EnvNodeData;
  children: EnvTreeNode[];
}

/** What the tree is built from. */
export interface EnvironmentsInput {
  /** `bynk.deploy.lock`'s text; `undefined` when there is none. */
  lock: string | undefined;
  /** The contract diff's service rows; `null` when it could not be fetched
   *  (no language server yet, or no committed analysis), in which case drift
   *  is left out rather than guessed. */
  drift: CdService[] | null;
  /** The project's `[deploy.workers.<key>]` groups, read from `bynk.toml`;
   *  absent or empty for a project with none (every context is its own Worker). */
  groups?: WorkerGroup[];
  /** `bynk migrate status`, or why it is not available. */
  migrations: { kind: "status"; classes: ClassStatus[] } | { kind: "unavailable"; detail: string };
}

const message = (id: string, label: string, icon = "info"): EnvTreeNode => ({
  id,
  label,
  icon,
  contextValue: "bynkEnvMessage",
  data: { kind: "message" },
  children: [],
});

/** Build the tree: one node per environment the lock records. Returns a single
 *  message node when there is nothing to show. */
export function buildEnvironmentsTree(input: EnvironmentsInput): EnvTreeNode[] {
  if (input.lock === undefined) {
    return [message("none", "No bynk.deploy.lock: nothing is recorded as deployed yet")];
  }
  let envs: LedgerEnvironment[];
  try {
    envs = parseDeployLock(input.lock);
  } catch {
    return [message("unreadable", "bynk.deploy.lock could not be read", "warning")];
  }
  if (envs.length === 0) return [message("empty", "bynk.deploy.lock records no environment yet")];
  return envs.map((env) => buildEnvironment(env, input));
}

/** The manifest's groups, then a group the ledger recorded for a Worker the
 *  manifest no longer (or not yet) names: its members as of the last push. */
function effectiveGroups(manifest: readonly WorkerGroup[], workers: readonly WorkerRecord[]): WorkerGroup[] {
  const out = [...manifest];
  for (const w of workers) {
    if (w.contexts && w.contexts.length > 0 && !out.some((g) => g.key === w.worker)) {
      out.push({ key: w.worker, contexts: w.contexts, ...(w.script && w.script !== w.worker ? { name: w.script } : {}) });
    }
  }
  return out;
}

/** `bynk migrate status` says where a class is deployed by the Worker named
 *  for its context (`bynk/src/migrate.rs` `worker_of`), which is not a group's
 *  Worker: a class in a group member reads as deployed nowhere. The ledger knows
 *  better, so a class whose member's group Worker is deployed here is too.
 *  A workaround for bynk-lang/bynk#3686; drop it when the driver reports groups. */
function groupedDeployments(classes: ClassStatus[], env: LedgerEnvironment, groups: readonly WorkerGroup[]): ClassStatus[] {
  if (groups.length === 0) return classes;
  return classes.map((c) => {
    const group = groupHolding(contextOf(c.class), groups);
    const live = group && env.workers.some((w) => w.worker === group.key && w.deployed);
    return live && !c.deployedTo.includes(env.name) ? { ...c, deployedTo: [...c.deployedTo, env.name] } : c;
  });
}

function buildEnvironment(env: LedgerEnvironment, input: EnvironmentsInput): EnvTreeNode {
  const rows = input.drift?.filter((s) => s.environment === env.name) ?? [];
  const groups = effectiveGroups(input.groups ?? [], env.workers);
  const driftKnown = input.drift !== null;
  const contexts: EnvTreeNode[] = [];
  const seen = new Set<string>();
  for (const w of env.workers) {
    seen.add(w.worker);
    const group = groupByKey(w.worker, groups);
    const mine = rows.filter((r) => workerKey(r.context, groups) === w.worker);
    contexts.push(group ? buildGroup(env.name, w, group, mine, driftKnown) : buildContext(env.name, w, mine, driftKnown));
  }
  // A context (or group) the working tree has, and the environment does not: undeployed.
  const extra = [...new Set(rows.map((r) => workerKey(r.context, groups)).filter((k) => !seen.has(k)))].sort();
  for (const worker of extra) {
    const mine = rows.filter((r) => workerKey(r.context, groups) === worker);
    const group = groupByKey(worker, groups);
    const record: WorkerRecord = { worker, deployed: false, contracts: undefined };
    contexts.push(
      group
        ? buildGroup(env.name, record, group, mine, true)
        : buildContext(env.name, record, mine, true, mine[0].context),
    );
  }
  const states = contexts.map(contextState);
  const drifted = states.filter((s) => s !== "in-sync").length;
  const breaking = states.filter((s) => s === "breaking").length;

  const warnings =
    input.migrations.kind === "status" ? migrationWarnings(groupedDeployments(input.migrations.classes, env, groups), env.name) : [];
  const children = [...contexts];
  if (input.migrations.kind === "status") {
    children.push({
      id: `${env.name}/migrations`,
      label: "Migrations",
      description: warnings.length === 0 ? "up to date" : `${warnings.length} class${warnings.length === 1 ? "" : "es"} below current`,
      icon: warnings.length === 0 ? "versions" : "warning",
      contextValue: "bynkEnvMigrations",
      data: { kind: "migrations", environment: env.name },
      children: warnings.map((c) => ({
        id: `${env.name}/migrations/${c.class}`,
        label: c.class,
        description: migrationWarningText(c),
        icon: c.withoutPath.length > 0 ? "warning" : "symbol-class",
        contextValue: "bynkEnvMigrationClass",
        data: { kind: "migrationClass", environment: env.name, class: c.class },
        children: [],
      })),
    });
  } else {
    children.push(message(`${env.name}/migrations-unavailable`, `Migrations: ${input.migrations.detail || "bynk migrate status is unavailable"}`, "warning"));
  }

  const parts = [`${env.workers.length} Worker${env.workers.length === 1 ? "" : "s"}`];
  if (input.drift === null) parts.push("drift unknown");
  else if (breaking > 0) parts.push(`${breaking} breaking`);
  else if (drifted > 0) parts.push(`${drifted} drifted`);
  else parts.push("in sync");
  return {
    id: env.name,
    label: env.name,
    description: parts.join(" · "),
    tooltip: `${env.name}${isProductionEnvironment(env.name) ? " (reads as production)" : ""}\nFrom bynk.deploy.lock; drift is the working tree against what it records as live.`,
    icon: isProductionEnvironment(env.name) ? "cloud" : "server-environment",
    contextValue: "bynkEnvironment",
    data: { kind: "environment", environment: env.name },
    children,
  };
}

function contextState(n: EnvTreeNode): DriftState {
  return n.data.kind === "context" || n.data.kind === "workerGroup" ? n.data.drift : "in-sync";
}

/** A Worker group's node: one Worker, its member contexts beneath it. The
 *  ledger holds one contract table for the whole Worker, so each member shows
 *  the services the working tree attributes to it, and any live service no
 *  member's row names stays on the group. */
function buildGroup(environment: string, w: WorkerRecord, group: WorkerGroup, rows: CdService[], driftKnown: boolean): EnvTreeNode {
  const live = w.contracts;
  const claimed = new Set<string>();
  const members: EnvTreeNode[] = [];
  // The ledger's members (as of the push) and the manifest's: both are shown.
  const recorded = w.contexts ?? [];
  const names = [...new Set([...group.contexts, ...recorded])];
  for (const member of names) {
    const mine = rows.filter((r) => sameContext(r.context, member));
    const own = live === undefined ? undefined : Object.fromEntries(Object.entries(live).filter(([svc]) => mine.some((r) => r.service === svc)));
    for (const svc of Object.keys(own ?? {})) claimed.add(svc);
    // A member the Worker was not last pushed with joins it at the next deploy.
    const inWorker = w.deployed && (recorded.length === 0 || recorded.some((c) => sameContext(c, member)));
    members.push(buildContext(environment, { worker: w.worker, deployed: inWorker, contracts: own }, mine, driftKnown, member));
  }
  const states = members.map(contextState);
  const state = worstDrift(states);
  const leftover: EnvTreeNode[] = Object.entries(live ?? {})
    .filter(([svc]) => !claimed.has(svc))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([svc, hash]) => serviceNode(environment, group.key, svc, hash, undefined, undefined));
  const script = group.name && group.name !== group.key ? group.name : w.script && w.script !== w.worker ? w.script : undefined;
  const bits = [`Worker group · ${names.length} context${names.length === 1 ? "" : "s"}`];
  if (!w.deployed) bits.push("not deployed");
  else if (live === undefined) bits.push("deployed · no contract record");
  else bits.push("deployed");
  if (driftKnown) bits.push(driftLabel(state));
  return {
    id: `${environment}/${group.key}`,
    label: group.key,
    description: bits.join(" · "),
    tooltip: [
      `Worker group ${group.key} in ${environment}${script ? ` (script ${script})` : ""}`,
      `Members: ${names.join(", ")}`,
      "A group is one Worker: it deploys, reverts and is tailed as a unit (bynk deploy --worker " + group.key + ").",
    ].join("\n"),
    icon: !w.deployed ? "circle-slash" : state === "breaking" ? "error" : state === "in-sync" || !driftKnown ? "layers" : "warning",
    contextValue: "bynkEnvWorker",
    data: { kind: "workerGroup", environment, worker: group.key, contexts: names, drift: driftKnown ? state : "in-sync" },
    children: [...members, ...leftover],
  };
}

function buildContext(
  environment: string,
  w: WorkerRecord,
  rows: CdService[],
  driftKnown: boolean,
  dotted?: string,
): EnvTreeNode {
  const context = dotted ?? rows[0]?.context ?? contextFromWorker(w.worker);
  const state = worstDrift(rows.map(serviceDrift));
  const byService = new Map(rows.map((r) => [r.service, r]));
  const services: EnvTreeNode[] = [];
  for (const [service, hash] of Object.entries(w.contracts ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const row = byService.get(service);
    byService.delete(service);
    const d = row ? serviceDrift(row) : "in-sync";
    services.push(serviceNode(environment, context, service, hash, driftKnown ? d : undefined, row));
  }
  // Rows the ledger does not hold a hash for: new services, or ones whose live
  // record is absent.
  for (const row of [...byService.values()].sort((a, b) => a.service.localeCompare(b.service))) {
    services.push(serviceNode(environment, context, row.service, row.live ?? undefined, serviceDrift(row), row));
  }
  const bits: string[] = [];
  if (!w.deployed) bits.push("not deployed");
  else if (w.contracts === undefined) bits.push("deployed · no contract record");
  else bits.push("deployed");
  if (driftKnown) bits.push(driftLabel(state));
  const node: EnvTreeNode = {
    id: `${environment}/${context}`,
    label: context,
    description: bits.join(" · "),
    tooltip: `${context} (Worker ${w.worker}) in ${environment}`,
    icon: !w.deployed ? "circle-slash" : state === "breaking" ? "error" : state === "in-sync" || !driftKnown ? "pass" : "warning",
    contextValue: "bynkEnvContext",
    data: { kind: "context", environment, context, drift: driftKnown ? state : "in-sync" },
    children: services,
  };
  return node;
}

function serviceNode(
  environment: string,
  context: string,
  service: string,
  hash: string | undefined,
  drift: DriftState | undefined,
  row: CdService | undefined,
): EnvTreeNode {
  const bits: string[] = [];
  if (hash) bits.push(hash);
  if (drift !== undefined && drift !== "in-sync") bits.push(driftLabel(drift));
  const reasons = row?.compat?.reasons ?? [];
  return {
    id: `${environment}/${context}/${service}`,
    label: service,
    description: bits.join(" · "),
    tooltip: [
      hash ? `Live contract hash ${hash}` : "No live contract recorded",
      row?.current && row.current !== hash ? `Working tree ${row.current}` : undefined,
      ...reasons,
    ]
      .filter((x): x is string => !!x)
      .join("\n"),
    icon: drift === "breaking" ? "error" : drift === undefined || drift === "in-sync" ? "symbol-interface" : "warning",
    contextValue: "bynkEnvService",
    data: { kind: "service" },
    children: [],
  };
}

/** The environment's context nodes whose drift is not `in-sync`, as a count
 *  (used by the view's badge and tests). */
export function driftedContexts(tree: EnvTreeNode[]): number {
  let n = 0;
  const count = (c: EnvTreeNode): void => {
    if (c.data.kind === "context" && contextState(c) !== "in-sync") n++;
    else if (c.data.kind === "workerGroup") c.children.forEach(count);
  };
  for (const env of tree) env.children.forEach(count);
  return n;
}
