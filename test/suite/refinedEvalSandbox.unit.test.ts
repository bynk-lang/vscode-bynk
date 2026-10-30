// #35: nothing the server sends is executed. A clause is data (`predicate`),
// interpreted by `refinedEval.ts`; the only code run is the fixed `RegExp` test
// for a `matches` pattern, in a locked-down context. These pin that hostile
// strings in every field stay inert, and that the pattern test cannot reach
// the host or outlive its time limit.

import * as assert from "assert";

import { evaluateClauses } from "../../src/refinedEval";
import type { Predicate, RefinedClause } from "../../src/webview/refinedTypes";

const CODE = 'this.constructor.constructor("return process")().exit(1)';

function clause(predicate: unknown, extra: object = {}): RefinedClause {
  return { source: "x", description: "", message: "no", predicate: predicate as Predicate, ...extra };
}

afterEach(() => {
  delete (globalThis as { pwned?: number }).pwned;
});

describe("refinedEval sandbox (unit)", () => {
  it("a legacy `check` string is never evaluated", () => {
    const c = clause(undefined, { check: "(globalThis.pwned = 1) === 1" });
    assert.strictEqual(evaluateClauses([c], "a").kind, "unchecked");
    assert.strictEqual((globalThis as { pwned?: number }).pwned, undefined);
  });

  it("code in the source, message and description is only text", () => {
    const c = { source: CODE, description: CODE, message: CODE, predicate: { kind: "nonEmpty" } } as RefinedClause;
    assert.strictEqual(evaluateClauses([c], "a").kind, "valid");
    const v = evaluateClauses([c], "");
    assert.ok(v.kind === "invalid" && v.failures[0].message === CODE);
  });

  it("code in a bound or length is not run", () => {
    const hostile = [CODE, { valueOf: () => (globalThis as { pwned?: number }).pwned = 1 }];
    for (const h of hostile) {
      evaluateClauses([clause({ kind: "range", min: h, max: h })], 1n);
      evaluateClauses([clause({ kind: "range", min: h, max: h })], 1);
      evaluateClauses([clause({ kind: "length", length: h })], "a");
    }
    assert.strictEqual((globalThis as { pwned?: number }).pwned, undefined);
  });

  it("a pattern that is JavaScript source is only a pattern", () => {
    const sneaky = ['"); globalThis.pwned = 1; ("', "a\\", ".*)$|(?:", "${CODE}"];
    for (const pattern of sneaky) evaluateClauses([clause({ kind: "matches", pattern })], 'a"; x');
    assert.strictEqual((globalThis as { pwned?: number }).pwned, undefined);
  });

  it("a candidate is only ever a value, never code", () => {
    const m = clause({ kind: "matches", pattern: "[a-z]+" });
    for (const text of ["1); process.exit(1); (", "`${process.exit(1)}`", '"; process.exit(1); "', "0 || (globalThis.pwned = 1)"]) {
      const v = evaluateClauses([m], text);
      assert.strictEqual(v.kind, "invalid", text);
    }
    assert.strictEqual((globalThis as { pwned?: number }).pwned, undefined);
  });

  it("the pattern is not given a way to the host realm", () => {
    // `[^]` matches the stringified value; if `process` or `require` were in scope a
    // pattern still cannot call them, and a lookalike value stays a string.
    const v = evaluateClauses([clause({ kind: "matches", pattern: ".*" })], "typeof process");
    assert.strictEqual(v.kind, "valid");
  });

  it("an unterminated-regex-cost pattern times out, then the next check runs", () => {
    const evil = clause({ kind: "matches", pattern: "(x+x+)+y" });
    const t0 = Date.now();
    assert.strictEqual(evaluateClauses([evil], "x".repeat(60), 100).kind, "timeout");
    assert.ok(Date.now() - t0 < 3000);
    assert.strictEqual(evaluateClauses([clause({ kind: "matches", pattern: "x+" })], "xx", 100).kind, "valid");
  });

  it("a timeout in one clause ends the check, however the clauses are ordered", () => {
    const evil = clause({ kind: "matches", pattern: "(x+x+)+y" });
    const v = evaluateClauses([clause({ kind: "nonEmpty" }), evil], "x".repeat(60), 100);
    assert.strictEqual(v.kind, "timeout");
  });
});
