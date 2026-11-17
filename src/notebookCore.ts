// #151: Bynk notebooks, the pure part. No `vscode` import: the unit tests
// compile against it. `notebook.ts` is the editor side (the serializer, the
// controller that runs a cell, the commands).
//
// A notebook is a `.bynknb` file: JSON, with each cell's source as an array of
// lines so a diff shows the lines that changed. Outputs are not saved, so no
// value or stubbed data reaches the repository.
//
//     { "version": 1,
//       "unit": "shop.money",
//       "cells": [ { "kind": "markdown", "source": ["# Discounts"] },
//                  { "kind": "code", "source": ["discount(2000, 25)"] } ] }
//
// A code cell is an expression snippet for `bynk eval` (bynk-lang/bynk#3585,
// `bynk/src/cli.rs:24-49` at v0.639.1). Each evaluation there is independent
// ("send earlier cells' `let`s again ahead of the snippet",
// `bynk/src/cli.rs:659-661`), so this module builds that preamble: the
// top-level `let`s of the earlier cells that ran, ahead of the cell's own body,
// with the leading `consumes` and `stub` lines hoisted, because the CLI reads
// them only at the top of a snippet (`site/.../try-an-expression.md`, section 4).

export const NOTEBOOK_TYPE = "bynk-notebook";
export const NOTEBOOK_VERSION = 1;

// ---------------------------------------------------------------------------
// The file

export interface NbCell {
  kind: "markdown" | "code";
  source: string;
}

export interface Notebook {
  /** The unit a cell without its own `// @unit` runs in. */
  unit?: string;
  cells: NbCell[];
}

const UNIT_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function isUnitName(s: string): boolean {
  return UNIT_NAME.test(s);
}

/** Read a `.bynknb` file. An empty file is an empty notebook; anything else
 *  that isn't a notebook is an error to show, never a crash. */
export function parseNotebook(text: string): { notebook: Notebook } | { error: string } {
  if (text.trim() === "") return { notebook: { cells: [] } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `Not a Bynk notebook: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "Not a Bynk notebook: expected a JSON object." };
  const o = raw as Record<string, unknown>;
  if (typeof o.version === "number" && o.version > NOTEBOOK_VERSION) {
    return { error: `This notebook is version ${o.version}; this extension reads up to version ${NOTEBOOK_VERSION}. Update the Bynk extension.` };
  }
  if (!Array.isArray(o.cells)) return { error: 'Not a Bynk notebook: it has no "cells" array.' };
  const cells: NbCell[] = [];
  for (const [i, c] of o.cells.entries()) {
    if (c === null || typeof c !== "object") return { error: `Cell ${i + 1} is not an object.` };
    const cell = c as Record<string, unknown>;
    const kind = cell.kind === "markdown" ? "markdown" : cell.kind === "code" ? "code" : undefined;
    if (!kind) return { error: `Cell ${i + 1} has kind ${JSON.stringify(cell.kind) ?? "nothing"}; it must be "markdown" or "code".` };
    const src = cell.source;
    const source = typeof src === "string" ? src : Array.isArray(src) && src.every((l) => typeof l === "string") ? (src as string[]).join("\n") : undefined;
    if (source === undefined) return { error: `Cell ${i + 1}'s source must be a string or an array of lines.` };
    cells.push({ kind, source });
  }
  const unit = typeof o.unit === "string" && isUnitName(o.unit) ? o.unit : undefined;
  return { notebook: { unit, cells } };
}

/** A notebook as the text of its file. */
export function serializeNotebook(nb: Notebook): string {
  const doc: Record<string, unknown> = { version: NOTEBOOK_VERSION };
  if (nb.unit) doc.unit = nb.unit;
  doc.cells = nb.cells.map((c) => ({ kind: c.kind, source: c.source === "" ? [] : c.source.split("\n") }));
  return JSON.stringify(doc, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Statements

export interface Statement {
  /** The statement as written, from its first line to its last. */
  text: string;
  /** Zero-based first and last line within the source. */
  start: number;
  end: number;
}

/** The top-level statements of a snippet. A statement starts on a line with no
 *  indentation while no bracket or string is open, and goes on until the next
 *  such line: a `let` whose value spans lines (a record, a `match`, a chain
 *  that continues on an indented line) is one statement. Blank lines and `//`
 *  comments between statements belong to none. */
export function splitStatements(source: string): Statement[] {
  const lines = source.split("\n");
  const out: Statement[] = [];
  let depth = 0;
  let inString = false;
  let cur: { start: number; end: number } | undefined;
  const close = (): void => {
    if (!cur) return;
    out.push({ text: lines.slice(cur.start, cur.end + 1).join("\n"), start: cur.start, end: cur.end });
    cur = undefined;
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    const opening = depth === 0 && !inString;
    if (opening && t !== "" && !t.startsWith("//")) {
      // A line that closes what a statement opened, or continues one, is part of it.
      const continues = /^\s/.test(line) || /^[.|&)\]}]/.test(t) || /^(else|then)\b/.test(t);
      if (!(cur && continues)) {
        close();
        cur = { start: i, end: i };
      }
    }
    // A blank line or a comment between statements belongs to none.
    if (cur && t !== "" && !(opening && t.startsWith("//"))) cur.end = i;
    // Track brackets and strings across the line.
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (inString) {
        if (c === "\\") k++;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === "/" && line[k + 1] === "/") {
        break;
      } else if (c === "(" || c === "[" || c === "{") {
        depth++;
      } else if (c === ")" || c === "]" || c === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  });
  close();
  return out;
}

const HEADER = /^(consumes|stub)\b/;
const LET = /^let\b/;
/** `let x <- eff`: a binding that runs an effect (`let x: T <- eff` too). */
const EFFECT_LET = /^let\s+([A-Za-z_][A-Za-z0-9_]*)[^=]*?<-/;

export interface Cell {
  /** The unit named by a leading `// @unit`, if any. */
  unit?: string;
  /** The leading `consumes` and `stub` statements the suite owns. */
  header: Statement[];
  /** The statements after them, the first of which starts the case. */
  body: Statement[];
  /** The source, split into lines. */
  lines: string[];
}

const UNIT_DIRECTIVE = /^\s*\/\/\s*@unit\s+(\S+)\s*$/;

/** A code cell taken apart. The `// @unit` directive is read from the leading
 *  lines only (before the first statement that isn't a header). */
export function analyseCell(source: string): Cell {
  const lines = source.split("\n");
  const statements = splitStatements(source);
  const firstBody = statements.findIndex((s) => !HEADER.test(s.text.trimStart()));
  const header = firstBody < 0 ? statements : statements.slice(0, firstBody);
  const body = firstBody < 0 ? [] : statements.slice(firstBody);
  const limit = body.length > 0 ? body[0].start : lines.length;
  let unit: string | undefined;
  for (let i = 0; i < limit; i++) {
    const m = UNIT_DIRECTIVE.exec(lines[i]);
    if (m && isUnitName(m[1])) {
      unit = m[1];
      break;
    }
  }
  return { unit, header, body, lines };
}

/** The unit a cell runs in: its own directive, else the notebook's. */
export function unitFor(cell: Pick<Cell, "unit">, notebookUnit: string | undefined): string | undefined {
  return cell.unit ?? notebookUnit;
}

// ---------------------------------------------------------------------------
// What kind of cell
//
// A code cell is an expression cell unless it says otherwise in its leading
// comment lines. `cellKindOf` is the one place that decides, so a cell kind adds
// a directive and a case here and a branch where the editor side runs it.

export type CellKind =
  | { kind: "expression" }
  | { kind: "refined"; type: string }
  /** #191: ordinary Bynk source that calls a handler (`notebookHandlerCore.ts`). */
  | { kind: "handler" }
  | { kind: "bad-directive"; directive: string; problem: string };

const REFINED_DIRECTIVE = /^\s*\/\/\s*@refined(?:\s+(.*?))?\s*$/;
const HANDLER_DIRECTIVE = /^\s*\/\/\s*@handler(?:\s+(.*?))?\s*$/;
const TYPE_NAME = /^[A-Z][A-Za-z0-9_]*$/;

/** The kind of a code cell: a refined-type cell when a `// @refined Type` line
 *  comes before any code, a handler cell for `// @handler`, else an expression cell. A `// @refined` that doesn't
 *  name a type (`percent`, `money.Percent`, nothing) is `bad-directive`, so the
 *  cell is not quietly run as expressions. */
export function cellKindOf(source: string): CellKind {
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    if (!t.startsWith("//")) break;
    const h = HANDLER_DIRECTIVE.exec(line);
    if (h) {
      if (h[1] === undefined || h[1] === "") return { kind: "handler" };
      return { kind: "bad-directive", directive: t, problem: "`// @handler` takes nothing after it: write the `stub` lines and the call as ordinary Bynk below it." };
    }
    const m = REFINED_DIRECTIVE.exec(line);
    if (m) {
      const name = m[1] ?? "";
      if (TYPE_NAME.test(name)) return { kind: "refined", type: name };
      return { kind: "bad-directive", directive: t, problem: name === "" ? "`// @refined` needs the name of a refined type, as in `// @refined Percent`." : `\`${name}\` is not a type name: write \`// @refined\` followed by a type declared in the unit, starting with a capital letter (a qualified name is not accepted).` };
    }
  }
  return { kind: "expression" };
}

// ---------------------------------------------------------------------------
// Refined-type cells
//
//     // @refined Percent
//     50
//     150          // too big
//     -1
//
// The directive names the type; every other line that is not blank or a `//`
// comment is one candidate, an expression of the type's base type. They are
// checked by the real constructor, `Percent.of(…)`, in one `bynk eval` call.

export interface Candidate {
  /** The candidate as written, without a trailing comment. */
  text: string;
  /** Zero-based line in the cell. */
  line: number;
}

export interface RefinedCell {
  type: string;
  candidates: Candidate[];
}

/** Split a line into its code and a trailing `//` comment, ignoring `//` in a string. */
function splitComment(line: string): { code: string; comment: string } {
  let inString = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (inString) {
      if (c === "\\") k++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "/" && line[k + 1] === "/") return { code: line.slice(0, k), comment: line.slice(k) };
  }
  return { code: line, comment: "" };
}

/** The type and candidates of a refined-type cell; undefined for any other cell. */
export function analyseRefined(source: string): RefinedCell | undefined {
  const kind = cellKindOf(source);
  if (kind.kind !== "refined") return undefined;
  const candidates: Candidate[] = [];
  source.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t === "" || t.startsWith("//")) return;
    const { code } = splitComment(line);
    if (code.trim() !== "") candidates.push({ text: code.trim(), line: i });
  });
  return { type: kind.type, candidates };
}

/** The source to send for a refined-type cell in place of its own: the same
 *  lines, with the candidates (those not in `skip`, by line) turned into one
 *  list `[Type.of(a), Type.of(b)]`. Every line stays where it was, so a
 *  diagnostic's line is the candidate's own line in the cell. Returns the text
 *  and the candidates it holds, in order. */
export function refinedSource(source: string, cell: RefinedCell, skip: ReadonlySet<number> = new Set()): { text: string; sent: Candidate[] } {
  const sent = cell.candidates.filter((c) => !skip.has(c.line));
  const lines = source.split("\n").map((l) => {
    const t = l.trim();
    return t === "" || t.startsWith("//") ? l : "";
  });
  const comments = source.split("\n").map((l) => (l.trim().startsWith("//") ? "" : splitComment(l).comment));
  sent.forEach((c, i) => {
    const open = i === 0 ? "[" : "";
    const close = i === sent.length - 1 ? "]" : ",";
    lines[c.line] = `${open}${cell.type}.of(${c.text})${close}${comments[c.line] ? "  " + comments[c.line] : ""}`;
  });
  return { text: lines.join("\n"), sent };
}

export interface CandidateRow {
  candidate: Candidate;
  /** `accepted`, `refused` with the `ValidationError`, or `invalid` when the
   *  candidate does not type-check as the constructor's argument. */
  outcome: "accepted" | "refused" | "invalid";
  /** The accepted value, as Bynk writes it. */
  value?: string;
  /** For a refusal, the message of the `ValidationError` (the clause that refused it). */
  message?: string;
  field?: string;
}

/** One row per candidate from the list `bynk eval` returned for them, in the
 *  order they were sent. `undefined` when it is not a list of `Ok`/`Err` of that length. */
export function decodeRefined(sent: readonly Candidate[], value: unknown): CandidateRow[] | undefined {
  if (!Array.isArray(value) || value.length !== sent.length) return undefined;
  const rows: CandidateRow[] = [];
  for (const [i, v] of value.entries()) {
    if (v === null || typeof v !== "object") return undefined;
    const o = v as Record<string, unknown>;
    if (o.kind === "Ok") rows.push({ candidate: sent[i], outcome: "accepted", value: renderValue(o.value) });
    else if (o.kind === "Err" && o.error !== null && typeof o.error === "object") {
      const e = o.error as Record<string, unknown>;
      rows.push({ candidate: sent[i], outcome: "refused", message: typeof e.message === "string" ? e.message : "refused", field: typeof e.field === "string" ? e.field : undefined });
    } else return undefined;
  }
  return rows;
}

/** Whether the problems of a run are the candidates' own, and so the candidates
 *  can be set aside and the rest run again: every error is on a line a
 *  candidate was written on, in this cell. Any other error (an earlier cell's
 *  `let`, an unknown type, another file) would fail the rest too, so there is
 *  nothing to set aside. Returns the lines to skip and a row for each candidate
 *  (one row per candidate even when it has several errors, the first one's
 *  message), or undefined. */
export function setAside(placed: readonly CellDiagnostic[], sent: readonly Candidate[], index: number): { skip: Set<number>; invalid: CandidateRow[] } | undefined {
  const errors = placed.filter((d) => d.severity === "error");
  if (errors.length === 0) return undefined;
  const byLine = new Map(sent.map((c) => [c.line, c]));
  const skip = new Set<number>();
  const invalid: CandidateRow[] = [];
  for (const d of errors) {
    const c = d.cell === index && d.at !== undefined ? byLine.get(d.at) : undefined;
    if (!c) return undefined;
    if (skip.has(c.line)) continue;
    skip.add(c.line);
    invalid.push({ candidate: c, outcome: "invalid", message: d.message });
  }
  return { skip, invalid };
}

/** The rows of both calls in the order the candidates were written. */
export function mergeRows(...groups: readonly (readonly CandidateRow[] | undefined)[]): CandidateRow[] {
  return groups.flatMap((g) => g ?? []).sort((a, b) => a.candidate.line - b.candidate.line);
}

/** The rows as the cell's `application/json` output. */
export function refinedJson(type: string, rows: readonly CandidateRow[]): unknown {
  return {
    type,
    results: rows.map((r) => ({
      candidate: r.candidate.text,
      outcome: r.outcome,
      ...(r.value !== undefined ? { value: r.value } : {}),
      ...(r.message !== undefined ? { message: r.message } : {}),
      ...(r.field !== undefined ? { field: r.field } : {}),
    })),
  };
}

/** The rows as an aligned table, in the order the candidates were written. */
export function renderRefinedTable(type: string, rows: readonly CandidateRow[]): string {
  const sorted = [...rows].sort((a, b) => a.candidate.line - b.candidate.line);
  const status = (r: CandidateRow): string => (r.outcome === "accepted" ? "accepted" : r.outcome === "refused" ? "refused" : "does not check");
  const cw = Math.max(9, ...sorted.map((r) => r.candidate.text.length));
  const head = `${"candidate".padEnd(cw)}  ${"result".padEnd(14)}  why`;
  const body = sorted.map((r) => `${r.candidate.text.padEnd(cw)}  ${status(r).padEnd(14)}  ${r.message ?? ""}`.trimEnd());
  const nAccepted = sorted.filter((r) => r.outcome === "accepted").length;
  return [`${type}: ${nAccepted} of ${sorted.length} accepted`, "", head, ...body].join("\n");
}

// ---------------------------------------------------------------------------
// The snippet

/** Where a line of the snippet came from: a cell's index and its line there
 *  (zero-based). */
export interface Origin {
  cell: number;
  line: number;
}

export interface Snippet {
  text: string;
  /** For each snippet line, where it was written. */
  origins: Origin[];
  /** The earlier cells whose `let`s were sent ahead, by index. */
  used: number[];
  /** The `stub`s of earlier cells that apply to this one, each from the last
   *  cell that wrote one for its target. A cell's own `stub` for a target
   *  replaces an earlier cell's. */
  stubs: { target: string; cell: number }[];
  /** The `let x <- …` bindings among them: each runs again, since `bynk eval`
   *  keeps nothing, so a stub that counts calls or a `Clock` can answer
   *  differently than it did in the cell that first bound it. */
  rerun: { name: string; cell: number }[];
  /** Earlier cells in this unit with `let`s that were left out because they
   *  were edited after their last successful run. */
  skipped: number[];
}

export interface CellInput {
  /** The cell's source. */
  source: string;
  /** The unit it runs in: its own `// @unit`, else the notebook's. A cell whose
   *  unit is not known is "" and never matches. (`undefined` stands for the
   *  cell being run's own unit, which is for tests of this module.) */
  unit: string | undefined;
  /** Whether it has run without a problem since it was last edited. */
  ran: boolean;
  /** Whether it did run without a problem, but has been edited since. */
  edited?: boolean;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** What to send for the cell at `index`, running in `unit`.
 *
 *  1. The header: the `consumes` and `stub` lines of the earlier cells that
 *     send `let`s (what those `let`s need to run), then the cell's own, each
 *     `consumes` once and each `stub` target once, from the last cell that
 *     wrote one: the cell's own `stub` replaces an earlier cell's.
 *  2. The preamble: the top-level `let`s of the earlier cells that ran in the
 *     same unit, in order. Their last expression, `expect`s and bare effects are
 *     not replayed: only what they bound.
 *  3. The cell's own body, as written.
 *
 *  A cell that has not run, or has been edited since, contributes nothing: its
 *  `let`s may not hold. */
export function buildSnippet(cells: readonly CellInput[], index: number, unit: string): Snippet {
  const out: { text: string; origin: Origin }[] = [];
  const seen = new Set<string>();
  const used: number[] = [];
  const rerun: { name: string; cell: number }[] = [];
  const skipped: number[] = [];
  const earlier: { index: number; cell: Cell; lets: Statement[] }[] = [];
  for (let i = 0; i < index; i++) {
    const c = cells[i];
    if ((c.unit ?? unit) !== unit) continue;
    const cell = analyseCell(c.source);
    const lets = cell.body.filter((s) => LET.test(s.text.trimStart()));
    if (!c.ran) {
      // Say so when an edit is why its `let`s are missing, or a later cell's
      // "unknown name" would have no visible cause.
      if (c.edited && lets.length > 0) skipped.push(i);
      continue;
    }
    // Only a cell that sends `let`s contributes: its `consumes` and `stub`
    // lines are what those `let`s need to run, and nothing else of it is used.
    if (lets.length > 0) earlier.push({ index: i, cell, lets });
  }
  const current = analyseCell(cells[index].source);

  const push = (s: Statement, cell: number): void => {
    s.text.split("\n").forEach((text, k) => out.push({ text, origin: { cell, line: s.start + k } }));
  };
  // The header: `consumes` once each; a `stub` for a target once, from the last
  // cell that wrote one (the running cell's wins), so a later cell can
  // override an earlier cell's stub instead of adding a second one.
  const stubTarget = (h: Statement): string | undefined => /^stub\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(h.text.trimStart())?.[1];
  const sources = [...earlier.map((e) => ({ index: e.index, cell: e.cell })), { index, cell: current }];
  const lastStub = new Map<string, number>();
  for (const { index: i, cell } of sources) for (const h of cell.header) {
    const t = stubTarget(h);
    if (t) lastStub.set(t, i);
  }
  const stubs: { target: string; cell: number }[] = [];
  for (const { index: i, cell } of sources) {
    for (const h of cell.header) {
      const t = stubTarget(h);
      if (t && lastStub.get(t) !== i) continue;
      const key = squash(h.text);
      if (seen.has(key)) continue;
      seen.add(key);
      push(h, i);
      if (t && i !== index) stubs.push({ target: t, cell: i });
    }
  }
  for (const { index: i, lets } of earlier) {
    used.push(i);
    for (const s of lets) {
      push(s, i);
      const eff = EFFECT_LET.exec(s.text.trimStart());
      if (eff) rerun.push({ name: eff[1], cell: i });
    }
  }
  if (current.body.length > 0) {
    // The body as written, comments and blank lines among its statements included.
    const first = current.body[0].start;
    const last = current.body[current.body.length - 1].end;
    for (let l = first; l <= last; l++) out.push({ text: current.lines[l], origin: { cell: index, line: l } });
  }
  return { text: out.map((o) => o.text).join("\n"), origins: out.map((o) => o.origin), used, rerun, skipped, stubs };
}

/** The lines a cell's output adds about what was sent ahead of it. `label`
 *  names a cell the way the notebook shows it ("cell 3"). Never silent about a
 *  value that is run again, or a cell that was left out. */
export function snippetNotes(s: Pick<Snippet, "used" | "rerun" | "skipped"> & { stubs?: Snippet["stubs"] }, label: (cell: number) => string): string[] {
  const notes: string[] = [];
  if (s.used.length > 0) notes.push(`Used the \`let\`s of ${s.used.map(label).join(", ")}.`);
  for (const st of s.stubs ?? []) notes.push(`Applied \`stub ${st.target}\` from ${label(st.cell)}; write a \`stub\` for it in this cell to replace it.`);
  for (const r of s.rerun) notes.push(`Re-ran \`let ${r.name} <- …\` from ${label(r.cell)}; effectful values may differ from that cell's output.`);
  for (const i of s.skipped) notes.push(`Skipped ${label(i)}: edited since its last run, so its \`let\`s were not sent. Run it again to use them.`);
  return notes;
}

// ---------------------------------------------------------------------------
// Running

export interface EvalArgs {
  root: string;
  unit: string;
  /** `--suite`: build the unit's own unit-tier suite in, so its `stub`s and fixtures apply. */
  suite?: string;
  snippet: string;
  /** Pass `--sources-stdin`: unsaved buffers go on stdin. */
  sourcesStdin: boolean;
  /** `--timeout`, in seconds; the CLI's own default (60) when absent. */
  timeoutSeconds?: number;
}

/** The arguments of `bynk eval`. The snippet is always `--expr`, since stdin
 *  then holds the buffers (`bynk/src/cli.rs:36-40`). */
export function evalArgs(a: EvalArgs): string[] {
  // `--expr=` and not `--expr X`: a snippet that starts with `-` (`-5`) would be read as a flag.
  const args = ["eval", a.root, "--unit", a.unit, `--expr=${a.snippet}`];
  if (a.suite) args.push("--suite", a.suite);
  if (a.sourcesStdin) args.push("--sources-stdin");
  if (a.timeoutSeconds !== undefined) args.push("--timeout", String(Math.max(1, Math.floor(a.timeoutSeconds))));
  return args;
}

export interface EvalDiagnostic {
  /** 1-based, in the snippet. */
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  /** Set when the problem is in another file, with that file's own position. */
  file?: string;
}

export type EvalResult =
  | { kind: "value"; value: unknown; type: string; diagnostics: EvalDiagnostic[] }
  | { kind: "diagnostics"; diagnostics: EvalDiagnostic[] }
  | { kind: "error"; errorKind: "runtime" | "timeout" | "setup" | "unreadable"; message: string; diagnostics: EvalDiagnostic[] };

function diagnosticsOf(raw: unknown): EvalDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: EvalDiagnostic[] = [];
  for (const d of raw) {
    if (d === null || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    if (typeof o.message !== "string") continue;
    const severity = o.severity === "warning" ? "warning" : o.severity === "info" ? "info" : "error";
    out.push({
      line: typeof o.line === "number" ? o.line : 1,
      col: typeof o.col === "number" ? o.col : 1,
      severity,
      code: typeof o.code === "string" ? o.code : "",
      message: o.message,
      file: typeof o.file === "string" ? o.file : undefined,
    });
  }
  return out;
}

/** What `bynk eval` printed (`site/.../bynk-cli.md`, "bynk eval": one JSON
 *  document, `value`/`type`/`diagnostics`, or `error` with a `kind`). Anything
 *  else is `unreadable`, with what the process said. */
export function decodeEval(stdout: string, stderr: string, code: number | null): EvalResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    const said = (stderr || stdout).trim().split("\n")[0];
    return { kind: "error", errorKind: "unreadable", message: said ? `bynk eval: ${said}` : `bynk eval exited with ${code === null ? "a signal" : code} and printed no result.`, diagnostics: [] };
  }
  if (raw === null || typeof raw !== "object") return { kind: "error", errorKind: "unreadable", message: "bynk eval printed something that is not a result.", diagnostics: [] };
  const o = raw as Record<string, unknown>;
  const diagnostics = diagnosticsOf(o.diagnostics);
  const err = o.error;
  if (err !== null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const k = e.kind === "timeout" ? "timeout" : e.kind === "setup" ? "setup" : "runtime";
    return { kind: "error", errorKind: k, message: typeof e.message === "string" ? e.message : "The evaluation failed.", diagnostics };
  }
  if ("value" in o && o.value !== null && typeof o.type === "string") return { kind: "value", value: o.value, type: o.type, diagnostics };
  // A `null` value with a type is the unit value.
  if ("value" in o && typeof o.type === "string") return { kind: "value", value: null, type: o.type, diagnostics };
  return { kind: "diagnostics", diagnostics };
}

// ---------------------------------------------------------------------------
// Diagnostics

export interface CellDiagnostic extends EvalDiagnostic {
  /** The cell the problem is in, and its zero-based line there; undefined for a problem in another file. */
  cell?: number;
  at?: number;
}

/** Each diagnostic placed in the cell that wrote the line it names: the
 *  preamble's lines belong to earlier cells. */
export function placeDiagnostics(diagnostics: readonly EvalDiagnostic[], origins: readonly Origin[]): CellDiagnostic[] {
  return diagnostics.map((d) => {
    if (d.file !== undefined) return d;
    const o = origins[d.line - 1];
    return o ? { ...d, cell: o.cell, at: o.line } : d;
  });
}

// ---------------------------------------------------------------------------
// Showing a value

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WIDTH = 72;

/** A wire value as Bynk writes it: `Ok(25)`, `Some(3)`, `Err({ field: "Percent", … })`,
 *  a record as `{ a: 1 }`, a list as `[1, 2]`. A sum variant is the object
 *  `{ kind: "Name", …fields }` on the wire (`Json.encode`); a lone `value` or
 *  `error` field is its payload. Wraps long values over lines. */
export function renderValue(value: unknown, indent = ""): string {
  const flat = flatten(value);
  if (flat.length + indent.length <= WIDTH || !hasChildren(value)) return flat;
  return spread(value, indent);
}

function hasChildren(v: unknown): boolean {
  return v !== null && typeof v === "object" && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
}

function isVariant(o: Record<string, unknown>): o is Record<string, unknown> & { kind: string } {
  return typeof o.kind === "string" && /^[A-Z][A-Za-z0-9_]*$/.test(o.kind);
}

function fields(o: Record<string, unknown>, skipKind: boolean): [string, unknown][] {
  return Object.entries(o)
    .filter(([k]) => !(skipKind && k === "kind"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const key = (k: string): string => (IDENT.test(k) ? k : JSON.stringify(k));

function flatten(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return `[${v.map(flatten).join(", ")}]`;
  const o = v as Record<string, unknown>;
  if (isVariant(o)) {
    const fs = fields(o, true);
    if (fs.length === 0) return o.kind;
    if (fs.length === 1 && (fs[0][0] === "value" || fs[0][0] === "error")) return `${o.kind}(${flatten(fs[0][1])})`;
    return `${o.kind} { ${fs.map(([k, x]) => `${key(k)}: ${flatten(x)}`).join(", ")} }`;
  }
  const fs = fields(o, false);
  return fs.length === 0 ? "{}" : `{ ${fs.map(([k, x]) => `${key(k)}: ${flatten(x)}`).join(", ")} }`;
}

function spread(v: unknown, indent: string): string {
  const inner = indent + "  ";
  if (Array.isArray(v)) return `[\n${v.map((x) => `${inner}${renderValue(x, inner)}`).join(",\n")}\n${indent}]`;
  const o = v as Record<string, unknown>;
  if (isVariant(o)) {
    const fs = fields(o, true);
    if (fs.length === 1 && (fs[0][0] === "value" || fs[0][0] === "error")) return `${o.kind}(${renderValue(fs[0][1], indent)})`;
    return `${o.kind} {\n${fs.map(([k, x]) => `${inner}${key(k)}: ${renderValue(x, inner)}`).join(",\n")}\n${indent}}`;
  }
  return `{\n${fields(o, false).map(([k, x]) => `${inner}${key(k)}: ${renderValue(x, inner)}`).join(",\n")}\n${indent}}`;
}

// ---------------------------------------------------------------------------
// Units

/** The `commons` and `context` units a source declares. */
export function unitNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^(?:context|commons)\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/gm)) names.push(m[1]);
  return names;
}
