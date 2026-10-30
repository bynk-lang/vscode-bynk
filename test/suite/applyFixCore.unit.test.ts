// The `applyFix` argument validator (src/applyFixCore.ts).

import * as assert from "assert";

import { validateFixArgs } from "../../src/applyFixCore";

const fix = { path: "a.bynk", startLine: 2, endLine: 3, replacement: "x", original: "y" };

describe("validateFixArgs (unit)", () => {
  it("accepts a well-formed proposal", () => {
    assert.deepStrictEqual(validateFixArgs("file:///a.bynk", fix), { ok: true, uri: "file:///a.bynk", fix });
  });

  it("rejects a missing or non-string uri", () => {
    for (const uri of [undefined, 3, null, {}, ""]) assert.strictEqual(validateFixArgs(uri, fix).ok, false, String(uri));
  });

  it("rejects a non-object fix", () => {
    for (const f of [undefined, null, "x", 3]) assert.strictEqual(validateFixArgs("file:///a", f).ok, false, String(f));
  });

  it("rejects bad line numbers", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, "2", null, undefined]) {
      assert.strictEqual(validateFixArgs("file:///a", { ...fix, startLine: bad }).ok, false, `start ${String(bad)}`);
      assert.strictEqual(validateFixArgs("file:///a", { ...fix, endLine: bad }).ok, false, `end ${String(bad)}`);
    }
    assert.strictEqual(validateFixArgs("file:///a", { ...fix, startLine: 5, endLine: 2 }).ok, false);
  });

  it("rejects non-string text or path", () => {
    for (const k of ["replacement", "original", "path"]) {
      assert.strictEqual(validateFixArgs("file:///a", { ...fix, [k]: 1 }).ok, false, k);
    }
  });
});
