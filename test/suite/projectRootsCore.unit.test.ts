// #40: the project-root rule (src/projectRootsCore.ts) over an injected
// filesystem and workspace folders — nested projects resolve to the nearest
// manifest, and the walk never leaves the workspace folder.

import * as assert from "assert";

import { containingFolder, inWorkspace, resolveRoot, RootCache } from "../../src/projectRootsCore";

const fsWith =
  (...manifests: string[]) =>
  async (dir: string): Promise<boolean> =>
    manifests.includes(dir);

describe("project roots (#40)", () => {
  const folders = ["/home/me/work"];

  it("finds a manifest at the workspace folder", async () => {
    assert.strictEqual(await resolveRoot("/home/me/work/src/a.bynk", folders, fsWith("/home/me/work")), "/home/me/work");
  });

  it("prefers the nearest manifest, so a nested project wins", async () => {
    const has = fsWith("/home/me/work", "/home/me/work/apps/web");
    assert.strictEqual(await resolveRoot("/home/me/work/apps/web/src/a.bynk", folders, has), "/home/me/work/apps/web");
    assert.strictEqual(await resolveRoot("/home/me/work/src/b.bynk", folders, has), "/home/me/work");
  });

  it("never climbs above the workspace folder", async () => {
    const seen: string[] = [];
    const has = async (dir: string) => (seen.push(dir), dir === "/home/me");
    assert.strictEqual(await resolveRoot("/home/me/work/src/a.bynk", folders, has), undefined);
    assert.ok(seen.every((d) => d.startsWith("/home/me/work")), seen.join(","));
  });

  it("uses the workspace folder that holds the file", async () => {
    const two = ["/a", "/a/inner", "/b"];
    assert.strictEqual(await resolveRoot("/a/inner/x.bynk", two, fsWith("/a")), undefined);
    assert.strictEqual(await resolveRoot("/a/inner/x.bynk", two, fsWith("/a/inner")), "/a/inner");
    assert.strictEqual(await resolveRoot("/b/s/x.bynk", two, fsWith("/a", "/b")), "/b");
  });

  it("does not take a sibling folder sharing a name prefix", () => {
    assert.strictEqual(containingFolder("/work-old/a.bynk", ["/work"]), undefined);
    assert.strictEqual(containingFolder("/work/a.bynk", ["/work/"]), "/work");
  });

  it("walks a loose file up to its project, as a scaffolded src/main.bynk needs", async () => {
    assert.strictEqual(await resolveRoot("/tmp/p/src/a.bynk", folders, fsWith("/tmp/p")), "/tmp/p");
    assert.strictEqual(await resolveRoot("/tmp/p/src/a.bynk", [], fsWith("/tmp/p")), "/tmp/p");
  });

  it("never takes a manifest in the home directory for a loose file", async () => {
    const home = { home: "/home/me" };
    assert.strictEqual(await resolveRoot("/home/me/scratch/a.bynk", [], fsWith("/home/me"), home), undefined);
    assert.strictEqual(await resolveRoot("/home/me/scratch/a.bynk", [], fsWith("/home/me/scratch"), home), "/home/me/scratch");
    assert.strictEqual(await resolveRoot("/home/me/a.bynk", [], fsWith("/home/me"), home), undefined);
  });

  it("stops at the filesystem root for a loose file", async () => {
    const seen: string[] = [];
    await resolveRoot("/x/y/a.bynk", [], async (d) => (seen.push(d), false));
    assert.deepStrictEqual(seen, ["/x/y", "/x", "/"]);
  });

  it("compares folders ignoring case when asked", async () => {
    const ci = { caseInsensitive: true };
    assert.strictEqual(containingFolder("/Work/src/a.bynk", ["/work"], true), "/work");
    assert.strictEqual(containingFolder("/Work/src/a.bynk", ["/work"]), undefined);
    assert.strictEqual(await resolveRoot("/Work/src/a.bynk", ["/work"], fsWith("/Work"), ci), "/Work");
    assert.ok(inWorkspace("/Work/a.bynk", ["/work"], ci));
    assert.ok(!inWorkspace("/Other/a.bynk", ["/work"], ci));
  });

  it("handles a manifest at the filesystem root only when it is the folder", async () => {
    assert.strictEqual(await resolveRoot("/a.bynk", ["/"], fsWith("/")), "/");
  });
});

describe("root cache (#61)", () => {
  const counted = () => {
    const calls = { resolve: 0, check: 0 };
    return { calls, live: new Set<string>(["/p"]) };
  };

  it("serves a hit with one manifest check, not a second walk", async () => {
    const { calls, live } = counted();
    const cache = new RootCache<string>();
    const resolve = async () => (calls.resolve++, "/p");
    const check = async (r: string) => (calls.check++, live.has(r));
    assert.strictEqual(await cache.get("k", resolve, check), "/p");
    assert.strictEqual(await cache.get("k", resolve, check), "/p");
    assert.deepStrictEqual(calls, { resolve: 1, check: 1 });
  });

  it("drops a root whose manifest is gone and resolves again", async () => {
    const live = new Set(["/outer", "/outer/inner"]);
    const cache = new RootCache<string>();
    const resolve = async () => (live.has("/outer/inner") ? "/outer/inner" : live.has("/outer") ? "/outer" : undefined);
    const check = async (r: string) => live.has(r);
    assert.strictEqual(await cache.get("k", resolve, check), "/outer/inner");
    live.delete("/outer/inner");
    assert.strictEqual(await cache.get("k", resolve, check), "/outer");
    live.delete("/outer");
    assert.strictEqual(await cache.get("k", resolve, check), undefined);
  });

  it("clear forgets every entry", async () => {
    const cache = new RootCache<string>();
    let n = 0;
    const resolve = async () => `/r${++n}`;
    const check = async () => true;
    assert.strictEqual(await cache.get("k", resolve, check), "/r1");
    cache.clear();
    assert.strictEqual(await cache.get("k", resolve, check), "/r2");
  });
});

describe("root cache, concurrent stale hits (#61)", () => {
  it("lets two callers that both find a stale entry share one fresh resolve", async () => {
    const cache = new RootCache<string>();
    let resolves = 0;
    let live = true;
    const resolve = async () => (resolves++, live ? "/p" : undefined);
    const check = async (r: string) => live && r === "/p";
    await cache.get("k", resolve, check);
    live = false;
    const [a, b] = await Promise.all([cache.get("k", resolve, check), cache.get("k", resolve, check)]);
    assert.strictEqual(a, undefined);
    assert.strictEqual(b, undefined);
    assert.strictEqual(resolves, 2, "one initial resolve, one shared re-resolve");
  });
});
