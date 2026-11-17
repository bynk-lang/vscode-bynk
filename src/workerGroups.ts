// A reader for the `[deploy.workers.<key>]` groups of `bynk.toml` (Bynk
// v0.634+). No `vscode` import and no imports of host code, so the unit tests
// compile against it directly.
//
// The format is the driver's (`bynk-project/src/worker_groups.rs` at v0.639.1):
//
//   [deploy.workers.core]
//   contexts = ["shop.orders", "shop.catalogue"]
//   name = "acme-core"          # the Cloudflare script name; default is the key
//
// The reader is lenient, as this extension's other manifest readers are: it
// takes what it understands (the table form, dotted keys under
// `[deploy.workers]`, and inline tables), skips the rest, and leaves validation
// (a context in two groups, a bad name) to the driver and the manifest schema.

import { groupByKey, groupHolding, type WorkerGroup } from "./contextNames";

export type { WorkerGroup };

/** Drop a trailing `# comment`, leaving a `#` inside a string alone. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Split a TOML key (`a."b.c".d`) into its parts; `undefined` if malformed. */
function keyParts(text: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    while (text[i] === " " || text[i] === "\t") i++;
    let part = "";
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i++];
      while (i < text.length && text[i] !== q) {
        if (q === '"' && text[i] === "\\" && i + 1 < text.length) i++;
        part += text[i++];
      }
      if (i >= text.length) return undefined;
      i++;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
      if (!m) return undefined;
      part = m[0];
      i += part.length;
    }
    parts.push(part);
    while (text[i] === " " || text[i] === "\t") i++;
    if (i >= text.length) return parts;
    if (text[i] !== ".") return undefined;
    i++;
  }
}

/** The strings of a `["a", 'b']` array body. */
function strings(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

function oneString(text: string): string | undefined {
  const s = strings(text);
  return s.length === 1 ? s[0] : undefined;
}

type Draft = { contexts: string[]; name?: string };

/** Read `bynk.toml`'s `[deploy.workers.<key>]` groups, in the manifest's order.
 *  A group with no `contexts` is dropped (the driver rejects it). */
export function parseWorkerGroups(text: string): WorkerGroup[] {
  const drafts = new Map<string, Draft>();
  const draft = (key: string): Draft => {
    let d = drafts.get(key);
    if (!d) drafts.set(key, (d = { contexts: [] }));
    return d;
  };
  /** Where bare `key = value` lines land: `[deploy.workers.<key>]` (a group),
   *  `[deploy.workers]` or `[deploy]` (a path to one) or nowhere. */
  let prefix: string[] | undefined;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (line === "") continue;
    const header = /^\[\s*([^[\]]*?)\s*\]$/.exec(line);
    if (header) {
      const path = keyParts(header[1]);
      prefix = path && path[0] === "deploy" ? path : undefined;
      if (prefix && prefix[1] === "workers" && prefix.length >= 3) draft(prefix[2]);
      continue;
    }
    if (line.startsWith("[[") || !prefix) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = keyParts(line.slice(0, eq));
    let rest = line.slice(eq + 1).trim();
    // A multi-line array or inline table: take lines until it closes.
    const open = rest[0];
    const close = open === "[" ? "]" : open === "{" ? "}" : undefined;
    if (close) {
      while (!rest.includes(close) && i + 1 < lines.length) rest += " " + stripComment(lines[++i]).trim();
    }
    if (!key) continue;
    const full = [...prefix, ...key];
    // Under `[deploy]`: `workers.core.contexts`, `workers.core = {…}`; under
    // `[deploy.workers]`: `core.contexts`; under a group: `contexts`.
    const at = full[0] === "deploy" && full[1] === "workers" ? full.slice(2) : undefined;
    if (!at || at.length === 0) continue;
    if (at.length === 1 && rest.startsWith("{")) {
      const d = draft(at[0]);
      const ctx = /\bcontexts\s*=\s*\[([^\]]*)\]/.exec(rest);
      if (ctx) d.contexts = strings(ctx[1]);
      const name = /\bname\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/.exec(rest);
      if (name) d.name = oneString(name[1]);
      continue;
    }
    if (at.length !== 2) continue;
    const d = draft(at[0]);
    if (at[1] === "contexts") d.contexts = strings(rest);
    else if (at[1] === "name") d.name = oneString(rest);
  }
  return [...drafts.entries()]
    .filter(([, d]) => d.contexts.length > 0)
    .map(([key, d]) => ({ key, contexts: d.contexts, ...(d.name ? { name: d.name } : {}) }));
}

/** The Cloudflare script name a group's Worker has: its `name`, else its key. */
export function scriptName(group: WorkerGroup): string {
  return group.name ?? group.key;
}

/** One thing a deploy, revert or tail can be scoped to: a context on its own
 *  Worker, or a whole group (a member cannot be deployed alone, so the group is
 *  the choice: `bynk/src/deploy/plan.rs` `select_workers`). */
export interface WorkerScope {
  kind: "context" | "worker";
  /** The context (dotted), or the group's key. */
  value: string;
  label: string;
  /** What the choice covers, for a picker. */
  description: string;
}

/** The scopes to offer for a project: each group once, then each context no
 *  group holds, sorted by label. */
export function workerScopes(contexts: readonly string[], groups: readonly WorkerGroup[]): WorkerScope[] {
  const out: WorkerScope[] = groups.map((g) => ({
    kind: "worker",
    value: g.key,
    label: g.key,
    description: `Worker group: ${g.contexts.join(", ")}${g.name && g.name !== g.key ? ` (script ${g.name})` : ""}`,
  }));
  for (const c of contexts) {
    if (!groupHolding(c, groups)) out.push({ kind: "context", value: c, label: c, description: "" });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** What `--context NAME` should become for `name`: a member of a group is
 *  refused by `deploy` and `revert` ("is in Worker `core`, which deploys as a
 *  unit: use `--worker core`"), so it becomes its group's Worker. */
export function resolveScope(
  name: string,
  groups: readonly WorkerGroup[],
): { kind: "context"; context: string } | { kind: "worker"; worker: string; group: WorkerGroup; member: boolean } {
  const byKey = groupByKey(name, groups);
  if (byKey) return { kind: "worker", worker: byKey.key, group: byKey, member: false };
  const held = groupHolding(name, groups);
  if (held) return { kind: "worker", worker: held.key, group: held, member: true };
  return { kind: "context", context: name };
}
