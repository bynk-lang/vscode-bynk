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
});
