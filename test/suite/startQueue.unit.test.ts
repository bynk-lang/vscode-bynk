// Unit coverage for the server start queue (src/startQueue.ts, #31): starts run
// one at a time, and a start a later one has superseded can tell.

import * as assert from "assert";

import { StartQueue } from "../../src/startQueue";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("StartQueue", () => {
  it("runs overlapping tasks one at a time, in order", async () => {
    const q = new StartQueue();
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([q.run(task("a")), q.run(task("b")), q.run(task("c"))]);
    assert.deepStrictEqual(log, [
      "a:start", "a:end", "b:start", "b:end", "c:start", "c:end",
    ]);
  });

  it("leaves one live resource when starts overlap", async () => {
    const q = new StartQueue();
    let live = 0;
    let peak = 0;
    const start = () =>
      q.run(async (superseded) => {
        live = 0; // stop the previous one
        await tick(); // resolve / download a server
        if (superseded()) return;
        live++;
        peak = Math.max(peak, live);
      });
    await Promise.all([start(), start(), start()]);
    assert.strictEqual(live, 1);
    assert.strictEqual(peak, 1);
  });

  it("reports only the latest task as current", async () => {
    const q = new StartQueue();
    const seen: boolean[] = [];
    const a = q.run(async (s) => {
      await tick();
      seen.push(s());
    });
    const b = q.run(async (s) => {
      seen.push(s());
    });
    await Promise.all([a, b]);
    assert.deepStrictEqual(seen, [true, false]);
  });

  it("cancelPending supersedes a running task", async () => {
    const q = new StartQueue();
    let superseded = false;
    const a = q.run(async (s) => {
      await tick();
      superseded = s();
    });
    q.cancelPending();
    await q.idle();
    await a;
    assert.strictEqual(superseded, true);
  });

  it("keeps running after a task throws", async () => {
    const q = new StartQueue();
    const bad = q.run(async () => {
      throw new Error("boom");
    });
    const good = q.run(async () => "ok");
    await assert.rejects(bad, /boom/);
    assert.strictEqual(await good, "ok");
  });

  it("lets a superseded task skip its work, and aborts its signal", async () => {
    const q = new StartQueue();
    let worked = 0;
    let aborted = false;
    const a = q.run(async (superseded, signal) => {
      await tick();
      aborted = signal.aborted;
      if (superseded()) return;
      worked++;
    });
    // b is queued while a runs; c while b waits: b never starts real work.
    const b = q.run(async (superseded) => {
      if (superseded()) return;
      worked++;
    });
    const c = q.run(async () => {
      worked++;
    });
    await Promise.all([a, b, c]);
    assert.strictEqual(aborted, true);
    assert.strictEqual(worked, 1, "only the last task did its work");
  });
});
