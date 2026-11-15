// Unit coverage for "Bynk: Compare Model with…" (#147): the git side against a
// mocked `git`, and the model diffing over hand-built snapshots.

import * as assert from "assert";

import {
  agentKey,
  defaultBranch,
  diffArchitecture,
  diffContracts,
  diffSnapshots,
  isModelDiffScratch,
  CONTRACTS_NOTE,
  mergeBaseChoice,
  parseRefs,
  projectSubpath,
  sharedAgents,
  untilAnswered,
  withRevisionTree,
  type Git,
  type ModelSnapshot,
} from "../../src/modelDiffCore";
import { renderModelDiffHtml } from "../../src/modelDiffHtml";
import type { ArchModel, ArchNode } from "../../src/webview/architectureTypes";
import type { CdModel } from "../../src/webview/contractDiffTypes";
import type { AgentStateModel } from "../../src/webview/stateTypes";

const rng = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const loc = (uri = "file:///w/a.bynk") => ({ uri, range: rng });

function node(name: string, over: Partial<ArchNode> = {}): ArchNode {
  return { name, kind: "Context", loc: loc(), capabilities: [], providers: [], services: [], agents: [], ...over };
}

/** A git whose answers are looked up by the joined arguments. */
function fakeGit(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  const calls: string[] = [];
  const git: Git = {
    async run(args) {
      const key = args.join(" ");
      calls.push(key);
      const a = answers[key] ?? { code: 1 };
      return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
    },
  };
  return { git, calls };
}

describe("git side (#147)", () => {
  it("parses refs, dropping a remote's HEAD pointer", () => {
    const refs = parseRefs(
      "main\tabc1234\tFix a thing\norigin/HEAD\tabc1234\tFix a thing\norigin/feat\tdef5678\tWith\ttab\n",
    );
    assert.deepStrictEqual(refs.map((r) => r.rev), ["main", "origin/feat"]);
    assert.strictEqual(refs[1].detail, "With\ttab");
  });

  it("prefers origin/HEAD, then main, then master", async () => {
    assert.strictEqual(
      await defaultBranch(fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": { stdout: "origin/trunk\n" } }).git, "/r"),
      "origin/trunk",
    );
    assert.strictEqual(
      await defaultBranch(fakeGit({ "rev-parse --verify --quiet refs/heads/master": { stdout: "x\n" } }).git, "/r"),
      "master",
    );
    assert.strictEqual(await defaultBranch(fakeGit({}).git, "/r"), undefined);
  });

  it("offers the merge base with the default branch", async () => {
    const { git } = fakeGit({
      "symbolic-ref --short refs/remotes/origin/HEAD": { stdout: "origin/main\n" },
      "merge-base HEAD origin/main": { stdout: "0123456789abcdef\n" },
    });
    const choice = await mergeBaseChoice(git, "/r");
    assert.strictEqual(choice?.rev, "0123456789abcdef");
    assert.match(choice!.label, /origin\/main/);
    assert.strictEqual(await mergeBaseChoice(fakeGit({}).git, "/r"), undefined);
  });

  it("maps a project to its subpath in the repository", () => {
    assert.strictEqual(projectSubpath("/r", "/r"), "");
    assert.strictEqual(projectSubpath("/r/", "/r/apps/shop"), "apps/shop");
    assert.strictEqual(projectSubpath("C:\\r", "C:\\r\\x"), "x");
    assert.strictEqual(projectSubpath("/r", "/rr/x"), undefined);
  });

  it("checks a revision out, uses it and always removes the worktree", async () => {
    const ok = fakeGit({ "worktree add --detach --force /t abc": {} });
    const seen = await withRevisionTree(ok.git, "/r", "apps/shop", "abc", "/t", async () => true, async (t) => t.projectDir);
    assert.strictEqual(seen, "/t/apps/shop");
    assert.deepStrictEqual(ok.calls.slice(-2), ["worktree remove --force /t", "worktree prune"]);

    const thrown = fakeGit({ "worktree add --detach --force /t abc": {} });
    await assert.rejects(
      withRevisionTree(thrown.git, "/r", "", "abc", "/t", async () => true, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.ok(thrown.calls.includes("worktree remove --force /t"));
  });

  it("explains a failed checkout and a project the revision predates", async () => {
    const bad = fakeGit({ "worktree add --detach --force /t abc": { code: 128, stderr: "fatal: bad\n" } });
    await assert.rejects(
      withRevisionTree(bad.git, "/r", "", "abc", "/t", async () => true, async () => 1),
      /could not check out abc: fatal: bad/,
    );
    assert.ok(bad.calls.includes("worktree remove --force /t"));
    const missing = fakeGit({ "worktree add --detach --force /t abc": {} });
    await assert.rejects(
      withRevisionTree(missing.git, "/r", "apps/shop", "abc", "/t", async () => false, async () => 1),
      /no Bynk project at apps\/shop in abc/,
    );
  });

  it("retries a request until the server has an answer", async () => {
    let n = 0;
    const got = await untilAnswered(async () => (++n < 3 ? null : "ok"), 5, async () => {});
    assert.strictEqual(got, "ok");
    assert.strictEqual(await untilAnswered(async () => null, 2, async () => {}), null);
  });
});

describe("scratch checkouts (#147)", () => {
  it("recognises paths under a scratch checkout, and only those", () => {
    assert.ok(isModelDiffScratch("/tmp/bynk-model-diff-a1b2/tree/src/x.bynk"));
    assert.ok(isModelDiffScratch("C:\\Temp\\bynk-model-diff-a1b2\\tree\\x.bynk"));
    assert.ok(!isModelDiffScratch("/home/me/project/src/x.bynk"));
    assert.ok(!isModelDiffScratch("/home/me/my-bynk-model-diff-notes/x.bynk"));
  });

  it("says in the contracts section how its entries are to be read", () => {
    const snap: ModelSnapshot = { architecture: { nodes: [], edges: [] }, contracts: { lock: "read", ledger: "read", changes: [], services: [] }, agents: {} };
    const contracts = diffSnapshots(snap, snap).sections.find((s) => s.id === "contracts")!;
    assert.strictEqual(contracts.note, CONTRACTS_NOTE);
    assert.match(renderModelDiffHtml(diffSnapshots(snap, snap), { against: "x", nonce: "N", cspSource: "c" }), /its own lock files/);
  });
});

describe("architecture diff (#147)", () => {
  const before: ArchModel = {
    nodes: [
      node("shop", { services: [{ name: "api", handlerCount: 2, loc: loc() }], capabilities: [{ name: "Logger", local: false, from: "bynk", loc: loc() }] }),
      node("old"),
    ],
    edges: [{ from: "shop", to: "old", capabilities: [], loc: loc() }],
  };
  const after: ArchModel = {
    nodes: [
      node("shop", {
        services: [{ name: "api", handlerCount: 3, loc: loc("file:///w/shop.bynk") }],
        capabilities: [{ name: "Logger", local: false, from: "bynk", loc: loc() }, { name: "Clock", local: false, from: "bynk", loc: loc() }],
      }),
      node("billing", { kind: "Adapter" }),
    ],
    edges: [{ from: "shop", to: "billing", capabilities: ["Pay"], loc: loc() }],
  };

  it("reports added and removed contexts, edges, and changed services", () => {
    const entries = diffArchitecture(before, after).map((e) => `${e.change} ${e.element} ${e.name}`);
    assert.deepStrictEqual(entries.sort(), [
      "added adapter billing",
      "added consumes shop → billing",
      "changed service shop.api",
      "removed consumes shop → old",
      "removed context old",
    ]);
  });

  it("links added and changed entries to the working tree, not removed ones", () => {
    const es = diffArchitecture(before, after);
    assert.strictEqual(es.find((e) => e.name === "shop.api")?.loc?.uri, "file:///w/shop.bynk");
    assert.strictEqual(es.find((e) => e.name === "old")?.loc, null);
  });

  it("reports a changed edge selection", () => {
    const b: ArchModel = { nodes: [], edges: [{ from: "a", to: "b", capabilities: ["X"], loc: loc() }] };
    const a: ArchModel = { nodes: [], edges: [{ from: "a", to: "b", capabilities: ["X", "Y"], loc: loc() }] };
    const [e] = diffArchitecture(b, a);
    assert.strictEqual(e.change, "changed");
    assert.strictEqual(e.detail, "selection +Y");
  });
});

describe("contract diff (#147)", () => {
  const empty: CdModel = { lock: "read", ledger: "read", changes: [], services: [] };
  it("reports a boundary change that appears or is reclassified", () => {
    const change = (cls: "compatible" | "breaking") => ({
      kind: "event" as const, unit: "shop", name: "Placed", class: cls, lockedVersion: 1, detail: "field added", loc: { uri: "u", range: rng },
    });
    const added = diffContracts(empty, { ...empty, changes: [change("breaking")] });
    assert.deepStrictEqual(added.map((e) => [e.change, e.verdict, e.name]), [["added", "breaking", "shop.Placed"]]);
    const flipped = diffContracts({ ...empty, changes: [change("compatible")] }, { ...empty, changes: [change("breaking")] });
    assert.strictEqual(flipped[0].change, "changed");
    assert.strictEqual(diffContracts({ ...empty, changes: [change("breaking")] }, empty)[0].loc, null);
  });

  it("compares service contract hashes across the revisions", () => {
    const svc = (current: string, verdict?: "breaking") => ({
      environment: "prod", context: "shop", service: "api", status: "changed" as const, live: "l", current,
      compat: verdict ? { verdict, reasons: ["breaking response.at: required"] } : null, loc: null,
    });
    const same = diffContracts({ ...empty, services: [svc("h1")] }, { ...empty, services: [svc("h1")] });
    assert.deepStrictEqual(same, []);
    const diff = diffContracts({ ...empty, services: [svc("h1")] }, { ...empty, services: [svc("h2", "breaking")] });
    assert.strictEqual(diff[0].verdict, "breaking");
    assert.match(diff[0].detail!, /response\.at/);
  });
});

describe("snapshots and agents (#147)", () => {
  const machine = (states: string[], edges: AgentStateModel["machines"][number]["edges"] = []) => ({
    field: "status", fieldRange: rng, states, initial: states[0] ?? null, edges, reachable: states, truncated: [], notEvaluated: [],
  });
  const model = (states: string[], handlers: string[], edges: AgentStateModel["machines"][number]["edges"] = []): AgentStateModel => ({
    agent: "Order", range: rng, handlers: handlers.map((name) => ({ name, range: rng })), machines: [machine(states, edges)],
  });
  const edge = (handler: string, from: string[], to: string) => ({
    handler, from, guards: [], to: { kind: "State" as const, state: to }, outcome: null, range: rng, violations: [],
  });
  const arch: ArchModel = { nodes: [node("shop", { agents: [{ name: "Order", handlerCount: 1, loc: loc("file:///w/o.bynk") }] })], edges: [] };

  it("diffs states, handlers and transitions of an agent in both revisions", () => {
    const snap = (m: AgentStateModel): ModelSnapshot => ({ architecture: arch, contracts: null, agents: { [agentKey("shop", "Order")]: m } });
    const d = diffSnapshots(
      snap(model(["New", "Paid"], ["place"], [edge("place", ["New"], "Paid")])),
      snap(model(["New", "Paid", "Shipped"], ["place", "ship"], [edge("place", ["New"], "Paid"), edge("ship", ["Paid"], "Shipped")])),
    );
    const agents = d.sections.find((s) => s.id === "agents")!;
    assert.deepStrictEqual(agents.entries.map((e) => `${e.change} ${e.element}`).sort(), [
      "added handler",
      "added transition",
      "changed state machine",
    ]);
    assert.strictEqual(agents.entries[0].loc?.uri, "file:///w/o.bynk");
    assert.strictEqual(agents.entries.find((e) => e.element === "state machine")?.detail, "states +Shipped");
  });

  it("marks a section unavailable instead of reporting no differences", () => {
    const d = diffSnapshots({ architecture: null, contracts: null, agents: {} }, { architecture: arch, contracts: null, agents: {} });
    assert.ok(d.sections.every((s) => s.unavailable));
  });

  it("finds the agents present in both revisions", () => {
    const gone: ArchModel = { nodes: [node("shop")], edges: [] };
    assert.deepStrictEqual(sharedAgents(gone, arch), []);
    assert.deepStrictEqual(sharedAgents(arch, arch).map((a) => a.key), ["shop.Order"]);
  });

  it("renders clickable rows with escaped text and the verdict", () => {
    const d = diffSnapshots(
      { architecture: { nodes: [], edges: [] }, contracts: { lock: "read", ledger: "read", changes: [], services: [] }, agents: {} },
      { architecture: { nodes: [node("<b>x</b>")], edges: [] }, contracts: { lock: "read", ledger: "read", changes: [], services: [] }, agents: {} },
    );
    const html = renderModelDiffHtml(d, { against: "main", nonce: "N", cspSource: "csp" });
    assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
    assert.ok(!html.includes("<b>x</b>"));
    assert.match(html, /data-uri="file:\/\/\/w\/a\.bynk"/);
    assert.match(html, /script-src 'nonce-N'/);
  });
});
