// #147: the dependency-free core of "Bynk: Compare Model with…". Two halves,
// neither importing `vscode`, so the unit tests compile against them directly:
//
//   - the git side — which ref to offer first (the merge base with the default
//     branch), how to list refs, and how to check a revision out into a scratch
//     `git worktree` for the length of a callback. Git is reached through the
//     injected `Git` interface, so the tests mock it.
//   - the model side — diffing two snapshots of a project's model (the
//     architecture model, the contract diff and each agent's state model, all
//     fetched with the same language-server requests the live views use) into
//     added / removed / changed entries.

import type { ArchLoc, ArchModel } from "./webview/architectureTypes";
import type { CdModel } from "./webview/contractDiffTypes";
import type { AgentStateModel } from "./webview/stateTypes";

// ---------------------------------------------------------------- git side

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `git <args>` in `cwd`. A non-zero exit resolves; only a failure to start
 *  rejects. */
export interface Git {
  run(args: string[], cwd: string): Promise<GitResult>;
}

/** A ref the person can pick, or the default merge-base entry. */
export interface RefChoice {
  /** What `git` resolves: a ref name or a commit id. */
  rev: string;
  label: string;
  description?: string;
  detail?: string;
}

/** `git for-each-ref` over branches, remote branches and tags, newest first. */
export const LIST_REFS_ARGS = [
  "for-each-ref",
  "--sort=-committerdate",
  "--format=%(refname:short)%09%(objectname:short)%09%(subject)",
  "refs/heads",
  "refs/remotes",
  "refs/tags",
];

/** Parse `LIST_REFS_ARGS` output. A remote's `HEAD` pointer is a duplicate of
 *  the branch it names, so it is dropped. */
export function parseRefs(stdout: string): RefChoice[] {
  const out: RefChoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [name, sha, ...subject] = line.split("\t");
    if (!name || !sha || /(^|\/)HEAD$/.test(name)) continue;
    out.push({ rev: name, label: name, description: sha, detail: subject.join("\t") || undefined });
  }
  return out;
}

/** The first line of stdout, trimmed, when the run succeeded. */
function ok(r: GitResult): string | undefined {
  if (r.code !== 0) return undefined;
  const line = r.stdout.split(/\r?\n/)[0]?.trim();
  return line ? line : undefined;
}

/** The repository's top-level directory for `dir`, or `undefined` outside one. */
export async function repoRoot(git: Git, dir: string): Promise<string | undefined> {
  return ok(await git.run(["rev-parse", "--show-toplevel"], dir));
}

/** The default branch to compare against: `origin/HEAD`'s target when the
 *  remote has one, else the first of `main`, `master` that exists. */
export async function defaultBranch(git: Git, repo: string): Promise<string | undefined> {
  const head = ok(await git.run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo));
  if (head) return head;
  for (const candidate of ["main", "master"]) {
    if (ok(await git.run(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], repo))) {
      return candidate;
    }
  }
  return undefined;
}

/** The default pick: the merge base of `HEAD` and the default branch, which is
 *  what a pull request changes. `undefined` when there is no default branch or
 *  no common ancestor. */
export async function mergeBaseChoice(git: Git, repo: string): Promise<RefChoice | undefined> {
  const branch = await defaultBranch(git, repo);
  if (!branch) return undefined;
  const sha = ok(await git.run(["merge-base", "HEAD", branch], repo));
  if (!sha) return undefined;
  return {
    rev: sha,
    label: `Merge base with ${branch}`,
    description: sha.slice(0, 8),
    detail: "What a pull request into this branch changes",
  };
}

/** `ref` resolved to a commit id, or `undefined` when it names nothing. */
export async function resolveRev(git: Git, repo: string, ref: string): Promise<string | undefined> {
  return ok(await git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo));
}

/** `bynk.toml`'s directory as a path relative to the repository root
 *  (`""` when the project is the repository). Forward slashes; `undefined` when
 *  the project is not inside the repository. */
export function projectSubpath(repo: string, project: string): string | undefined {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(repo);
  const p = norm(project);
  if (p === r) return "";
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : undefined;
}

/** The name every scratch checkout's directory starts with. The language server
 *  publishes diagnostics for the files of a project it analyses, and for this
 *  one it is the checkout's, so the client drops anything under such a
 *  directory (`isModelDiffScratch`) rather than let it reach the Problems panel
 *  and what reads it. */
export const SCRATCH_PREFIX = "bynk-model-diff-";

/** Whether `path` (a file path or a URI's path) lies under a scratch checkout. */
export function isModelDiffScratch(path: string): boolean {
  return path.replace(/\\/g, "/").split("/").some((seg) => seg.startsWith(SCRATCH_PREFIX));
}

/** What a revision's tree makes available to analyse. */
export interface RevisionTree {
  /** The directory the project lives in, inside the scratch checkout. */
  projectDir: string;
}

/** Check `rev` out into the scratch directory `dir` with a detached
 *  `git worktree`, run `use` against the project's directory inside it, and
 *  remove the worktree again whatever happens. Rejects with a message fit to
 *  show when the checkout fails, or when the project has no `bynk.toml` at that
 *  revision (a project the revision predates). */
export async function withRevisionTree<T>(
  git: Git,
  repo: string,
  subpath: string,
  rev: string,
  dir: string,
  exists: (path: string) => Promise<boolean>,
  use: (tree: RevisionTree) => Promise<T>,
): Promise<T> {
  const added = await git.run(["worktree", "add", "--detach", "--force", dir, rev], repo);
  try {
    if (added.code !== 0) {
      throw new Error(`git could not check out ${rev}: ${added.stderr.trim() || `exit ${added.code}`}`);
    }
    const projectDir = subpath === "" ? dir : `${dir}/${subpath}`;
    if (!(await exists(`${projectDir}/bynk.toml`))) {
      throw new Error(`There is no Bynk project at ${subpath === "" ? "the repository root" : subpath} in ${rev}.`);
    }
    return await use({ projectDir });
  } finally {
    await git.run(["worktree", "remove", "--force", dir], repo).catch(() => undefined);
    await git.run(["worktree", "prune"], repo).catch(() => undefined);
  }
}

/** Retry `attempt` until it yields a non-null answer, up to `tries` times with
 *  `wait` between: the language server analyses a freshly opened tree
 *  asynchronously, so the first request can find no committed analysis yet. */
export async function untilAnswered<T>(
  attempt: () => Promise<T | null>,
  tries: number,
  wait: () => Promise<void>,
): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const r = await attempt();
    if (r !== null) return r;
    if (i < tries - 1) await wait();
  }
  return null;
}

// -------------------------------------------------------------- model side

/** Everything the diff reads from one revision of a project. */
export interface ModelSnapshot {
  architecture: ArchModel | null;
  contracts: CdModel | null;
  /** Each agent's state model, keyed by `agentKey`. */
  agents: Record<string, AgentStateModel>;
}

export type ChangeKind = "added" | "removed" | "changed";

export interface DiffEntry {
  change: ChangeKind;
  /** What kind of element: `context`, `edge`, `capability`, `agent`, … */
  element: string;
  name: string;
  /** What differs, for a `changed` entry (and context for the others). */
  detail?: string;
  /** `breaking` / `compatible` where the model classifies the change. */
  verdict?: "breaking" | "compatible";
  /** The working-tree source of an added or changed element; `null` for a
   *  removed one, which no longer exists there. */
  loc: ArchLoc | null;
}

export type SectionId = "architecture" | "contracts" | "agents" | "capabilities";

export interface DiffSection {
  id: SectionId;
  title: string;
  entries: DiffEntry[];
  /** Why the section could not be compared, when it could not. */
  unavailable?: string;
  /** A caveat on how to read the entries. */
  note?: string;
}

/** What the contracts section's boundary entries mean: each revision's
 *  `bynk/contractDiff` is taken against *that revision's own* locks, so the
 *  entries are not a pure source diff. */
export const CONTRACTS_NOTE =
  "Each revision is compared with its own lock files (bynk.schema.lock, bynk.deploy.lock), then the two results are compared. A boundary change that appears or disappears may come from a lock change between the revisions as well as from source. Service contract hashes are compared directly.";

export interface ModelDiff {
  sections: DiffSection[];
}

/** The key an agent is known by across revisions. */
export function agentKey(context: string, agent: string): string {
  return `${context}.${agent}`;
}

/** Entries are keyed, so two lists diff by key: present only in `after` is
 *  added, only in `before` is removed, in both and unequal is changed. */
function diffKeyed<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
  make: (change: ChangeKind, key: string, b: T | undefined, a: T | undefined) => DiffEntry,
  differs: (b: T, a: T) => boolean,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const [key, a] of after) {
    const b = before.get(key);
    if (b === undefined) out.push(make("added", key, undefined, a));
    else if (differs(b, a)) out.push(make("changed", key, b, a));
  }
  for (const [key, b] of before) {
    if (!after.has(key)) out.push(make("removed", key, b, undefined));
  }
  return out;
}

const byKey = <T>(items: readonly T[], key: (t: T) => string): Map<string, T> =>
  new Map(items.map((i) => [key(i), i]));

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

function setDelta(before: readonly string[], after: readonly string[]): string {
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  return [
    ...added.map((x) => `+${x}`),
    ...removed.map((x) => `−${x}`),
  ].join(", ");
}

/** Contexts and adapters, `consumes` edges, services and agents. */
export function diffArchitecture(before: ArchModel, after: ArchModel): DiffEntry[] {
  const out: DiffEntry[] = [];
  const bn = byKey(before.nodes, (n) => n.name);
  const an = byKey(after.nodes, (n) => n.name);
  out.push(
    ...diffKeyed(
      bn,
      an,
      (change, key, b, a) => ({
        change,
        element: (a ?? b)!.kind.toLowerCase(),
        name: key,
        detail:
          change === "changed" && b!.kind !== a!.kind ? `${b!.kind} → ${a!.kind}` : undefined,
        loc: a?.loc ?? null,
      }),
      (b, a) => b.kind !== a.kind,
    ),
  );
  for (const [name, a] of an) {
    const b = bn.get(name);
    if (!b) continue;
    for (const [element, bs, as] of [
      ["service", b.services, a.services],
      ["agent", b.agents, a.agents],
    ] as const) {
      out.push(
        ...diffKeyed(
          byKey(bs, (s) => s.name),
          byKey(as, (s) => s.name),
          (change, key, sb, sa) => ({
            change,
            element,
            name: `${name}.${key}`,
            detail:
              change === "changed" ? `${sb!.handlerCount} → ${sa!.handlerCount} handlers` : undefined,
            loc: sa?.loc ?? null,
          }),
          (sb, sa) => sb.handlerCount !== sa.handlerCount,
        ),
      );
    }
  }
  out.push(
    ...diffKeyed(
      byKey(before.edges, (e) => `${e.from} → ${e.to}`),
      byKey(after.edges, (e) => `${e.from} → ${e.to}`),
      (change, key, b, a) => ({
        change,
        element: "consumes",
        name: key,
        detail: change === "changed" ? `selection ${setDelta(b!.capabilities, a!.capabilities)}` : undefined,
        loc: a?.loc ?? null,
      }),
      (b, a) => !same(b.capabilities, a.capabilities),
    ),
  );
  return out;
}

/** Capabilities a context consumes or declares, and which provider binds each. */
export function diffCapabilities(before: ArchModel, after: ArchModel): DiffEntry[] {
  const out: DiffEntry[] = [];
  const bn = byKey(before.nodes, (n) => n.name);
  for (const a of after.nodes) {
    const b = bn.get(a.name);
    // A wholly new (or removed) context is reported by the architecture
    // section; this one compares what a surviving context uses.
    if (!b) continue;
    out.push(
      ...diffKeyed(
        byKey(b.capabilities, (c) => c.name),
        byKey(a.capabilities, (c) => c.name),
        (change, key, cb, ca) => ({
          change,
          element: "capability",
          name: `${a.name}: ${key}`,
          detail:
            change === "changed"
              ? `${cb!.local ? "declared" : `from ${cb!.from}`} → ${ca!.local ? "declared" : `from ${ca!.from}`}`
              : undefined,
          loc: ca?.loc ?? null,
        }),
        (cb, ca) => cb.local !== ca.local || cb.from !== ca.from,
      ),
      ...diffKeyed(
        byKey(b.providers, (p) => p.capability),
        byKey(a.providers, (p) => p.capability),
        (change, key, pb, pa) => ({
          change,
          element: "provider",
          name: `${a.name}: ${key}`,
          detail: change === "changed" ? `${pb!.providerName} → ${pa!.providerName}` : undefined,
          loc: pa?.loc ?? null,
        }),
        (pb, pa) => pb.providerName !== pa.providerName || pb.external !== pa.external,
      ),
    );
  }
  return out;
}

/** The contract diff of each revision against its own locks, compared:
 *  boundary changes that appear, disappear or are reclassified, and service
 *  contracts whose current hash differs between the two revisions. */
export function diffContracts(before: CdModel, after: CdModel): DiffEntry[] {
  const out: DiffEntry[] = [];
  out.push(
    ...diffKeyed(
      byKey(before.changes, (c) => `${c.kind} ${c.unit}.${c.name}`),
      byKey(after.changes, (c) => `${c.kind} ${c.unit}.${c.name}`),
      (change, key, b, a) => ({
        change,
        element: (a ?? b)!.kind,
        name: key.slice(key.indexOf(" ") + 1),
        detail: (a ?? b)!.detail,
        verdict: (a ?? b)!.class,
        loc: a?.loc ?? null,
      }),
      (b, a) => b.class !== a.class || b.detail !== a.detail,
    ),
  );
  const sk = (s: CdModel["services"][number]) => `${s.environment}/${s.context}.${s.service}`;
  out.push(
    ...diffKeyed(
      byKey(before.services, sk),
      byKey(after.services, sk),
      (change, key, b, a) => ({
        change,
        element: "service contract",
        name: key,
        detail:
          a?.compat?.reasons[0] ??
          (change === "changed" ? "the contract's hash differs between the two revisions" : undefined),
        verdict: a?.compat?.verdict,
        loc: a?.loc ?? null,
      }),
      (b, a) => b.current !== a.current || b.status !== a.status,
    ),
  );
  return out;
}

const targetLabel = (t: AgentStateModel["machines"][number]["edges"][number]["to"]): string =>
  t.kind === "State" ? t.state : t.kind === "Unchanged" ? "(unchanged)" : "(unknown)";

/** One agent's state machines: states, initial state, handlers and transitions. */
export function diffAgentModel(
  key: string,
  before: AgentStateModel,
  after: AgentStateModel,
  loc: ArchLoc | null,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const entry = (change: ChangeKind, element: string, name: string, detail?: string): DiffEntry => ({
    change,
    element,
    name: `${key}: ${name}`,
    detail,
    loc,
  });
  out.push(
    ...diffKeyed(
      byKey(before.handlers, (h) => h.name),
      byKey(after.handlers, (h) => h.name),
      (change, name) => entry(change, "handler", name),
      () => false,
    ),
  );
  const bm = byKey(before.machines, (m) => m.field);
  const am = byKey(after.machines, (m) => m.field);
  out.push(
    ...diffKeyed(
      bm,
      am,
      (change, field, b, a) => {
        if (change !== "changed") return entry(change, "state machine", field);
        const parts: string[] = [];
        const states = setDelta(b!.states, a!.states);
        if (states) parts.push(`states ${states}`);
        if (b!.initial !== a!.initial) parts.push(`initial ${b!.initial ?? "none"} → ${a!.initial ?? "none"}`);
        return entry("changed", "state machine", field, parts.join("; ") || undefined);
      },
      (b, a) => !same(b.states, a.states) || b.initial !== a.initial,
    ),
  );
  for (const [field, a] of am) {
    const b = bm.get(field);
    if (!b) continue;
    const ek = (e: (typeof a.edges)[number]) =>
      `${e.handler}: ${[...e.from].sort().join("|") || "*"} → ${targetLabel(e.to)}${e.guards.length ? ` when ${e.guards.join(" and ")}` : ""}`;
    out.push(
      ...diffKeyed(
        byKey(b.edges, ek),
        byKey(a.edges, ek),
        (change, name) => entry(change, "transition", `${field}: ${name}`),
        () => false,
      ),
    );
  }
  return out;
}

/** Diff two snapshots. A section whose model either revision could not supply
 *  is marked unavailable rather than reported as unchanged. */
export function diffSnapshots(before: ModelSnapshot, after: ModelSnapshot): ModelDiff {
  const section = (
    id: SectionId,
    title: string,
    ready: boolean,
    reason: string,
    entries: () => DiffEntry[],
  ): DiffSection => (ready ? { id, title, entries: entries() } : { id, title, entries: [], unavailable: reason });
  const arch = !!before.architecture && !!after.architecture;
  const archReason = "the architecture model of one of the revisions could not be read";
  const contracts = section(
    "contracts",
    "Contracts",
    !!before.contracts && !!after.contracts,
    "the contract diff of one of the revisions could not be read",
    () => diffContracts(before.contracts!, after.contracts!),
  );
  contracts.note = CONTRACTS_NOTE;
  return {
    sections: [
      section("architecture", "Architecture", arch, archReason, () =>
        diffArchitecture(before.architecture!, after.architecture!),
      ),
      contracts,
      section("agents", "Agent states", arch, archReason, () => {
        const out: DiffEntry[] = [];
        const locs = new Map<string, ArchLoc>();
        for (const n of after.architecture!.nodes) for (const a of n.agents) locs.set(agentKey(n.name, a.name), a.loc);
        for (const [key, a] of Object.entries(after.agents)) {
          const b = before.agents[key];
          if (b) out.push(...diffAgentModel(key, b, a, locs.get(key) ?? null));
        }
        return out;
      }),
      section("capabilities", "Capabilities", arch, archReason, () =>
        diffCapabilities(before.architecture!, after.architecture!),
      ),
    ],
  };
}

/** Every agent present in both architecture models: the ones whose state
 *  models are worth fetching on both sides (an added or removed agent is
 *  already an architecture entry). Each carries the position to ask about on
 *  each side. */
export function sharedAgents(
  before: ArchModel,
  after: ArchModel,
): Array<{ key: string; before: ArchLoc; after: ArchLoc }> {
  const bn = byKey(before.nodes, (n) => n.name);
  const out: Array<{ key: string; before: ArchLoc; after: ArchLoc }> = [];
  for (const n of after.nodes) {
    const b = bn.get(n.name);
    if (!b) continue;
    const ba = byKey(b.agents, (a) => a.name);
    for (const a of n.agents) {
      const prior = ba.get(a.name);
      if (prior) out.push({ key: agentKey(n.name, a.name), before: prior.loc, after: a.loc });
    }
  }
  return out;
}

/** Total entries across sections, for the summary line. */
export function countChanges(diff: ModelDiff): number {
  return diff.sections.reduce((n, s) => n + s.entries.length, 0);
}
