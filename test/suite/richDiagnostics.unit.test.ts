// #2516: reading the diagnostics `bynk compile` prints (src/richDiagnostics.ts),
// against output the real toolchain produced.

import * as assert from "assert";

import { describeDiagnostic, diagnosticKey, parseRichDiagnostics } from "../../src/richDiagnostics";

const TWO = `[bynk.resolve.unknown_name] Error: unknown name \`missing\`
   ╭─[ src/shop.bynk:3:27 ]
   │
 3 │ fn a(n: Int) -> Int { n * missing }
   │                           ───┬───  
   │                              ╰───── unknown name \`missing\`
   │ 
   │ Note: only parameters, \`let\` bindings, and functions declared in this commons are in scope
───╯
[bynk.types.return_mismatch] Error: function body has type \`Int\`, but the declared return type is \`Bool\`
   ╭─[ src/shop.bynk:4:24 ]
   │
 4 │ fn b(n: Int) -> Bool { n + 1 }
   │                 ──┬─   ──┬──  
   │                   ╰─────────── declared return type
   │                          │    
   │                          ╰──── function body has type \`Int\`, but the declared return type is \`Bool\`
───╯
`;

describe("parseRichDiagnostics (#2516)", () => {
  it("reads each diagnostic's code, message and location", () => {
    assert.deepStrictEqual(parseRichDiagnostics(TWO), [
      { code: "bynk.resolve.unknown_name", severity: "error", message: "unknown name `missing`", path: "src/shop.bynk", line: 3, column: 27 },
      {
        code: "bynk.types.return_mismatch",
        severity: "error",
        message: "function body has type `Int`, but the declared return type is `Bool`",
        path: "src/shop.bynk",
        line: 4,
        column: 24,
      },
    ]);
  });

  it("reads warnings and ignores everything that is not a diagnostic", () => {
    const out = parseRichDiagnostics("compiling shop...\n[bynk.lint.unused] Warning: unused `x`\n   ╭─[ src/a.bynk:1:5 ]\n│ Note: [not a header]\nok\n");
    assert.deepStrictEqual(out, [
      { code: "bynk.lint.unused", severity: "warning", message: "unused `x`", path: "src/a.bynk", line: 1, column: 5 },
    ]);
  });

  it("takes a location only from the box after its own header", () => {
    // The first diagnostic has no box; the location belongs to the second.
    const out = parseRichDiagnostics("[bynk.a.one] Error: first\n[bynk.b.two] Error: second\n   ╭─[ src/x.bynk:2:3 ]\n");
    assert.strictEqual(out[0].path, undefined);
    assert.strictEqual(out[1].path, "src/x.bynk");
  });

  it("reads a diagnostic the compiler wrapped in colour codes", () => {
    const out = parseRichDiagnostics("\u001b[31m[bynk.a.one] Error: boom\u001b[0m\n   ╭─[ src/x.bynk:1:1 ]\n");
    assert.deepStrictEqual(out, [
      { code: "bynk.a.one", severity: "error", message: "boom", path: "src/x.bynk", line: 1, column: 1 },
    ]);
  });

  it("finds nothing in empty or unrelated output", () => {
    assert.deepStrictEqual(parseRichDiagnostics(""), []);
    assert.deepStrictEqual(parseRichDiagnostics("bynk: could not run bynkc\n"), []);
  });

  it("keys a diagnostic by where and what it is, not by its line", () => {
    const [a] = parseRichDiagnostics(TWO);
    assert.strictEqual(diagnosticKey(a), diagnosticKey({ ...a, line: 40, column: 2 }));
    assert.notStrictEqual(diagnosticKey(a), diagnosticKey({ ...a, message: "other" }));
    assert.strictEqual(describeDiagnostic(a), "src/shop.bynk:3: error[bynk.resolve.unknown_name]: unknown name `missing`");
  });
});
