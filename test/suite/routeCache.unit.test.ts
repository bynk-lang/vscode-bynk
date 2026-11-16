// The scenario route index's cache policy (`src/routeCache.ts`): a set built
// before the language server could answer is never kept, and the next committed
// analysis round says to look again. Before this, an early empty answer was
// cached as complete until a `.bynk` file changed, which in an unedited project
// (the promote integration test's fixture) was for good.

import * as assert from "assert";

import { RouteCache } from "../../src/routeCache";

interface Set {
  complete: boolean;
  n: number;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("RouteCache", () => {
  it("builds once and reuses a complete set", async () => {
    const cache = new RouteCache<Set>();
    let builds = 0;
    const build = async (): Promise<Set> => ({ complete: true, n: ++builds });
    assert.strictEqual((await cache.get("a", build)).n, 1);
    await settle();
    assert.strictEqual((await cache.get("a", build)).n, 1);
    assert.strictEqual(builds, 1);
  });

  it("shares one build between asks made while it runs", async () => {
    const cache = new RouteCache<Set>();
    let builds = 0;
    const build = async (): Promise<Set> => ({ complete: true, n: ++builds });
    const [x, y] = await Promise.all([cache.get("a", build), cache.get("a", build)]);
    assert.strictEqual(x, y);
    assert.strictEqual(builds, 1);
  });

  it("never keeps an incomplete set: the next ask builds again", async () => {
    const cache = new RouteCache<Set>();
    let builds = 0;
    const answers = [false, true];
    const build = async (): Promise<Set> => ({ complete: answers[builds] ?? true, n: ++builds });
    assert.strictEqual((await cache.get("a", build)).complete, false);
    await settle();
    const second = await cache.get("a", build);
    assert.strictEqual(second.complete, true);
    assert.strictEqual(second.n, 2);
    await settle();
    assert.strictEqual((await cache.get("a", build)).n, 2, "the complete set is kept");
  });

  it("does not keep a failed build", async () => {
    const cache = new RouteCache<Set>();
    let builds = 0;
    const build = async (): Promise<Set> => {
      builds++;
      if (builds === 1) throw new Error("server gone");
      return { complete: true, n: builds };
    };
    await assert.rejects(cache.get("a", build));
    await settle();
    assert.strictEqual((await cache.get("a", build)).n, 2);
  });

  it("says to look again on the round after an incomplete build, once", async () => {
    const cache = new RouteCache<Set>();
    assert.strictEqual(cache.roundCommitted(), false, "nothing was incomplete");
    await cache.get("a", async () => ({ complete: false, n: 1 }));
    await settle();
    assert.strictEqual(cache.roundCommitted(), true);
    assert.strictEqual(cache.roundCommitted(), false, "only the first round after it");
  });

  it("rebuilds every key after invalidate, and keeps keys apart", async () => {
    const cache = new RouteCache<Set>();
    let builds = 0;
    const build = async (): Promise<Set> => ({ complete: true, n: ++builds });
    await cache.get("a", build);
    await cache.get("b", build);
    assert.strictEqual(builds, 2);
    await settle();
    cache.invalidate();
    assert.strictEqual((await cache.get("a", build)).n, 3);
  });

  it("does not let a stale incomplete build evict a newer one", async () => {
    const cache = new RouteCache<Set>();
    let release: (s: Set) => void = () => undefined;
    const slow = cache.get("a", () => new Promise<Set>((resolve) => (release = resolve)));
    cache.invalidate();
    const fresh = await cache.get("a", async () => ({ complete: true, n: 2 }));
    release({ complete: false, n: 1 });
    await slow;
    await settle();
    assert.strictEqual(await cache.get("a", async () => ({ complete: true, n: 3 })), fresh);
  });
});
