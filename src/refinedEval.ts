// #2470: checks a candidate against a refined type's clauses, for the explorer
// panel (`refinedExplorer.ts`). Pure of `vscode`, so it unit-tests directly.
//
// Each clause's `check` is the condition the emitter lowers for `.of`, printed
// by the server as a JavaScript expression over `value`. The server sends no
// structured form of it yet, so the text is run — a MITIGATION (#35), not a
// boundary: `node:vm` is not a sandbox, and safety still rests on the server
// emitting only the closed set of predicate forms (the one user-written part,
// a `Matches` pattern, sits inside a string literal). The real fix is the
// server sending predicates structurally, to be interpreted here without JS.
//
// Until then nothing from the host realm is reachable from the predicate: the
// context's global is a null-prototype object, `value` is built inside the
// context from a quoted literal (never a host object), `Error` is frozen so
// `prepareStackTrace` cannot be hooked, string `eval` is off, and a time limit
// stops a slow pattern hanging the extension host.

import * as vm from "node:vm";

import type { CandidateVerdict, RefinedClause, RefinedModel } from "./webview/refinedTypes";

/** How long one clause may run. */
export const CLAUSE_TIMEOUT_MS = 250;

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

/** Locks `Error` (so `prepareStackTrace` cannot be hooked) and its binding. */
const PRELUDE =
  '"use strict"; Object.freeze(Error);' +
  ' Object.defineProperty(globalThis, "Error", { value: Error, writable: false, configurable: false });';

/** `value` as source text for the context to evaluate, so the candidate is
 *  created inside it rather than passed in from the host. */
function valueLiteral(value: bigint | number | string): string {
  switch (typeof value) {
    case "bigint":
      return `${value}n`;
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    default:
      return JSON.stringify(value);
  }
}

/** Evaluate every clause against `value`; all failures are reported. */
export function evaluateClauses(
  clauses: readonly RefinedClause[],
  value: bigint | number | string,
  timeoutMs: number = CLAUSE_TIMEOUT_MS,
): CandidateVerdict {
  const failures: Array<{ source: string; message: string }> = [];
  const literal = valueLiteral(value);
  for (const clause of clauses) {
    // A null-prototype global: a host `Object` is no way to a host `Function`.
    // `afterEvaluate` runs queued microtasks inside the time limit, so a
    // `Promise.then` loop cannot outlive it.
    const context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      microtaskMode: "afterEvaluate",
    });
    let outcome: unknown;
    try {
      vm.runInContext(PRELUDE + `var value = ${literal};`, context, { timeout: timeoutMs });
      // The predicate's outcome is reduced to a primitive inside the context,
      // under the time limit: a thrown value is never handed to the host, which
      // would run its getters or `toString` unbounded.
      outcome = vm.runInContext(
        `(function () { try { return (${clause.check}) === true; }` +
          ` catch (e) { try { return "threw " + String(e && e.name).slice(0, 64); } catch (_) { return "threw"; } } })()`,
        context,
        { timeout: timeoutMs },
      );
    } catch {
      // Only a time-out (or a predicate that broke out of its wrapper) gets here.
      return { kind: "timeout" };
    }
    if (typeof outcome === "string") throw new Error(`the predicate ${outcome}`);
    const holds = outcome;
    if (holds !== true) failures.push({ source: clause.source, message: clause.message });
  }
  return failures.length === 0 ? { kind: "valid" } : { kind: "invalid", failures };
}

/** The panel's check: read the text, then run the clauses. */
export function checkCandidate(model: RefinedModel, text: string): CandidateVerdict {
  const parsed = parseCandidate(model.base, text);
  if (!parsed.ok) return { kind: "unreadable", message: parsed.message };
  try {
    return evaluateClauses(model.clauses, parsed.value);
  } catch (err) {
    // A clause that throws (a `Matches` pattern V8's `RegExp` rejects though the
    // compiler accepted it) still owes the panel an answer for this text.
    return { kind: "unreadable", message: `This value could not be checked: ${String(err)}` };
  }
}
