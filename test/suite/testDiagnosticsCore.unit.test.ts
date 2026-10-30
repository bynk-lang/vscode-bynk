// Unit coverage for `testDiagnosticsCore` (src/testDiagnosticsCore.ts), the parsing
// of a test run's compile-failure lines — no extension host.

import * as assert from "assert";

import { parseCompileDiagnostics } from "../../src/testDiagnosticsCore";

describe("parseCompileDiagnostics", () => {
  it("parses the bynkc shape into 0-indexed positions", () => {
    assert.deepStrictEqual(parseCompileDiagnostics(["src/a.bynk:3:7: error[E0042]: no such name `x`"]), [
      { file: "src/a.bynk", line: 2, col: 6, severity: "error", code: "E0042", message: "no such name `x`" },
    ]);
  });

  it("reads warnings and keeps colons inside the message", () => {
    const [d] = parseCompileDiagnostics(["a.bynk:1:1: warning[W1]: unused: thing"]);
    assert.strictEqual(d.severity, "warning");
    assert.strictEqual(d.message, "unused: thing");
  });

  it("clamps a zero line or column and drops lines that do not match", () => {
    const out = parseCompileDiagnostics(["a.bynk:0:0: error[E1]: m", "not a diagnostic", "a.bynk:1:1: note[E1]: m"]);
    assert.deepStrictEqual(out.map((d) => [d.line, d.col]), [[0, 0]]);
  });
});
