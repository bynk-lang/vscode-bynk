// #40: the project-root rule (src/projectRootsCore.ts) over an injected
// filesystem and workspace folders — nested projects resolve to the nearest
// manifest, and the walk never leaves the workspace folder.

import * as assert from "assert";

import { containingFolder, inWorkspace, resolveRoot } from "../../src/projectRootsCore";

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
