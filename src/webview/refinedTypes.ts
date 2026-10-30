// #2470: hand-mirrored TS types for `bynk-lsp`'s `bynk/refinedTypeModel` wire
// shape (`bynk-lsp/src/refined_request.rs`) and the messages the explorer panel
// and its host exchange. Maintained by hand alongside the Rust side, as
// `explainTypes.ts` is.

/** A clause's condition, as `bynk/refinedTypeModel` sends it. `Int` bounds are
 *  JSON integers and `Float` bounds finite numbers; lengths are UTF-16 code
 *  units; `pattern` is raw and holds over the whole string. */
export type Predicate =
  | { kind: "nonNegative" }
  | { kind: "positive" }
  | { kind: "range"; min: number; max: number }
  | { kind: "nonEmpty" }
  | { kind: "minLength"; length: number }
  | { kind: "maxLength"; length: number }
  | { kind: "length"; length: number }
  | { kind: "matches"; pattern: string };

/** One predicate of a refinement. */
export interface RefinedClause {
  /** As written: `InRange(1, 100)`. */
  source: string;
  /** In words: `1 ≤ value ≤ 100`. */
  description: string;
  /** The condition in structured form (bynk v0.443.0 and newer). Absent from an
   *  older server, which sent only a JavaScript `check` string the extension
   *  no longer runs. */
  predicate?: Predicate;
  /** The emitter's failure message, as `.of` reports it. */
  message: string;
}

export interface RefinedModel {
  name: string;
  /** How a candidate is read: `Int`, `Float` or `String`. */
  base: "Int" | "Float" | "String";
  opaque: boolean;
  declaration: string;
  /** In the order the runtime checks them (a `Matches` last). */
  clauses: RefinedClause[];
  /** Candidate input texts; a string example is its own text. */
  examples: string[];
  examplesNote: string | null;
  seed: number;
}

/** What the explorer webview reads from `window.__BYNK_REFINED__`. */
export interface RefinedPayload {
  model: RefinedModel;
}

/** The verdict on one candidate. */
export type CandidateVerdict =
  /** The text is not a value of the base type, so no clause was run. */
  | { kind: "unreadable"; message: string }
  | { kind: "valid" }
  /** Every failing clause, in check order. */
  | { kind: "invalid"; failures: Array<{ source: string; message: string }> }
  /** Some clause could not be checked (no `predicate` from an older server, or
   *  a pattern the engine rejects); `failures` are the clauses that did fail. */
  | {
      kind: "unchecked";
      failures: Array<{ source: string; message: string }>;
      unchecked: Array<{ source: string; reason: string }>;
    }
  | { kind: "timeout" };

/** Webview → host. */
export interface CheckMessage {
  type: "check";
  text: string;
}

/** Host → webview. */
export interface VerdictMessage {
  type: "verdict";
  text: string;
  verdict: CandidateVerdict;
}
