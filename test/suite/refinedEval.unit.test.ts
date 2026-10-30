// #2470, #35: the explorer's candidate check, over every predicate form in
// `book/reference/refined-types.md`, interpreted from the structured
// `predicate` bynk-lang/bynk#2588 sends.

import * as assert from "assert";

import { checkCandidate, evaluateClauses, parseCandidate } from "../../src/refinedEval";
import type { Predicate, RefinedClause, RefinedModel } from "../../src/webview/refinedTypes";

function clause(source: string, predicate: Predicate | undefined, message = "no"): RefinedClause {
  return { source, description: "", predicate, message };
}

function model(base: RefinedModel["base"], clauses: RefinedClause[]): RefinedModel {
  return { name: "T", base, opaque: false, declaration: "", clauses, examples: [], examplesNote: null, seed: 0 };
}

const NON_NEGATIVE = clause("NonNegative", { kind: "nonNegative" }, "must be non-negative");
const POSITIVE = clause("Positive", { kind: "positive" }, "must be positive");
const IN_RANGE = clause("InRange(1, 100)", { kind: "range", min: 1, max: 100 }, "must be in range [1, 100]");
const IN_RANGE_F = clause("InRange(0.5, 2.5)", { kind: "range", min: 0.5, max: 2.5 }, "must be in range [0.5, 2.5]");
const NON_EMPTY = clause("NonEmpty", { kind: "nonEmpty" }, "must be non-empty");
const MIN_LENGTH = clause("MinLength(3)", { kind: "minLength", length: 3 }, "length must be at least 3");
const MAX_LENGTH = clause("MaxLength(5)", { kind: "maxLength", length: 5 }, "length must be at most 5");
const LENGTH = clause("Length(4)", { kind: "length", length: 4 }, "length must be exactly 4");
const MATCHES = clause("Matches(\"[a-z]+\")", { kind: "matches", pattern: "[a-z]+" }, "must match /[a-z]+/");

function failed(m: RefinedModel, text: string): string[] {
  const v = checkCandidate(m, text);
  assert.strictEqual(v.kind, "invalid", `${text} should fail`);
  return v.kind === "invalid" ? v.failures.map((f) => f.source) : [];
}

describe("refinedEval (unit)", () => {
  it("NonNegative", () => {
    const m = model("Int", [NON_NEGATIVE]);
    assert.strictEqual(checkCandidate(m, "0").kind, "valid");
    assert.deepStrictEqual(failed(m, "-1"), ["NonNegative"]);
    const f = model("Float", [NON_NEGATIVE]);
    assert.strictEqual(checkCandidate(f, "-0").kind, "valid");
    assert.deepStrictEqual(failed(f, "-0.5"), ["NonNegative"]);
  });

  it("Positive", () => {
    const m = model("Int", [POSITIVE]);
    assert.strictEqual(checkCandidate(m, "1").kind, "valid");
    assert.deepStrictEqual(failed(m, "0"), ["Positive"]);
    assert.deepStrictEqual(failed(model("Float", [POSITIVE]), "0"), ["Positive"]);
  });

  it("InRange over Int, inclusive at both ends", () => {
    const m = model("Int", [IN_RANGE]);
    for (const ok of ["1", "100", " 50 ", "+7"]) assert.strictEqual(checkCandidate(m, ok).kind, "valid", ok);
    for (const bad of ["0", "101", "-3"]) assert.deepStrictEqual(failed(m, bad), ["InRange(1, 100)"]);
  });

  it("InRange over Int compares as a bigint within ±2^53", () => {
    const m = model("Int", [clause("InRange(0, 2^53-1)", { kind: "range", min: 0, max: Number.MAX_SAFE_INTEGER })]);
    assert.strictEqual(checkCandidate(m, "9007199254740991").kind, "valid");
    assert.strictEqual(checkCandidate(m, "9007199254740992").kind, "invalid");
  });

  it("an Int bound beyond 2^53 is already rounded, so it is not trusted", () => {
    // JSON.parse("-9223372036854775807") is -2^63: accepting -2^63 would be wrong.
    const min = JSON.parse("-9223372036854775807") as number;
    const lower = model("Int", [clause("InRange(-(2^63-1), 0)", { kind: "range", min, max: 0 })]);
    assert.strictEqual(checkCandidate(lower, "-9223372036854775808").kind, "unchecked");
    const max = JSON.parse("9007199254740993") as number;
    const upper = model("Int", [clause("InRange(0, 2^53+1)", { kind: "range", min: 0, max })]);
    assert.strictEqual(checkCandidate(upper, "9007199254740993").kind, "unchecked");
    const full = model("Int", [clause("InRange(min, max)", { kind: "range", min: -(2 ** 63), max: 2 ** 63 })]);
    assert.strictEqual(checkCandidate(full, "0").kind, "unchecked");
  });

  it("an Int range with a fractional bound cannot be checked", () => {
    const m = model("Int", [clause("odd", { kind: "range", min: 0.5, max: 2 })]);
    assert.strictEqual(checkCandidate(m, "1").kind, "unchecked");
  });

  it("InRange over Float", () => {
    const m = model("Float", [IN_RANGE_F]);
    for (const ok of ["0.5", "2.5", "1", "1e0"]) assert.strictEqual(checkCandidate(m, ok).kind, "valid", ok);
    for (const bad of ["0.49", "2.51"]) assert.deepStrictEqual(failed(m, bad), ["InRange(0.5, 2.5)"]);
  });

  it("NonEmpty, MinLength, MaxLength and Length", () => {
    assert.strictEqual(checkCandidate(model("String", [NON_EMPTY]), "a").kind, "valid");
    assert.deepStrictEqual(failed(model("String", [NON_EMPTY]), ""), ["NonEmpty"]);
    assert.strictEqual(checkCandidate(model("String", [MIN_LENGTH]), "abc").kind, "valid");
    assert.deepStrictEqual(failed(model("String", [MIN_LENGTH]), "ab"), ["MinLength(3)"]);
    assert.strictEqual(checkCandidate(model("String", [MAX_LENGTH]), "abcde").kind, "valid");
    assert.deepStrictEqual(failed(model("String", [MAX_LENGTH]), "abcdef"), ["MaxLength(5)"]);
    assert.strictEqual(checkCandidate(model("String", [LENGTH]), "abcd").kind, "valid");
    assert.deepStrictEqual(failed(model("String", [LENGTH]), "abc"), ["Length(4)"]);
  });

  it("lengths count UTF-16 code units: an astral character is two", () => {
    const astral = "😀"; // U+1F600, one code point, two code units
    assert.strictEqual(astral.length, 2);
    assert.strictEqual(checkCandidate(model("String", [clause("Length(2)", { kind: "length", length: 2 })]), astral).kind, "valid");
    assert.strictEqual(checkCandidate(model("String", [clause("Length(1)", { kind: "length", length: 1 })]), astral).kind, "invalid");
    assert.strictEqual(checkCandidate(model("String", [clause("MaxLength(1)", { kind: "maxLength", length: 1 })]), astral).kind, "invalid");
    assert.strictEqual(checkCandidate(model("String", [clause("MinLength(2)", { kind: "minLength", length: 2 })]), astral).kind, "valid");
  });

  it("Matches is anchored to the whole string, not a partial match", () => {
    const m = model("String", [MATCHES]);
    assert.strictEqual(checkCandidate(m, "abc").kind, "valid");
    assert.deepStrictEqual(failed(m, "abc1"), ["Matches(\"[a-z]+\")"]);
    assert.deepStrictEqual(failed(m, "1abc"), ["Matches(\"[a-z]+\")"]);
    assert.deepStrictEqual(failed(m, ""), ["Matches(\"[a-z]+\")"]);
  });

  it("Matches anchors a top-level alternation as a whole", () => {
    const m = model("String", [clause("alt", { kind: "matches", pattern: "a|b" })]);
    assert.strictEqual(checkCandidate(m, "b").kind, "valid");
    assert.strictEqual(checkCandidate(m, "ab").kind, "invalid");
  });

  it("Matches takes no flags", () => {
    const m = model("String", [MATCHES]);
    assert.strictEqual(checkCandidate(m, "ABC").kind, "invalid");
  });

  it("an invalid pattern is reported as not checkable, not as a failure", () => {
    const v = checkCandidate(model("String", [clause("Matches(\"(\")", { kind: "matches", pattern: "(" })]), "abc");
    assert.strictEqual(v.kind, "unchecked");
    assert.ok(v.kind === "unchecked" && v.unchecked[0].source === "Matches(\"(\")" && v.unchecked[0].reason.includes("not a valid"));
  });

  it("a catastrophic pattern times out rather than hanging", () => {
    const evil = model("String", [clause("evil", { kind: "matches", pattern: "(a+)+$" })]);
    const started = Date.now();
    const v = evaluateClauses(evil.clauses, "a".repeat(40) + "!", 100);
    assert.strictEqual(v.kind, "timeout");
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
    // The host still works afterwards.
    assert.strictEqual(checkCandidate(model("String", [MATCHES]), "abc").kind, "valid");
  });

  it("a clause with no predicate (an older server) needs a newer bynk", () => {
    const old: RefinedClause = { source: "Positive", description: "", message: "no", ...({ check: "value > 0" } as object) };
    const v = checkCandidate(model("Int", [old]), "5");
    assert.strictEqual(v.kind, "unchecked");
    assert.ok(v.kind === "unchecked" && /needs bynk v\d+\.\d+\.\d+ or newer/.test(v.unchecked[0].reason));
    // Other clauses are still checked, and a failure is still reported.
    const mixed = checkCandidate(model("Int", [old, POSITIVE]), "-5");
    assert.ok(mixed.kind === "unchecked" && mixed.failures.length === 1 && mixed.unchecked.length === 1);
    // The message appears once, naming every clause it covers.
    const two = checkCandidate(model("Int", [old, { ...old, source: "NonNegative" }]), "5");
    assert.ok(two.kind === "unchecked" && two.unchecked.length === 1 && two.unchecked[0].source === "Positive, NonNegative");
  });

  it("an unknown predicate kind is not checked", () => {
    const odd = clause("x", { kind: "palindrome" } as unknown as Predicate);
    assert.strictEqual(checkCandidate(model("Int", [odd]), "1").kind, "unchecked");
  });

  it("a predicate that does not fit the base type is not checked", () => {
    assert.strictEqual(checkCandidate(model("String", [POSITIVE]), "a").kind, "unchecked");
    assert.strictEqual(checkCandidate(model("Int", [NON_EMPTY]), "1").kind, "unchecked");
    assert.strictEqual(checkCandidate(model("Int", [MATCHES]), "1").kind, "unchecked");
  });

  it("malformed lengths and bounds are not checked", () => {
    const bad = (p: object) => checkCandidate(model("String", [clause("x", p as Predicate)]), "abc").kind;
    assert.strictEqual(bad({ kind: "length", length: -1 }), "unchecked");
    assert.strictEqual(bad({ kind: "length", length: "3" }), "unchecked");
    assert.strictEqual(bad({ kind: "matches", pattern: 5 }), "unchecked");
  });

  it("a string candidate is taken verbatim, spaces included", () => {
    assert.strictEqual(checkCandidate(model("String", [MIN_LENGTH]), "   ").kind, "valid");
  });

  it("every failing clause is named, in check order", () => {
    const m = model("String", [MIN_LENGTH, MATCHES]);
    assert.deepStrictEqual(failed(m, "A"), ["MinLength(3)", "Matches(\"[a-z]+\")"]);
    assert.deepStrictEqual(failed(m, "ABC"), ["Matches(\"[a-z]+\")"]);
    const v = checkCandidate(m, "A");
    assert.ok(v.kind === "invalid" && v.failures[0].message === "length must be at least 3");
  });

  it("unreadable candidates run no clause", () => {
    assert.strictEqual(checkCandidate(model("Int", [POSITIVE]), "abc").kind, "unreadable");
    assert.strictEqual(checkCandidate(model("Int", [POSITIVE]), "1.5").kind, "unreadable");
    assert.strictEqual(checkCandidate(model("Int", [POSITIVE]), "").kind, "unreadable");
    assert.strictEqual(checkCandidate(model("Int", [POSITIVE]), "9223372036854775808").kind, "unreadable");
    assert.strictEqual(checkCandidate(model("Float", [NON_NEGATIVE]), "NaN").kind, "unreadable");
    assert.strictEqual(checkCandidate(model("Float", [NON_NEGATIVE]), "1e999").kind, "unreadable");
  });

  it("parseCandidate reads each base", () => {
    assert.deepStrictEqual(parseCandidate("Int", "-12"), { ok: true, value: -12n });
    assert.deepStrictEqual(parseCandidate("Float", ".5"), { ok: true, value: 0.5 });
    assert.deepStrictEqual(parseCandidate("String", " x "), { ok: true, value: " x " });
  });
});
