// #30: a child that writes more than a pipe holds must not hang. The shared spawn
// helper drains stdout and stderr for the child's whole life; the stand-in `bynk`
// (BYNK_FAKE_CHATTY) writes 512 KB and only exits 0 once the reader has kept up.
// Also: `killTree` ends a child that is still running.

import * as assert from "assert";

import { killTree, spawnTree } from "../../src/proc";
import { FAKE_BYNK, useFakeBynk } from "./fakeBynk";

describe("shared process helper", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  before(async () => {
    fake = await useFakeBynk();
  });
  after(async () => {
    delete process.env.BYNK_FAKE_CHATTY;
    await fake.restore();
  });

  it("drains a debuggee that writes past the pipe buffer", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(20_000);
    const seen = { n: 0 };
    const child = spawnTree(FAKE_BYNK, ["test", ".", "--inspect"], {
      env: { ...process.env, BYNK_FAKE_CHATTY: "1" },
      output: { append: (t) => (seen.n += t.length) },
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        killTree(child);
        reject(new Error("the child hung: its output was not drained"));
      }, 15_000);
      child.once("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.strictEqual(code, 0);
    assert.ok(seen.n > 512 * 1024, `forwarded ${seen.n} bytes`);
  });

  it("drains with no sink, too", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(20_000);
    const child = spawnTree(FAKE_BYNK, ["test", ".", "--inspect"], {
      env: { ...process.env, BYNK_FAKE_CHATTY: "1" },
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    assert.strictEqual(code, 0);
  });

  it("stops a running child's process group", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(20_000);
    const child = spawnTree(FAKE_BYNK, ["dev", "--format", "json"], {
      env: { ...process.env },
    });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    const closed = new Promise<NodeJS.Signals | number | null>((resolve) =>
      child.once("close", (code, signal) => resolve(signal ?? code)),
    );
    killTree(child);
    // The stand-in traps SIGTERM and exits 143.
    assert.strictEqual(await closed, 143);
  });

  it("signals the group after its leader has exited", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(20_000);
    // The leader starts a grandchild, prints its pid and exits at once.
    const child = spawnTree("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"]);
    let out = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
    await new Promise((resolve) => child.once("close", resolve));
    const grandchild = Number(out.trim());
    assert.ok(grandchild > 0, `grandchild pid: ${out}`);
    process.kill(grandchild, 0); // still alive
    killTree(child);
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(grandchild, 0);
      } catch {
        return; // gone
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    process.kill(grandchild, "SIGKILL");
    assert.fail("the grandchild survived killTree");
  });
});
