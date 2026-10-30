// The decisions behind the shared spawn and kill helper (src/procCore.ts), with
// the platform injected. CI is Linux-only, so these pin what Windows is meant to
// do; they do not show it works on a real Windows machine.

import * as assert from "assert";

import { findExecutable, killPlan, spawnPlatformOptions } from "../../src/procCore";

describe("process helper decisions", () => {
  it("detaches into a process group on POSIX only", () => {
    assert.strictEqual(spawnPlatformOptions("linux").detached, true);
    assert.strictEqual(spawnPlatformOptions("darwin").detached, true);
    assert.strictEqual(spawnPlatformOptions("win32").detached, false);
    assert.strictEqual(spawnPlatformOptions("win32").windowsHide, true);
  });

  it("signals the process group on POSIX", () => {
    assert.deepStrictEqual(killPlan("linux", 42), { kind: "group", pid: 42, signal: "SIGTERM" });
    assert.deepStrictEqual(killPlan("darwin", 42, "SIGKILL"), {
      kind: "group",
      pid: 42,
      signal: "SIGKILL",
    });
  });

  it("runs taskkill on the tree on Windows", () => {
    assert.deepStrictEqual(killPlan("win32", 42), {
      kind: "taskkill",
      command: "taskkill",
      args: ["/T", "/F", "/PID", "42"],
    });
  });

  describe("findExecutable", () => {
    it("looks a bare name up on PATH", () => {
      const exists = (f: string) => f === "/opt/bin/bynk";
      const env = { PATH: "/usr/bin:/opt/bin" };
      assert.strictEqual(findExecutable("bynk", { platform: "linux", env, exists }), "/opt/bin/bynk");
      assert.strictEqual(findExecutable("nope", { platform: "linux", env, exists }), undefined);
    });

    it("checks a path as it is", () => {
      const exists = (f: string) => f === "/x/bynk";
      assert.strictEqual(findExecutable("/x/bynk", { platform: "linux", env: {}, exists }), "/x/bynk");
      assert.strictEqual(findExecutable("/y/bynk", { platform: "linux", env: {}, exists }), undefined);
    });

    it("tries PATHEXT on Windows", () => {
      const exists = (f: string) => f === "C:\\tools\\bynk.EXE";
      const env = { Path: "C:\\Windows;C:\\tools", PATHEXT: ".COM;.EXE" };
      assert.strictEqual(
        findExecutable("bynk", { platform: "win32", env, exists }),
        "C:\\tools\\bynk.EXE",
      );
    });
  });
});
