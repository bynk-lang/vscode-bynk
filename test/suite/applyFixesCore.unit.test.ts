import * as assert from "assert";

import {
  applyFixesArgs,
  applyFixesOutcome,
  describeOutcome,
  parseCodes,
  parseFixedFiles,
  remainingProblems,
} from "../../src/applyFixesCore";

describe("applyFixesCore", () => {
  it("builds the check --fix argument list with the = form", () => {
    assert.deepStrictEqual(applyFixesArgs("/p", ["bynk.a.b", "bynk.c.d"]), [
      "check",
      "/p",
      "--fix=bynk.a.b,bynk.c.d",
      "--format",
      "short",
    ]);
  });

  it("splits typed codes on commas and spaces, without duplicates", () => {
    assert.deepStrictEqual(parseCodes(" bynk.a.b,bynk.c.d  bynk.a.b "), ["bynk.a.b", "bynk.c.d"]);
    assert.deepStrictEqual(parseCodes("  "), []);
  });

  it("reads the files the CLI reports as fixed", () => {
    const stderr = "fixed: src/a.bynk: bynk.x.y ×3, bynk.z.w ×1\nnoise\nfixed: b c.bynk: bynk.x.y ×1\n";
    assert.deepStrictEqual(parseFixedFiles(stderr), [
      { path: "src/a.bynk", codes: [{ code: "bynk.x.y", count: 3 }, { code: "bynk.z.w", count: 1 }] },
      { path: "b c.bynk", codes: [{ code: "bynk.x.y", count: 1 }] },
    ]);
  });

  it("counts remaining problems from short output", () => {
    const out = "a.bynk:1:2: error[x]: bad\nb.bynk:3:4: warning[y]: meh\nc.bynk:5:6: warning[y]: meh\n";
    assert.deepStrictEqual(remainingProblems(out), { errors: 1, warnings: 2 });
  });

  it("classifies outcomes", () => {
    const ok = { code: 0, stdout: "", stderr: "fixed: a.bynk: bynk.x.y ×1\n" };
    assert.strictEqual(applyFixesOutcome(ok, false).kind, "applied");
    assert.deepStrictEqual(applyFixesOutcome(ok, true), { kind: "cancelled" });
    assert.deepStrictEqual(applyFixesOutcome({ code: 0, stdout: "", stderr: "" }, false), {
      kind: "nothing",
      remaining: { errors: 0, warnings: 0 },
    });
    // Remaining problems make check exit 1 even when files were fixed.
    assert.strictEqual(applyFixesOutcome({ ...ok, code: 1 }, false).kind, "applied");
    assert.deepStrictEqual(applyFixesOutcome({ error: new Error("no bynk") }, false), { kind: "failed", message: "no bynk" });
  });

  it("shows the CLI's own refusal and unknown-code messages as they are", () => {
    const unknown = "bynk: --fix: unknown diagnostic code `bynk.x`; did you mean `bynk.y`?\n";
    assert.deepStrictEqual(applyFixesOutcome({ code: 2, stdout: "", stderr: unknown }, false), {
      kind: "failed",
      message: unknown.trim(),
    });
    const refused = "a.bynk: --fix: leaves an error\nbynk: --fix: nothing was written\n";
    const r = applyFixesOutcome({ code: 1, stdout: "", stderr: refused }, false);
    assert.strictEqual(r.kind, "failed");
    assert.match((r as { message: string }).message, /nothing was written/);
  });

  it("reports an old toolchain and unexplained failures", () => {
    const old = applyFixesOutcome({ code: 2, stdout: "", stderr: "error: unexpected argument '--fix' found\n" }, false);
    assert.match((old as { message: string }).message, /no `--fix=<code>`/);
    assert.strictEqual(applyFixesOutcome({ code: 101, stdout: "", stderr: "" }, false).kind, "failed");
  });

  it("describes the result", () => {
    const files = [{ path: "a.bynk", codes: [{ code: "bynk.x.y", count: 1 }] }];
    assert.match(describeOutcome({ kind: "applied", files, remaining: { errors: 0, warnings: 0 } }), /^Fixed 1 file\. No problems remain\./);
    assert.match(describeOutcome({ kind: "nothing", remaining: { errors: 1, warnings: 2 } }), /No files needed.*1 error, 2 warnings/);
  });
});
