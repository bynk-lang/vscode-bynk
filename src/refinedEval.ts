// #2470: checks a candidate against a refined type's clauses, for the explorer
// panel (`refinedExplorer.ts`). Pure of `vscode`, so it unit-tests directly.
//
// Each clause carries `predicate`, its condition in structured form (#35,
// bynk-lang/bynk#2588), interpreted here without running any server-supplied
// code. The one thing still run is a `matches` pattern as a regular
// expression: user-written, and able to backtrack without end, so only that
// test runs in a `node:vm` context under a time limit (a RegExp cannot be
// interrupted on the host thread). The pattern and value go in as strings.

import * as vm from "node:vm";

import type { CandidateVerdict, RefinedClause, RefinedModel } from "./webview/refinedTypes";

/** How long one pattern may run. */
export const CLAUSE_TIMEOUT_MS = 250;

/** The first server release that sends `predicate`. */
export const PREDICATE_MIN_VERSION = "v0.443.0";

const INT_MIN = -(2n ** 63n);
const INT_MAX = 2n ** 63n - 1n;

/** Read `text` as a value of `base`, as a hand-typed candidate. A `String` is
 *  taken verbatim — spaces count — and an `Int` is a `bigint`, as the emitted
 *  code holds one. */
export function parseCandidate(
  base: RefinedModel["base"],
  text: string,
): { ok: true; value: bigint | number | string } | { ok: false; message: string } {
  const t = text.trim();
  switch (base) {
    case "String":
      return { ok: true, value: text };
    case "Int": {
      if (!/^[+-]?\d+$/.test(t)) return { ok: false, message: "Not an Int: write a whole number." };
      const n = BigInt(t);
      if (n < INT_MIN || n > INT_MAX) return { ok: false, message: "Outside the 64-bit Int range." };
      return { ok: true, value: n };
    }
    case "Float": {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
        return { ok: false, message: "Not a Float: write a decimal number." };
      }
      const n = Number(t);
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, message: "Not a finite Float." };
    }
  }
}

type Value = bigint | number | string;
const NEEDS_NEWER = `needs bynk ${PREDICATE_MIN_VERSION} or newer`;

type ClauseOutcome = "holds" | "fails" | "timeout" | { unchecked: string };

/** A JSON bound as a `bigint`, only when it is exact. `Int` bounds beyond 2^53
 *  reach here already rounded to a double (JSON.parse, in the language client),
 *  so a larger one is not trusted: a different bound could have rounded to it. */
function intBound(n: unknown): bigint | undefined {
  return typeof n === "number" && Number.isSafeInteger(n) ? BigInt(n) : undefined;
}

function lengthOf(n: unknown): number | undefined {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Whether `value` matches `^(?:pattern)$`. Only this runs in a context: a null-
 *  prototype global holding two strings, no string codegen, and a time limit
 *  that also covers queued microtasks. The result is a number, never an object. */
function matchesPattern(pattern: string, value: string, timeoutMs: number): "holds" | "fails" | "timeout" | { unchecked: string } {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const sandbox = vm.runInContext("globalThis", context) as Record<string, unknown>;
  sandbox.pattern = pattern;
  sandbox.value = value;
  let outcome: unknown;
  try {
    outcome = vm.runInContext(
      `(function () { try { return new RegExp("^(?:" + pattern + ")$").test(value) ? 1 : 0; }` + ` catch (e) { return 2; } })()`,
      context,
      { timeout: timeoutMs },
    );
  } catch (err) {
    // Only the time limit stops a script that cannot throw; a thrown value is not read.
    return (err as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
      ? "timeout"
      : { unchecked: "the pattern could not be run" };
  }
  if (outcome === 1) return "holds";
  if (outcome === 0) return "fails";
  return { unchecked: "the pattern is not a valid regular expression" };
}

function evaluateClause(clause: RefinedClause, value: Value, timeoutMs: number): ClauseOutcome {
  const p = clause.predicate;
  if (p === undefined || p === null || typeof p !== "object") {
    return { unchecked: NEEDS_NEWER };
  }
  const notApplicable = { unchecked: "the condition does not apply to this type" };
  switch (p.kind) {
    case "nonNegative":
    case "positive": {
      if (typeof value === "string") return notApplicable;
      const ok = p.kind === "positive" ? (typeof value === "bigint" ? value > 0n : value > 0) : typeof value === "bigint" ? value >= 0n : value >= 0;
      return ok ? "holds" : "fails";
    }
    case "range": {
      if (typeof value === "bigint") {
        const min = intBound(p.min);
        const max = intBound(p.max);
        if (min === undefined || max === undefined) return { unchecked: "a bound is too large to check exactly" };
        return value >= min && value <= max ? "holds" : "fails";
      }
      if (typeof value === "number") {
        if (typeof p.min !== "number" || typeof p.max !== "number") return { unchecked: "the bounds are not numbers" };
        return value >= p.min && value <= p.max ? "holds" : "fails";
      }
      return notApplicable;
    }
    case "nonEmpty":
      return typeof value === "string" ? (value.length > 0 ? "holds" : "fails") : notApplicable;
    case "minLength":
    case "maxLength":
    case "length": {
      if (typeof value !== "string") return notApplicable;
      const n = lengthOf(p.length);
      if (n === undefined) return { unchecked: "the length is not a whole number" };
      const ok = p.kind === "minLength" ? value.length >= n : p.kind === "maxLength" ? value.length <= n : value.length === n;
      return ok ? "holds" : "fails";
    }
    case "matches":
      if (typeof value !== "string") return notApplicable;
      if (typeof p.pattern !== "string") return { unchecked: "the pattern is not text" };
      return matchesPattern(p.pattern, value, timeoutMs);
    default:
      // A form this extension predates.
      return { unchecked: `needs a newer extension (unknown condition)` };
  }
}

/** Evaluate every clause against `value`; all failures are reported. */
export function evaluateClauses(
  clauses: readonly RefinedClause[],
  value: Value,
  timeoutMs: number = CLAUSE_TIMEOUT_MS,
): CandidateVerdict {
  const failures: Array<{ source: string; message: string }> = [];
  const unchecked: Array<{ source: string; reason: string }> = [];
  for (const clause of clauses) {
    const outcome = evaluateClause(clause, value, timeoutMs);
    if (outcome === "timeout") return { kind: "timeout" };
    if (outcome === "fails") failures.push({ source: clause.source, message: clause.message });
    else if (outcome !== "holds") {
      // An older server leaves every clause without a predicate: say so once.
      const prior = outcome.unchecked === NEEDS_NEWER ? unchecked.find((u) => u.reason === NEEDS_NEWER) : undefined;
      if (prior) prior.source += `, ${clause.source}`;
      else unchecked.push({ source: clause.source, reason: outcome.unchecked });
    }
  }
  if (unchecked.length > 0) return { kind: "unchecked", failures, unchecked };
  return failures.length === 0 ? { kind: "valid" } : { kind: "invalid", failures };
}

/** The panel's check: read the text, then run the clauses. */
export function checkCandidate(model: RefinedModel, text: string): CandidateVerdict {
  const parsed = parseCandidate(model.base, text);
  if (!parsed.ok) return { kind: "unreadable", message: parsed.message };
  return evaluateClauses(model.clauses, parsed.value);
}
