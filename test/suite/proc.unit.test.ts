// The decisions behind the shared spawn and kill helper (src/procCore.ts), with
// the platform injected. CI is Linux-only, so these pin what Windows is meant to
// do; they do not show it works on a real Windows machine.

import * as assert from "assert";

import { classifySpawnError, findExecutable, killPlan, MISSING_CWD, missingCwdMessage, spawnPlatformOptions } from "../../src/procCore";

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
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/T", "/F", "/PID", "42"],
    });
  });

  it("finds taskkill under SystemRoot", () => {
    const plan = killPlan("win32", 1, "SIGTERM", { SystemRoot: "D:\\WIN" });
    assert.strictEqual(plan.kind === "taskkill" && plan.command, "D:\\WIN\\System32\\taskkill.exe");
  });

  describe("classifySpawnError (#61)", () => {
    const enoent = { code: "ENOENT" };
    it("blames a missing cwd, not bynk, when the directory is gone", () => {
      assert.strictEqual(classifySpawnError(enoent, "/gone", () => false), "missing-cwd");
    });
    it("calls ENOENT in an existing cwd a missing command", () => {
      assert.strictEqual(classifySpawnError(enoent, "/here", () => true), "missing-command");
      assert.strictEqual(classifySpawnError(enoent, undefined, () => false), "missing-command");
    });
    it("leaves other errors alone", () => {
      assert.strictEqual(classifySpawnError({ code: "EACCES" }, "/gone", () => false), "other");
      assert.strictEqual(classifySpawnError(null, "/gone", () => false), "other");
    });
    it("names the directory", () => {
      assert.match(missingCwdMessage("/gone"), /\/gone/);
      assert.notStrictEqual(MISSING_CWD, "ENOENT");
    });
  });

  describe("findExecutable", () => {
    it("resolves relative paths against cwd and expands ~", () => {
      const exists = (f: string) => f === "/ws/tools/bynk" || f === "/home/me/bin/bynk";
      assert.strictEqual(
        findExecutable("./tools/bynk", { platform: "linux", env: {}, exists, cwd: "/ws" }),
        "/ws/tools/bynk",
      );
      assert.strictEqual(
        findExecutable("~/bin/bynk", { platform: "linux", env: {}, exists, home: "/home/me" }),
        "/home/me/bin/bynk",
      );
    });

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
