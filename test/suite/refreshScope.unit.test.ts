// #38/#41: scoping refreshes to the project that changed — the `vscode`-free
// helpers in `refreshScope.ts`.

import * as assert from "assert";

import {
  depsKey,
  Generations,
  groupByRoot,
  inScope,
  mapLimit,
  mergeScope,
  rootsFor,
  statStamp,
} from "../../src/refreshScope";

describe("refresh scope (#38)", () => {
  it("merges scopes, with 'all' absorbing", () => {
    assert.strictEqual(mergeScope(undefined, "all"), "all");
    assert.strictEqual(mergeScope("all", new Set(["a"])), "all");
    assert.strictEqual(mergeScope(new Set(["a"]), "all"), "all");
    assert.deepStrictEqual([...(mergeScope(new Set(["a"]), new Set(["b", "a"])) as Set<string>)].sort(), ["a", "b"]);
    assert.ok(inScope("all", "x"));
    assert.ok(inScope(new Set(["x"]), "x"));
    assert.ok(!inScope(new Set(["x"]), "y"));
  });

  it("finds the owning root, the nested project winning", () => {
    const roots = ["/w/a", "/w/a/inner", "/w/b"];
    const r = rootsFor(["/w/a/src/x.bynk", "/w/a/inner/y.bynk", "/w/b/z.bynk"], roots);
    assert.deepStrictEqual([...r.roots].sort(), ["/w/a", "/w/a/inner", "/w/b"]);
    assert.ok(!r.unknown);
    // A sibling whose name merely starts like a root is not inside it.
    assert.deepStrictEqual(rootsFor(["/w/ab/x.bynk"], roots), { roots: new Set(), unknown: true });
  });

  it("groups items by root, dropping those with none", () => {
    const g = groupByRoot([
      { key: 1, root: "/a" },
      { key: 2, root: undefined },
      { key: 3, root: "/a" },
      { key: 4, root: "/b" },
    ]);
    assert.deepStrictEqual([...g.keys()], ["/a", "/b"]);
    assert.deepStrictEqual(g.get("/a")!.map((m) => m.key), [1, 3]);
  });

  it("keys the deps cache on the manifest and the lock", () => {
    const k = depsKey(statStamp({ mtimeMs: 1, size: 10 }), statStamp({ mtimeMs: 2, size: 5 }));
    assert.strictEqual(k, depsKey(statStamp({ mtimeMs: 1, size: 10 }), statStamp({ mtimeMs: 2, size: 5 })));
    assert.notStrictEqual(k, depsKey(statStamp({ mtimeMs: 3, size: 10 }), statStamp({ mtimeMs: 2, size: 5 })));
    assert.notStrictEqual(k, depsKey(statStamp({ mtimeMs: 1, size: 10 }), statStamp(undefined)));
  });
});

describe("mapLimit (#38)", () => {
  it("never runs more than the limit at once, and keeps the result order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5 * (8 - n)));
      active--;
      return n * 2;
    });
    assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14]);
    assert.strictEqual(peak, 3);
  });

  it("handles no items and a limit above the item count", async () => {
    assert.deepStrictEqual(await mapLimit([], 4, async (n: number) => n), []);
    assert.deepStrictEqual(await mapLimit([1, 2], 10, async (n) => n + 1), [2, 3]);
  });
});

describe("Generations (#41)", () => {
  it("makes a run started before a bump stale, only for the bumped key", () => {
    const g = new Generations();
    const a = g.current("a");
    const b = g.current("b");
    g.bump("a");
    assert.ok(!g.isCurrent("a", a));
    assert.ok(g.isCurrent("b", b));
    assert.ok(g.isCurrent("a", g.current("a")));
  });

  it("bumping every key stales all runs, including keys never seen", () => {
    const g = new Generations();
    const a = g.current("a");
    const c = g.current("c");
    g.bump();
    assert.ok(!g.isCurrent("a", a));
    assert.ok(!g.isCurrent("c", c));
  });
});
