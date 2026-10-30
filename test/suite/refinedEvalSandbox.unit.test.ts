// #35: the explorer runs server-supplied predicate text; these pin that an
// escape attempt cannot reach the extension host's realm, and that the
// legitimate predicate forms still evaluate under the same restrictions.

import * as assert from "assert";

import { evaluateClauses } from "../../src/refinedEval";
import type { RefinedClause } from "../../src/webview/refinedTypes";

function clause(check: string): RefinedClause {
  return { source: "x", description: "", check, message: "no" };
}

function escapes(check: string, value: bigint | number | string = "abc"): void {
  // Either the predicate throws (string codegen is off) or it cannot produce the host's `process`.
  try {
    const v = evaluateClauses([clause(check)], value);
    assert.notStrictEqual(v.kind, "valid", check);
  } catch (err) {
    assert.ok(!/pid|argv/.test(String(err)), String(err));
  }
}

describe("refinedEval sandbox (unit)", () => {
  it("this.constructor.constructor cannot reach the host Function", () => {
    escapes('this.constructor.constructor("return process")() !== undefined');
    assert.throws(() => evaluateClauses([clause('this.constructor.constructor("return process")()')], "a"), /EvalError|predicate threw/);
  });

  it("value.constructor.constructor cannot reach the host Function", () => {
    assert.throws(() => evaluateClauses([clause('value.constructor.constructor("return process")()')], "a"), /EvalError|predicate threw/);
    assert.throws(() => evaluateClauses([clause('value.constructor.constructor("return process")()')], 1n), /EvalError|predicate threw/);
  });

  it("process and require are not in scope", () => {
    const v = evaluateClauses([clause('typeof process === "undefined" && typeof require === "undefined"')], "a");
    assert.strictEqual(v.kind, "valid");
  });

  it("an Error.prepareStackTrace hook cannot be installed to leak host frames", () => {
    const hook =
      "(function () { var leaked; Error.prepareStackTrace = function (e, s) { leaked = s.map(function (f) { return f.getFunction(); }); return 1; };" +
      " try { null.x; } catch (e) { e.stack; } return leaked === undefined; })()";
    assert.strictEqual(evaluateClauses([clause(hook)], "a").kind, "valid");
  });

  it("the sandbox does not leak between clauses", () => {
    const set = clause("(globalThis.leak = 1) === 1");
    const read = clause("typeof globalThis.leak === 'undefined'");
    assert.strictEqual(evaluateClauses([set, read], "a").kind, "valid");
  });

  it("an infinite loop times out", () => {
    assert.strictEqual(evaluateClauses([clause("(function () { for (;;) {} })()")], "a", 50).kind, "timeout");
  });

  it("legitimate predicates still evaluate", () => {
    assert.strictEqual(evaluateClauses([clause("value >= 1 && value <= 100")], 50n).kind, "valid");
    assert.strictEqual(evaluateClauses([clause("value >= 0.5 && value <= 2.5")], 3.5).kind, "invalid");
    assert.strictEqual(evaluateClauses([clause("value >= 0")], -0).kind, "valid");
    assert.strictEqual(evaluateClauses([clause("value.length === 4")], "ab c").kind, "valid");
    assert.strictEqual(evaluateClauses([clause("value.length > 0")], "").kind, "invalid");
    assert.strictEqual(
      evaluateClauses([clause('new globalThis.RegExp("^(?:" + "[a-z]+" + ")$").test(value)')], 'a"; x').kind,
      "invalid",
    );
    assert.strictEqual(
      evaluateClauses([clause('new globalThis.RegExp("^(?:" + "[a-z]+" + ")$").test(value)')], "abc").kind,
      "valid",
    );
  });

  describe("hostile payloads return within the time limit", () => {
    // Hostile code that hangs inside the context is stopped as a timeout; one that
    // only throws, or breaks out of its wrapper, is an error. Neither hangs the host.
    const bounded = (check: string, expected: "timeout" | "throws"): void => {
      const t0 = Date.now();
      let kind = "none";
      try {
        kind = evaluateClauses([clause(check)], "a", 100).kind;
      } catch {
        kind = "throws";
      }
      assert.ok(Date.now() - t0 < 2000, `${check} took ${Date.now() - t0}ms`);
      assert.strictEqual(kind, expected, check);
    };

    it("a queued microtask loop", () => {
      bounded("(Promise.resolve().then(function () { for (;;) {} }), true)", "timeout");
    });

    it("a thrown object with a hostile getter", () => {
      bounded('(function () { throw { get code() { for (;;) {} }, get name() { for (;;) {} } }; })()', "timeout");
    });

    it("a thrown object with a hostile toString", () => {
      bounded('(function () { throw { toString: function () { for (;;) {} } }; })()', "throws");
    });

    it("a thrown Proxy", () => {
      bounded('(function () { throw new Proxy({}, { get: function () { for (;;) {} }, getPrototypeOf: function () { for (;;) {} } }); })()', "timeout");
    });

    it("a predicate that breaks out of its wrapper and throws a hostile value", () => {
      bounded('true; })(); throw { get code() { for (;;) {} } }; (function () { 1', "throws");
    });

    it("a syntax error is not a timeout", () => {
      bounded("value >=", "throws");
    });
  });

  it("the Error binding cannot be replaced", () => {
    assert.strictEqual(evaluateClauses([clause('(function () { Error = 1; return typeof Error === "function"; })()')], "a").kind, "valid");
  });
});
