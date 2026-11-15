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

import { type ClassStatus, isProductionEnvironment } from "./migrationsCore";
import type { CdService } from "./webview/contractDiffTypes";

/** One Worker the ledger records in an environment. */
export interface WorkerRecord {
  /** The ledger's key: the Worker-directory form of the context (`shop-payment`). */
  worker: string;
  /** Whether a push of it succeeded. */
  deployed: boolean;
  /** Service → contract hash the Worker provides (what is live). `undefined`
   *  when the ledger holds no contract record for it (an older driver's push). */
  contracts: Record<string, string> | undefined;
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

/** A `key = value` line, with a basic- or literal-string or boolean value. */
function keyValue(line: string): { key: string; value: string | boolean } | undefined {
  const m = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
  if (!m) return undefined;
  const key = splitDottedKey(m[1]);
  if (!key || key.length !== 1) return undefined;
  const raw = m[2];
  if (raw === "true") return { key: key[0], value: true };
  if (raw === "false") return { key: key[0], value: false };
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

/** A context's dotted name from the ledger's Worker-directory form. */
export function contextFromWorker(worker: string): string {
  return worker.replace(/-/g, ".");
}

/** Whether a dotted (or Worker-directory) `a` and `b` name one context. */
export function sameContext(a: string, b: string): boolean {
  return contextFromWorker(a) === contextFromWorker(b);
}

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

function buildEnvironment(env: LedgerEnvironment, input: EnvironmentsInput): EnvTreeNode {
  const rows = input.drift?.filter((s) => s.environment === env.name) ?? [];
  const contexts: EnvTreeNode[] = [];
  const seen = new Set<string>();
  for (const w of env.workers) {
    const context = contextFromWorker(w.worker);
    seen.add(context);
    contexts.push(buildContext(env.name, w, rows.filter((r) => sameContext(r.context, context)), input.drift !== null));
  }
  // A context the working tree has, and the environment does not: undeployed.
  const extra = [...new Set(rows.map((r) => contextFromWorker(r.context)).filter((c) => !seen.has(c)))].sort();
  for (const context of extra) {
    contexts.push(
      buildContext(env.name, { worker: context.replace(/\./g, "-"), deployed: false, contracts: undefined }, rows.filter((r) => sameContext(r.context, context)), true),
    );
  }
  const states = contexts.map(contextState);
  const drifted = states.filter((s) => s !== "in-sync").length;
  const breaking = states.filter((s) => s === "breaking").length;

  const warnings =
    input.migrations.kind === "status" ? migrationWarnings(input.migrations.classes, env.name) : [];
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
  return n.data.kind === "context" ? n.data.drift : "in-sync";
}

function buildContext(environment: string, w: WorkerRecord, rows: CdService[], driftKnown: boolean): EnvTreeNode {
  const context = contextFromWorker(w.worker);
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
  for (const env of tree) for (const c of env.children) if (c.data.kind === "context" && contextState(c) !== "in-sync") n++;
  return n;
}
