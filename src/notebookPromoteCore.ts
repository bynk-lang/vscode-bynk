// #210: promote a notebook cell to a test case, and a notebook to a suite. The
// pure part: no `vscode` import, so the unit tests compile against it.
//
// The suites stay the source of truth (`bynk test`, CI and the Test Explorer run
// what is written here), and the notebook is not run by anything but its own
// controller. A promoted case is a one-way copy.
//
// A case is built from what the notebook already knows how to say:
//
//   - the cell's `consumes` go to the suite, its `stub`s to the case, and the
//     `let`s of the earlier cells it uses ahead of its body: `buildSnippet`'s
//     own header and preamble, narrowed to the `let`s the cell needs;
//   - a handler cell's call is bound (`let response <- api.POST(…) by Visitor`),
//     its `expect`s kept;
//   - what the cell showed becomes assertions only as OFFERS (`offersFor`): the
//     user ticks the ones to write, and nothing is asserted unconfirmed;
//   - the Markdown cells directly above the cell become the case's doc comment
//     (`--- text`: Bynk's doc comment, `///` is refused by the lexer, v0.639.1),
//     the nearest heading its name, and the notebook's first heading the suite's
//     doc comment.
//
// What the pinned toolchain does with a suite constrains the output:
//   - `expect a == 1500` and then `expect a == 1600` on the same expression
//     fails `tsc_failed` (bynk-lang/bynk#3775), so no offer repeats a target: one
//     equality per value;
//   - a call with `by` cannot stand alone as a statement, so a call is always bound.

import { HTTP_VARIANTS } from "./scenarioPromoteCore";
import { analyseCell, buildSnippet, cellKindOf, expectations, splitStatements, unitFor, type CandidateRow, type CellInput } from "./notebookCore";
import { caseSource, freshName, type Response } from "./notebookHandlerCore";

// ---------------------------------------------------------------------------
// Inputs

/** What a code cell showed the last time it ran without a problem. */
export type CellOutput =
  | { kind: "value"; value: unknown; type: string }
  | { kind: "response"; response: Response }
  | { kind: "refined"; type: string; rows: readonly CandidateRow[] };

export interface PromoteCell {
  kind: "markdown" | "code";
  source: string;
  /** The unit a code cell runs in (its `// @unit`, else the notebook's); `undefined` when neither names one. */
  unit: string | undefined;
  /** The output of its last successful run; none when it has not run since it was last edited. */
  output?: CellOutput;
}

// ---------------------------------------------------------------------------
// Narrative: names and doc comments

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** The text of the last heading line in a Markdown cell. */
function lastHeading(source: string): string | undefined {
  let found: string | undefined;
  for (const line of source.split("\n")) {
    const m = HEADING.exec(line);
    if (m && m[1] !== "") found = m[1];
  }
  return found;
}

/** The notebook's first Markdown heading: the suite's doc comment. */
export function suiteHeading(cells: readonly PromoteCell[]): string | undefined {
  for (const c of cells) {
    if (c.kind !== "markdown") continue;
    for (const line of c.source.split("\n")) {
      const m = HEADING.exec(line);
      if (m && m[1] !== "") return m[1];
    }
  }
  return undefined;
}

/** The nearest heading above cell `index`, in the Markdown cells before it. */
export function nearestHeading(cells: readonly PromoteCell[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (cells[i].kind !== "markdown") continue;
    const h = lastHeading(cells[i].source);
    if (h) return h;
  }
  return undefined;
}

/** The Markdown cells directly above cell `index` (back to the previous code
 *  cell), as one text. Empty cells are skipped. */
export function narrativeAbove(cells: readonly PromoteCell[], index: number): string {
  const parts: string[] = [];
  for (let i = index - 1; i >= 0 && cells[i].kind === "markdown"; i--) {
    if (cells[i].source.trim() !== "") parts.unshift(cells[i].source.trim());
  }
  return parts.join("\n\n");
}

/** The narrative without the first heading line that says `heading`: the case
 *  is named for it, so the doc comment need not repeat it. */
function withoutHeading(narrative: string, heading: string | undefined): string {
  if (heading === undefined) return narrative;
  const lines = narrative.split("\n");
  const at = lines.findIndex((l) => HEADING.exec(l)?.[1] === heading);
  if (at < 0) return narrative;
  lines.splice(at, 1);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The first line of a cell that is not a blank or a directive comment, shortened. */
function firstLineOf(source: string): string | undefined {
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (t === "" || /^\/\/\s*@/.test(t)) continue;
    return t.length > 60 ? `${t.slice(0, 59)}…` : t;
  }
  return undefined;
}

/** The suggested case name for cell `index`: the nearest heading, else the
 *  cell's first line, else its position. */
export function suggestName(cells: readonly PromoteCell[], index: number): string {
  return nearestHeading(cells, index) ?? firstLineOf(cells[index].source) ?? `cell ${index + 1}`;
}

/** A name no case of the suite has: `name`, then `name (2)`, … */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A string as a Bynk literal; refused when it holds a control character. */
export function quote(s: string): string {
  return JSON.stringify(s);
}

/** Markdown as a doc comment at `indent`: `--- text` for one line, else a block
 *  between two `---` lines. A line that is only `---` (a Markdown rule) would end
 *  the block, so it is written `___`. Empty when there is no narrative. */
export function docComment(text: string, indent: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .map((l) => (/^\s*---+\s*$/.test(l) ? "___" : l));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`${indent}--- ${lines[0].trimStart()}`];
  return [`${indent}---`, ...lines.map((l) => (l === "" ? "" : `${indent}${l}`)), `${indent}---`];
}

// ---------------------------------------------------------------------------
// Offered assertions

export interface Offer {
  id: string;
  /** What the check says, as the quick pick shows it. */
  label: string;
  detail?: string;
  /** The line it writes: against the binding, or against the response's payload. */
  line: string;
  scope: "top" | "payload";
  /** For a payload check, the variant the `match` arm is for. */
  variant?: string;
  /** The check reads the cell's last value, so the value is bound to a name. */
  needsBinding?: boolean;
}

const hasControl = (s: string): boolean => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_TYPES = new Set(["String", "Int", "Float", "Bool"]);
const MAX_FIELDS = 12;

/** A wire value as a Bynk literal of the base type `type`; undefined when it has none. */
function literalOf(value: unknown, type: string | undefined): string | undefined {
  if (typeof value === "string") return hasControl(value) ? undefined : quote(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return type === "Float" ? `${value}.0` : String(value);
    return /e/i.test(String(value)) ? undefined : String(value);
  }
  return undefined;
}

const isVariantObject = (o: Record<string, unknown>): o is Record<string, unknown> & { kind: string } => typeof o.kind === "string" && /^[A-Z][A-Za-z0-9_]*$/.test(o.kind);

interface Found {
  offers: Omit<Offer, "id">[];
  /** What could not be offered, and why. */
  left: string[];
}

/** The checks a value offers, against `bind`: a scalar's equality, a variant's
 *  `is`, a list of scalars' equality, a record's fields (and theirs, to depth
 *  three). Never two equalities on one expression (bynk-lang/bynk#3775). */
function valueOffers(value: unknown, type: string | undefined, bind: string, scope: Offer["scope"], variant: string | undefined, needsBinding: boolean, depth = 0): Found {
  const out: Found = { offers: [], left: [] };
  const add = (label: string, line: string, detail?: string): void => {
    out.offers.push({ label, line, detail, scope, variant, needsBinding });
  };
  if (value === null) return out;
  if (typeof value !== "object") {
    // A named type (`Percent`, `UserId`) may be refined or opaque: whether a bare literal is one is the compiler's to say.
    if (depth === 0 && type !== undefined && !BASE_TYPES.has(type)) {
      out.left.push(`the value is a ${type}, which has no literal of its own to compare with`);
      return out;
    }
    const lit = literalOf(value, type);
    if (lit === undefined) out.left.push(`${bind}: no literal for ${JSON.stringify(value)}`);
    else add(`${bind} == ${lit}`, `expect ${bind} == ${lit}`);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) out.left.push(`${bind}: an empty list has no literal to compare with`);
    else if (value.length > 8 || !value.every((v) => v !== null && typeof v !== "object")) out.left.push(`${bind}: a list of ${value.length > 8 ? "more than 8 items" : "records or nested values"} is not offered`);
    else {
      const lits = value.map((v) => literalOf(v, undefined));
      if (lits.some((l) => l === undefined)) out.left.push(`${bind}: an item has no literal`);
      else add(`${bind} == [${lits.join(", ")}]`, `expect ${bind} == [${lits.join(", ")}]`);
    }
    return out;
  }
  const o = value as Record<string, unknown>;
  if (isVariantObject(o)) {
    const nullary = Object.keys(o).length === 1;
    add(nullary ? `${bind} is ${o.kind}` : `${bind} is ${o.kind}(_)`, nullary ? `expect ${bind} is ${o.kind}` : `expect ${bind} is ${o.kind}(_)`);
    return out;
  }
  if (depth >= 3) {
    out.left.push(`${bind}: nested more than three records deep`);
    return out;
  }
  let n = 0;
  for (const [k, v] of Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!IDENT.test(k)) {
      out.left.push(`${bind}.${k}: not a field name`);
      continue;
    }
    if (n >= MAX_FIELDS) {
      out.left.push(`${bind}: more than ${MAX_FIELDS} fields, the rest are not offered`);
      break;
    }
    if (v === null) continue;
    if (typeof v === "object" && !Array.isArray(v) && !isVariantObject(v as Record<string, unknown>)) {
      const inner = valueOffers(v, undefined, `${bind}.${k}`, scope, variant, needsBinding, depth + 1);
      out.offers.push(...inner.offers);
      out.left.push(...inner.left);
      n += inner.offers.length;
      continue;
    }
    if (typeof v === "object") {
      out.left.push(`${bind}.${k}: ${Array.isArray(v) ? "a list" : "an option or a variant"} of a field is matched, not read`);
      continue;
    }
    const lit = literalOf(v, undefined);
    if (lit === undefined) out.left.push(`${bind}.${k}: no literal for ${JSON.stringify(v)}`);
    else {
      add(`${bind}.${k} == ${lit}`, `expect ${bind}.${k} == ${lit}`);
      n++;
    }
  }
  return out;
}

/** What the output of a cell offers to assert. `response` and `payload` name the
 *  bindings a handler cell's response and its payload are written under. */
function offersFor(kind: "expression" | "handler" | "refined", output: CellOutput | undefined, names: { result: string; response?: string; payload: string }): { offers: Offer[]; left: string[] } {
  const raw: Found = { offers: [], left: [] };
  if (output?.kind === "response" && names.response) {
    const r = output.response;
    if (r.variant === null) raw.left.push("the response is a raw or streamed body, which has no payload to assert");
    else {
      const info = HTTP_VARIANTS[r.variant];
      raw.offers.push({
        label: `${names.response} is ${r.variant}${r.hasPayload ? "(_)" : ""}`,
        detail: r.status !== undefined ? `status ${r.status}` : undefined,
        line: `expect ${names.response} is ${r.variant}${r.hasPayload && info?.payload !== "none" ? "(_)" : ""}`,
        scope: "top",
      });
      if (r.hasPayload && r.payload !== null && r.payload !== undefined) {
        const inner = valueOffers(r.payload, undefined, names.payload, "payload", r.variant, false);
        // The payload itself, not only its fields, when it is a scalar (a message).
        raw.offers.push(...inner.offers);
        raw.left.push(...inner.left);
      }
    }
  } else if (output?.kind === "value" && kind !== "refined") {
    const found = valueOffers(output.value, output.type, names.result, "top", undefined, true);
    raw.offers.push(...found.offers);
    raw.left.push(...found.left);
  } else if (output?.kind === "refined") {
    for (const row of output.rows) {
      if (row.outcome === "accepted") raw.offers.push({ label: `${output.type}.of(${row.candidate.text}) is accepted`, line: `expect ${output.type}.of(${row.candidate.text}) is Ok(_)`, scope: "top" });
      else if (row.outcome === "refused") raw.offers.push({ label: `${output.type}.of(${row.candidate.text}) is refused`, detail: row.message, line: `expect ${output.type}.of(${row.candidate.text}) is Err(_)`, scope: "top" });
      else raw.left.push(`${row.candidate.text}: it does not check as ${output.type}.of's argument, so there is nothing to assert`);
    }
  }
  return { offers: raw.offers.map((o, i) => ({ ...o, id: `o${i}` })), left: raw.left };
}

// ---------------------------------------------------------------------------
// A case

export interface CasePlan {
  /** The notebook cell index it comes from. */
  cell: number;
  kind: "expression" | "handler" | "refined";
  /** The name to confirm. */
  name: string;
  /** The Markdown directly above, as a doc comment. */
  doc: string;
  /** `consumes` statements for the suite. */
  consumes: string[];
  /** `stub` statements for the case. */
  stubs: string[];
  /** The preamble and the body, as lines to indent. */
  body: string[];
  /** What a handler cell's response, and its payload, are bound to. */
  names: { response?: string; payload: string };
  /** Where the cell's last value starts within `body`, and what to bind it to. */
  bind?: { line: number; name: string };
  /** The cell has `expect` lines of its own: they are kept and nothing is offered. */
  hasExpect: boolean;
  /** Whether the cell has output to offer assertions from. */
  ran: boolean;
  offers: Offer[];
  /** The earlier cells whose `let`s the case uses. */
  usedCells: number[];
  /** What the cell said that the case does not carry. */
  notCarried: string[];
}

export type Planned = { ok: true; plan: CasePlan } | { ok: false; reason: string };

const LET = /^let\b/;
const HEADER = /^(consumes|stub)\b/;
const EXPECT = /^expect\b/;

/** The names a `let` statement binds: `let x = …`, `let x: T <- …`, `let (a, b) = …`. */
function bound(text: string): string[] {
  const m = /^let\s+(?:\(([^)]*)\)|([A-Za-z_][A-Za-z0-9_]*))/.exec(text.trimStart());
  if (!m) return [];
  return (m[1] ?? m[2]).split(",").map((s) => s.trim()).filter((s) => IDENT.test(s));
}

const mentions = (text: string, name: string): boolean => new RegExp(`(?<![A-Za-z0-9_.])${name}(?![A-Za-z0-9_])`).test(text);

/** An earlier cell reduced to its `consumes`/`stub` lines and the `let`s the
 *  cell being promoted (or a later kept `let`) reads: so the case carries the
 *  bindings it uses, not every `let` of the notebook. */
function narrowEarlier(earlier: { index: number; source: string }[], currentBody: string): Map<number, string> {
  const out = new Map<number, string>();
  let needed = currentBody;
  for (const e of [...earlier].reverse()) {
    const cell = analyseCell(e.source);
    const kept = cell.body.filter((s) => LET.test(s.text.trimStart()) && bound(s.text).some((n) => mentions(needed, n)));
    if (kept.length === 0) continue;
    needed += `\n${kept.map((s) => s.text).join("\n")}`;
    out.set(e.index, [...cell.header, ...kept].map((s) => s.text).join("\n"));
  }
  return out;
}

/** Turn cell `index` (a code cell of the notebook, running in `unit`) into a
 *  case, ahead of the user's choices. */
export function planCase(cells: readonly PromoteCell[], index: number, unit: string): Planned {
  const cell = cells[index];
  const kind = cellKindOf(cell.source);
  if (kind.kind === "bad-directive") return { ok: false, reason: `${kind.problem} (${kind.directive})` };
  const analysed = analyseCell(cell.source);
  if (analysed.body.length === 0 && kind.kind !== "refined") return { ok: false, reason: "it has no code, only `stub`s and `consumes`." };

  const notCarried: string[] = [];
  let currentSource = cell.source;
  let response: string | undefined;
  if (kind.kind === "handler") {
    const rewritten = caseSource(cell.source);
    currentSource = rewritten.text;
    response = rewritten.response;
  }
  let refinedRows: readonly CandidateRow[] = [];
  if (kind.kind === "refined") {
    // The candidates are not code of the case: each one ticked becomes its own `expect`.
    currentSource = analysed.header.map((h) => h.text).join("\n");
    refinedRows = cell.output?.kind === "refined" ? cell.output.rows : [];
  }

  // The earlier code cells of this unit: those whose `let`s the cell reads.
  const earlier: { index: number; source: string }[] = [];
  for (let i = 0; i < index; i++) {
    const c = cells[i];
    if (c.kind !== "code" || (c.unit ?? unit) !== unit) continue;
    earlier.push({ index: i, source: c.source });
  }
  const narrowed = narrowEarlier(earlier, analyseCell(currentSource).body.map((s) => s.text).join("\n"));
  const inputs: CellInput[] = cells.map((c, i) => ({
    source: i === index ? currentSource : (narrowed.get(i) ?? ""),
    unit: c.unit ?? unit,
    ran: c.kind === "code" && narrowed.has(i),
  }));
  // The cell being promoted is the last to be run: only `index` and earlier cells matter to `buildSnippet`.
  const snippet = buildSnippet(inputs, index, unit);
  const built = analyseCell(snippet.text);
  const headerText = (h: { text: string }): string => h.text;
  const consumes = [...new Set(built.header.filter((h) => /^consumes\b/.test(h.text.trimStart())).map(headerText))];
  const stubs = built.header.filter((h) => /^stub\b/.test(h.text.trimStart())).map(headerText);
  if (built.body.length === 0 && kind.kind !== "refined") return { ok: false, reason: "it has no code to write." };

  const lines = built.lines;
  const last = built.body[built.body.length - 1];
  const body = built.body.length === 0 ? [] : lines.slice(built.body[0].start, last.end + 1);
  const hasExpect = expectations(cell.source).length > 0;

  // The cell's last value, when it ends in an expression whose value is shown.
  let bind: CasePlan["bind"];
  const taken = body.join("\n");
  const resultName = freshName(taken, "result");
  const endsInValue = last !== undefined && !EXPECT.test(last.text) && !LET.test(last.text.trimStart()) && !HEADER.test(last.text.trimStart());
  if (kind.kind !== "refined" && !response && endsInValue) bind = { line: last.start - built.body[0].start, name: resultName };

  let offers: Offer[] = [];
  let left: string[] = [];
  const ran = cell.output !== undefined;
  if (hasExpect) {
    notCarried.push("it has `expect` lines of its own, which are kept, so no assertion is offered from its output");
  } else if (!ran) {
    notCarried.push("it has not run since it was last edited, so there is no output to offer assertions from");
  } else if (kind.kind === "refined" && refinedRows.length === 0) {
    notCarried.push("it showed no candidates to assert");
  } else {
    const names = { result: bind?.name ?? resultName, response, payload: freshName(taken, "payload") };
    const found = offersFor(kind.kind, cell.output, names);
    offers = found.offers;
    left = found.left;
    // A value shown from a cell that does not end in a value (a `let`) has nothing to bind.
    if (!bind) offers = offers.filter((o) => !o.needsBinding);
    if (kind.kind === "refined" && offers.length === 0) notCarried.push("none of its candidates reached the constructor, so there is nothing to assert");
  }
  for (const l of left) notCarried.push(`not offered: ${l}`);

  return {
    ok: true,
    plan: {
      cell: index,
      kind: kind.kind === "refined" ? "refined" : kind.kind === "handler" ? "handler" : "expression",
      name: suggestName(cells, index),
      // The notebook's title is the suite's doc comment, and the nearest heading the case's name.
      doc: withoutHeading(withoutHeading(narrativeAbove(cells, index), nearestHeading(cells, index)), suiteHeading(cells)),
      consumes,
      stubs,
      body,
      names: { response, payload: freshName(taken, "payload") },
      bind,
      hasExpect,
      ran,
      offers,
      usedCells: snippet.used,
      notCarried,
    },
  };
}

/** Indent every non-blank line of `text` by `indent`. */
const indented = (lines: readonly string[], indent: string): string[] => lines.map((l) => (l === "" ? "" : `${indent}${l}`));

/** The case as text at `indent`, with the offers whose ids are in `accepted` written. */
export function renderCase(plan: CasePlan, name: string, accepted: ReadonlySet<string>, indent = "\t"): string {
  const picked = plan.offers.filter((o) => accepted.has(o.id));
  const inner = indent + indent.slice(0, 1);
  const lines: string[] = [...docComment(plan.doc, indent), `${indent}case ${quote(name)} {`];
  // What the case does not carry stays visible in the case.
  for (const n of plan.notCarried) lines.push(`${inner}// Not carried: ${n.replace(/\s+/g, " ")}`);
  lines.push(...indented(plan.stubs.flatMap((s) => s.split("\n")), inner));
  const body = [...plan.body];
  if (plan.bind && picked.some((o) => o.needsBinding)) body[plan.bind.line] = `let ${plan.bind.name} = ${body[plan.bind.line]}`;
  lines.push(...indented(body, inner));
  for (const o of picked.filter((x) => x.scope === "top")) lines.push(`${inner}${o.line}`);
  // The payload's checks are matched, one arm: `Created(payload) => { … }`.
  const payload = picked.filter((o) => o.scope === "payload");
  if (payload.length > 0) {
    const variant = payload[0].variant ?? "Ok";
    const response = plan.names.response ?? "response";
    const bindName = plan.names.payload;
    lines.push(`${inner}match ${response} {`, `${inner}${indent}${variant}(${bindName}) => {`, ...payload.map((o) => `${inner}${indent}${indent}${o.line}`), `${inner}${indent}},`, `${inner}${indent}_ => expect false,`, `${inner}}`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// A suite: new, or a case added to an existing one

/** A new suite for `unit`. */
export function newSuite(unit: string, doc: string | undefined, source: string, consumes: readonly string[], cases: readonly string[]): string {
  const head = [`// Promoted from ${source} by Bynk: Promote to Test Case.`, "// A one-way copy: edits here are not carried back to the notebook, and the notebook", "// is not run by `bynk test`."];
  const lines = [...head, ...(doc ? docComment(doc, "") : []), `suite ${unit} {`];
  for (const c of consumes) lines.push(...indented(c.split("\n"), "\t"));
  if (consumes.length > 0) lines.push("");
  lines.push(cases.join("\n\n"), "}", "");
  return lines.join("\n");
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface SuiteEdit {
  /** Offset in the original text. */
  offset: number;
  text: string;
}

export type Inserted = { ok: true; text: string; edits: SuiteEdit[]; existingNames: Set<string> } | { ok: false; reason: string };

/** A scan of Bynk source that sees past strings, `//` comments and doc comments
 *  (`--- text`, and a block between two `---` lines), calling `visit` for each
 *  code character with its offset. Stops when `visit` answers true. */
function scan(text: string, visit: (c: string, at: number) => boolean | void): void {
  let inBlockDoc = false;
  let at = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (inBlockDoc) {
      if (t === "---") inBlockDoc = false;
    } else if (t === "---") {
      inBlockDoc = true;
    } else if (!t.startsWith("--- ")) {
      let inString = false;
      for (let k = 0; k < line.length; k++) {
        const c = line[k];
        if (inString) {
          if (c === "\\") k++;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') inString = true;
        else if (c === "/" && line[k + 1] === "/") break;
        else if (visit(c, at + k) === true) return;
      }
    }
    at += line.length + 1;
  }
}

/** Where a suite for `unit` starts in `text`: its declaration, and for the
 *  braced form the offsets of its braces. `tier` is what follows `as`. */
export function findSuite(text: string, unit: string): { start: number; open?: number; close?: number; tier: string } | undefined {
  const re = new RegExp(`^(?:suite)\\s+${unit.replace(/\./g, "\\.")}(?![A-Za-z0-9_.])(?:\\s+as\\s+([a-z]+))?[ \\t]*(\\{)?`, "gm");
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    // A match in a comment or a doc is not a declaration.
    let real = false;
    scan(text, (_c, at) => {
      if (at >= start) {
        real = at === start;
        return true;
      }
    });
    if (!real) continue;
    const tier = m[1] ?? "unit";
    if (!m[2]) return { start, tier };
    const open = start + m[0].length - 1;
    let depth = 0;
    let close: number | undefined;
    scan(text, (c, at) => {
      if (at < open) return;
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        close = at;
        return true;
      }
    });
    return { start, open, close, tier };
  }
  return undefined;
}

/** The case names of a suite's text. */
export function caseNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*case\s+("(?:[^"\\\n]|\\.)*")/gm)) {
    try {
      names.add(JSON.parse(m[1]) as string);
    } catch {
      // A name the parser would refuse anyway.
    }
  }
  return names;
}

/** Add `cases` (and the `consumes` it lacks) to the unit-tier suite for `unit`
 *  in `text`, leaving everything else of the text as it is. */
export function insertCases(text: string, unit: string, consumes: readonly string[], cases: readonly string[]): Inserted {
  const suite = findSuite(text, unit);
  if (!suite) return { ok: false, reason: `no suite for ${unit} in the file` };
  if (suite.tier !== "unit") return { ok: false, reason: `the suite for ${unit} here is of the ${suite.tier} tier, not unit` };
  const existing = new Set([...text.matchAll(/^\s*consumes\b[^\n]*(?:\n[ \t]+[^\n]*)*/gm)].map((m) => squash(m[0])));
  const lacking = consumes.filter((c) => !existing.has(squash(c)));
  const edits: SuiteEdit[] = [];
  const names = caseNames(text);
  const lineStart = (offset: number): number => text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = (offset: number): number => {
    const i = text.indexOf("\n", offset);
    return i < 0 ? text.length : i;
  };

  if (suite.open !== undefined) {
    if (suite.close === undefined) return { ok: false, reason: `the suite for ${unit} has no closing brace` };
    // The members' indentation, from the first member line.
    const body = text.slice(suite.open + 1, suite.close);
    const firstMember = body.split("\n").find((l, i) => i > 0 && l.trim() !== "");
    const indent = /^[ \t]*/.exec(firstMember ?? "\t")?.[0] || "\t";
    const closeLine = lineStart(suite.close);
    if (text.slice(closeLine, suite.close).trim() !== "") return { ok: false, reason: `the closing brace of the suite for ${unit} shares a line with code; put it on a line of its own first` };
    if (lacking.length > 0) {
      const at = lineEnd(suite.open) + 1;
      const next = at >= text.length ? "" : text.slice(at, lineEnd(at));
      const tight = next.trim() === "" || /^\s*consumes\b/.test(next);
      edits.push({ offset: Math.min(at, text.length), text: `${lacking.flatMap((c) => indented(c.split("\n"), indent)).join("\n")}\n${tight ? "" : "\n"}` });
    }
    const before = text.slice(0, closeLine);
    const gap = before.endsWith("\n\n") || /\{\s*$/.test(before) ? "" : "\n";
    edits.push({ offset: closeLine, text: `${gap}${cases.map((c) => reindent(c, indent, indent)).join("\n\n")}\n` });
  } else {
    // A fragment-form suite: its members run to the end of the file.
    const decl = lineEnd(suite.start) + 1;
    if (lacking.length > 0) {
      const next = decl >= text.length ? "" : text.slice(decl, lineEnd(decl));
      const tight = next.trim() === "" || /^\s*consumes\b/.test(next);
      edits.push({ offset: Math.min(decl, text.length), text: `${lacking.join("\n")}\n${tight ? "" : "\n"}` });
    }
    const tail = text.endsWith("\n") ? "" : "\n";
    edits.push({ offset: text.length, text: `${tail}\n${cases.map((c) => reindent(c, "", "\t")).join("\n\n")}\n` });
  }
  const ordered = [...edits].sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const e of ordered) out = out.slice(0, e.offset) + e.text + out.slice(e.offset);
  return { ok: true, text: out, edits, existingNames: names };
}

/** A case written with one tab per level, its first line at one tab, moved to
 *  start at `caseIndent` with `unit` for each level below it. */
function reindent(caseText: string, caseIndent: string, unit: string): string {
  return caseText
    .split("\n")
    .map((l) => {
      if (l === "") return l;
      const n = /^\t*/.exec(l)?.[0].length ?? 0;
      return caseIndent + unit.repeat(Math.max(0, n - 1)) + l.slice(n);
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// A notebook as a suite

export interface SuitePlan {
  unit: string;
  cases: CasePlan[];
  /** What was left out, and why. */
  skipped: { cell: number; reason: string }[];
  /** Cells that were promoted though they have not run (so no assertion is offered for them). */
  neverRan: number[];
  /** Cells of other units: they go to their own suites. */
  otherUnits: { cell: number; unit: string }[];
}

/** The units the code cells of a notebook run in, by the number of cells. */
export function unitsOf(cells: readonly PromoteCell[]): string[] {
  const n = new Map<string, number>();
  for (const c of cells) if (c.kind === "code" && c.unit) n.set(c.unit, (n.get(c.unit) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([u]) => u);
}

/** Every code cell of `unit`, in order, as a case. A cell with no unit of its own
 *  uses the notebook's, already resolved into `PromoteCell.unit`. */
export function planSuite(cells: readonly PromoteCell[], unit: string): SuitePlan {
  const plan: SuitePlan = { unit, cases: [], skipped: [], neverRan: [], otherUnits: [] };
  cells.forEach((c, i) => {
    if (c.kind !== "code") return;
    if (c.source.trim() === "") return;
    if (c.unit === undefined) {
      plan.skipped.push({ cell: i, reason: "it runs in no unit: name one with `// @unit` or choose the notebook's." });
      return;
    }
    if (c.unit !== unit) {
      plan.otherUnits.push({ cell: i, unit: c.unit });
      return;
    }
    const planned = planCase(cells, i, unit);
    if (!planned.ok) {
      plan.skipped.push({ cell: i, reason: planned.reason });
      return;
    }
    if (!planned.plan.ran) plan.neverRan.push(i);
    plan.cases.push(planned.plan);
  });
  return plan;
}

/** The notebook's cells as `PromoteCell`s: the unit each runs in resolved against the notebook's. */
export function resolveUnits(cells: readonly { kind: "markdown" | "code"; source: string; output?: CellOutput }[], notebookUnit: string | undefined): PromoteCell[] {
  return cells.map((c) => ({ kind: c.kind, source: c.source, output: c.output, unit: c.kind === "code" ? unitFor(analyseCell(c.source), notebookUnit) : undefined }));
}

// ---------------------------------------------------------------------------
// Telling the user

/** The summary shown before anything is written. */
export function summarise(plans: readonly CasePlan[], names: readonly string[], accepted: readonly ReadonlySet<string>[], extra: readonly string[] = []): string {
  const lines: string[] = [];
  plans.forEach((p, i) => {
    const asserted = p.offers.filter((o) => accepted[i]?.has(o.id)).length + (p.hasExpect ? expectCount(p) : 0);
    lines.push(`• ${names[i]}: ${asserted === 0 ? "asserts nothing" : `${asserted} assertion${asserted === 1 ? "" : "s"}`}${p.stubs.length > 0 ? `, ${p.stubs.length} stub${p.stubs.length === 1 ? "" : "s"}` : ""}`);
    for (const n of p.notCarried) lines.push(`    – ${n.replace(/\s+/g, " ")}`);
  });
  if (extra.length > 0) lines.push("", ...extra);
  return lines.join("\n");
}

const expectCount = (p: CasePlan): number => splitStatements(p.body.join("\n")).filter((s) => EXPECT.test(s.text)).length;
