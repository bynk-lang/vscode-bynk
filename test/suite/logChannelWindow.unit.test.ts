// Unit tests for how often the Bynk Logs channel is rebuilt (#37).

import * as assert from "assert";

import { ChannelWindow } from "../../src/logChannelWindow";

/** Push `n` lines through a window the way `DevLogs.push` does. */
function rebuilds(window: ChannelWindow, limit: number, n: number): number {
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (window.append()) {
      count++;
      window.rendered(limit); // the buffer is full: a rebuild shows `limit` lines
    }
  }
  return count;
}

describe("ChannelWindow", () => {
  it("appends until the channel holds twice the buffer", () => {
    const window = new ChannelWindow(10);
    assert.strictEqual(rebuilds(window, 10, 20), 0);
    assert.strictEqual(rebuilds(window, 10, 1), 1);
  });

  it("rebuilds O(N/limit) times past a full buffer, not once per line", () => {
    const limit = 100;
    const window = new ChannelWindow(limit);
    window.rendered(limit); // a full buffer, just rendered
    const n = 10_000;
    const count = rebuilds(window, limit, n);
    assert.ok(count <= Math.ceil(n / limit), `${count} rebuilds for ${n} lines`);
    assert.ok(count >= n / (limit * 2) - 1, `${count} rebuilds is suspiciously few`);
  });
});
