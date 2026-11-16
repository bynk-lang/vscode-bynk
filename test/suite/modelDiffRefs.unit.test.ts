// Unit coverage for comparing two revisions, the pull request entry point and
// the unfetched-dependency warning of "Bynk: Compare Model with…" (#155).

import * as assert from "assert";

import {
  dependencyWarning,
  diffSnapshots,
  firstResolvable,
  headRev,
  isSafeRef,
  resolveRev,
  withRevisionTree,
  mergeBase,
  pullRequestRefs,
  ScratchProblems,
  scratchRoot,
  withoutLocations,
  type Git,
  type ModelSnapshot,
} from "../../src/modelDiffCore";
import { renderModelDiffHtml } from "../../src/modelDiffHtml";
import type { ArchModel, ArchNode } from "../../src/webview/architectureTypes";

const rng = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const node = (name: string): ArchNode => ({
  name, kind: "Context", loc: { uri: "file:///w/a.bynk", range: rng }, capabilities: [], providers: [], services: [], agents: [],
});

function fakeGit(answers: Record<string, string | null>): Git {
  return {
    async run(args) {
      const a = answers[args.join(" ")];
      return a === undefined || a === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: a + "\n", stderr: "" };
    },
  };
}

describe("pull request refs from the GitHub Pull Requests extension (#155)", () => {
  it("reads the base and head from a pull request tree node", () => {
    const node = { pullRequestModel: { number: 42, base: { ref: "main", sha: "aaa" }, head: { ref: "feat", sha: "bbb" } } };
    assert.deepStrictEqual(pullRequestRefs(node), { base: ["aaa", "origin/main", "main"], head: "bbb", label: "#42" });
  });

  it("reads a pull request model passed directly, and a base without a sha", () => {
    assert.deepStrictEqual(pullRequestRefs({ base: { ref: "dev" }, head: null }), {
      base: ["origin/dev", "dev"], head: undefined, label: undefined,
    });
  });

  it("gives up on a shape it does not recognise rather than guessing", () => {
    for (const bad of [undefined, null, "x", 3, {}, { pullRequestModel: {} }, { pullRequestModel: { base: { ref: 1, sha: "" } } }]) {
      assert.strictEqual(pullRequestRefs(bad), undefined, JSON.stringify(bad));
    }
  });

  it("finds the first candidate git knows, and the merge base and HEAD", async () => {
    const git = fakeGit({
      "rev-parse --verify --quiet origin/main^{commit}": "1111111111111111111111111111111111111111",
      "merge-base 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222": "0000000000000000000000000000000000000000",
      "rev-parse --verify --quiet HEAD^{commit}": "2222222222222222222222222222222222222222",
    });
    assert.strictEqual(await firstResolvable(git, "/r", ["aaa", "origin/main", "main"]), "1111111111111111111111111111111111111111");
    assert.strictEqual(await firstResolvable(git, "/r", ["aaa", ""]), undefined);
    assert.strictEqual(await mergeBase(git, "/r", "1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"), "0000000000000000000000000000000000000000");
    assert.strictEqual(await mergeBase(git, "/r", "1111111111111111111111111111111111111111", "9999999999999999999999999999999999999999"), undefined);
    assert.strictEqual(await headRev(git, "/r"), "2222222222222222222222222222222222222222");
  });
});

describe("dependencies that are not fetched (#155)", () => {
  const unfetched = "acme/app's git dependency `money` (`https://x/y` at `v1`) hasn't been fetched";

  it("finds the scratch checkout a path lies under", () => {
    assert.strictEqual(scratchRoot("/tmp/bynk-model-diff-abc/tree/src/a.bynk"), "/tmp/bynk-model-diff-abc");
    assert.strictEqual(scratchRoot("C:\\Temp\\bynk-model-diff-x\\tree\\a.bynk"), "C:/Temp/bynk-model-diff-x");
    assert.strictEqual(scratchRoot("/home/me/project/a.bynk"), undefined);
  });

  it("keeps only dependency problems, per checkout, and hands them over once", () => {
    const p = new ScratchProblems();
    p.note("/tmp/bynk-model-diff-1/tree/bynk.toml", [
      { code: "bynk.package.not_fetched", message: unfetched },
      { code: { value: "bynk.registry.unavailable" }, message: "no registry serves acme" },
      { code: "bynk.type.mismatch", message: "a type error" },
      { message: "no code" },
    ]);
    p.note("/tmp/bynk-model-diff-2/tree/a.bynk", [{ code: "bynk.package.not_fetched", message: "other" }]);
    p.note("/home/me/p/a.bynk", [{ code: "bynk.package.not_fetched", message: "not a scratch path" }]);
    assert.deepStrictEqual(p.take("/tmp/bynk-model-diff-1/tree"), [unfetched, "no registry serves acme"]);
    assert.deepStrictEqual(p.take("/tmp/bynk-model-diff-1/tree"), [], "taken once");
    assert.deepStrictEqual(p.take("/tmp/bynk-model-diff-2/tree"), ["other"]);
    assert.deepStrictEqual(p.take("/tmp/elsewhere/tree"), []);
  });

  it("says the model is incomplete and how to fill the store", () => {
    const w = dependencyWarning("main", [unfetched]);
    assert.match(w, /Not every dependency of main could be analysed, so its model is incomplete/);
    assert.match(w, /bynk fetch/);
  });

  it("shows warnings on the page", () => {
    const snap: ModelSnapshot = { architecture: { nodes: [], edges: [] }, contracts: null, agents: {} };
    const html = renderModelDiffHtml({ ...diffSnapshots(snap, snap), warnings: ["a <b>warning</b>"] }, { against: "x", nonce: "N", cspSource: "c" });
    assert.match(html, /<p class="warning">a &lt;b&gt;warning&lt;\/b&gt;<\/p>/);
  });
});

describe("two revisions (#155)", () => {
  const snap = (names: string[]): ModelSnapshot => ({
    architecture: { nodes: names.map(node), edges: [] } as ArchModel, contracts: null, agents: {},
  });

  it("links nothing, since neither side is in the working tree", () => {
    const d = diffSnapshots(snap(["a"]), snap(["a", "b"]));
    assert.ok(d.sections[0].entries.some((e) => e.loc !== null), "against the working tree an added row links");
    const none = withoutLocations(d);
    assert.ok(none.sections.every((s) => s.entries.every((e) => e.loc === null)));
    assert.strictEqual(none.sections[0].entries.length, d.sections[0].entries.length);
  });

  it("names both revisions in the heading and does not invite opening a row", () => {
    const d = withoutLocations(diffSnapshots(snap(["a"]), snap(["a", "b"])));
    const html = renderModelDiffHtml(d, { against: "v1", to: "v2", nonce: "N", cspSource: "c" });
    assert.match(html, /<code>v1<\/code> → v2<\/h1>/);
    assert.ok(!html.includes("open its source in the working tree"));
    assert.ok(!html.includes(`data-uri="`), "no row carries a location");
    assert.match(renderModelDiffHtml(d, { against: "v1", nonce: "N", cspSource: "c" }), /→ working tree<\/h1>/);
  });
});

// A ref comes from typed input or from another extension's tree item (a fork
// pull request's branch name is a stranger's), so it must never reach git as an
// option, and only full commit ids reach `merge-base` and `worktree add`.
describe("refs never reach git as options (#155)", () => {
  const hostile = ["--upload-pack=touch /tmp/x", "-c", "--output=/tmp/x", "-", "--", "a b", "main\nHEAD", "x\u0000y", ""];

  /** A git that records every call and answers any rev-parse with a commit id. */
  function recording() {
    const calls: string[][] = [];
    const git: Git = {
      async run(args) {
        calls.push(args);
        return { code: 0, stdout: "f".repeat(40) + "\n", stderr: "" };
      },
    };
    return { git, calls };
  }

  it("refuses an option-like ref before any git runs", async () => {
    for (const ref of hostile) {
      assert.strictEqual(isSafeRef(ref), false, JSON.stringify(ref));
      const { git, calls } = recording();
      assert.strictEqual(await resolveRev(git, "/r", ref), undefined, JSON.stringify(ref));
      assert.strictEqual(await firstResolvable(git, "/r", [ref]), undefined);
      assert.deepStrictEqual(calls, [], `git.run was reached with ${JSON.stringify(ref)}`);
    }
    for (const ok of ["main", "origin/feature/x", "v1.2.3", "a".repeat(40), "HEAD~2", "refs/pull/5/head"]) {
      assert.strictEqual(isSafeRef(ok), true, ok);
    }
  });

  it("passes only commit ids to merge-base and worktree add", async () => {
    const { git, calls } = recording();
    assert.strictEqual(await mergeBase(git, "/r", "--flag", "f".repeat(40)), undefined);
    assert.strictEqual(await mergeBase(git, "/r", "main", "f".repeat(40)), undefined, "a name is not an id");
    assert.deepStrictEqual(calls, []);
    await assert.rejects(withRevisionTree(git, "/r", "", "--detach", "/t", async () => true, async () => 1), /not a commit id/);
    await assert.rejects(withRevisionTree(git, "/r", "", "main", "/t", async () => true, async () => 1), /not a commit id/);
    assert.deepStrictEqual(calls, [], "no worktree was added");
  });

  it("accepts only a commit id from rev-parse, whatever git prints", async () => {
    const odd: Git = { run: async () => ({ code: 0, stdout: "--output=/tmp/x\n", stderr: "" }) };
    assert.strictEqual(await resolveRev(odd, "/r", "main"), undefined);
    assert.strictEqual(await headRev(odd, "/r"), undefined);
  });
});

describe("a pull request shape the extension no longer has (#155)", () => {
  it("is not read, so the command falls back to asking for the revisions", () => {
    // The shapes a future version of the GitHub Pull Requests extension may pass:
    // `bynk.compareModelPullRequest` treats `undefined` as "ask" (see the
    // integration test, which runs the command against such a shape).
    for (const shape of [{ pullRequestModel: { base: "main" } }, { item: { base: { ref: "main" } } }, [], () => 1]) {
      assert.strictEqual(pullRequestRefs(shape), undefined);
    }
  });
});
