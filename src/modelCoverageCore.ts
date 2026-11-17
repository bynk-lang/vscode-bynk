// #144: test coverage on the model views — the dependency-free core.
//
// `bynk test --coverage` reports *line* coverage of the whole run (ADR 0514,
// #2104 DECISION B: no branches, no per-test attribution). The model views
// already carry a source range for each agent-state edge, each sequence
// message and (bynk#3584, v0.625.2) each `alt` branch, so a transition, call
// or branch is projected as *covered when its lines ran*. That is an
// approximation and the UI says so: it cannot say which test reached what, and
// a line that ran says nothing about which of two conditions on it held.
//
// Pure: no `vscode`, no DOM. `modelCoverage.ts` holds the run and attaches the
// payload; the two pages (`webview/state.ts`, `webview/main.ts`) draw the marks.

import { ids as sequenceIds } from "./diagram/sequence/adapter";
import { stateIds } from "./diagram/structure/stateMachine";
import type { FileLines } from "./coverageModel";
import { groupTransitions } from "./webview/state-gen";
import type { StateMachine } from "./webview/stateTypes";
import type { AltBlock, Range, SequenceModel } from "./webview/types";

/** How much of a model element's source the run executed. `unmeasured`: the
 *  element's lines have no executable statement (or the file was not in the
 *  report), so coverage says nothing about it. */
export type CoverageMark = "covered" | "partial" | "uncovered" | "unmeasured";

/** One source file's line coverage, as the host embeds it in a view's payload
 *  (client-only, never on the wire from the server). */
export interface ModelCoverage {
  /** When the run finished, in ms since the epoch. */
  runAt: number;
  /** What the run measured: `the whole project`, or `the case "…"`. */
  scope: string;
  /** The source changed after the run (an unsaved edit, or a newer file). */
  stale: boolean;
  /** Executable lines (1-based) that ran. */
  ran: number[];
  /** Executable lines (1-based) that did not. */
  missed: number[];
}

/** One coverage run: what each of its projects measured. */
export interface CoverageRun {
  files: FileLines[];
  /** What the run measured: `the whole project`, or `the case "…"`. */
  scope: string;
  /** When the run started, in ms since the epoch (before `bynk test` ran, so a
   *  file saved during the run reads as changed since). */
  runAt: number;
}

/** Add one project's part of a run to the run so far. A Run All with Coverage
 *  reports each project in turn, and each keeps its files (a file is replaced
 *  only by a newer report of itself); a part of another run starts afresh.
 *  `runAt` is the earliest start among the parts, so a file saved while any of
 *  them ran reads as changed since. */
export function mergeRun(current: CoverageRun | undefined, sameRun: boolean, part: CoverageRun): CoverageRun {
  if (!current || !sameRun) return part;
  const kept = current.files.filter((f) => !part.files.some((p) => p.file === f.file));
  return { files: [...kept, ...part.files], scope: part.scope, runAt: Math.min(current.runAt, part.runAt) };
}

/** A run's coverage of `file`, or `undefined` when the report does not list
 *  it (a case-scoped run measures some files only). */
export function modelCoverageFor(
  files: readonly FileLines[],
  file: string,
  meta: { runAt: number; scope: string; stale: boolean },
): ModelCoverage | undefined {
  const f = files.find((x) => samePath(x.file, file));
  if (!f) return undefined;
  return {
    ...meta,
    ran: f.statements.filter((s) => s.executed).map((s) => s.line),
    missed: f.statements.filter((s) => !s.executed).map((s) => s.line),
  };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(a)
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/** The lines of `range` (0-based positions) as 1-based line numbers; a range
 *  ending at column 0 of a later line does not include that line. */
function linesOf(range: Range): [number, number] {
  const first = range.start.line + 1;
  const endsAtLineStart = range.end.character === 0 && range.end.line > range.start.line;
  return [first, (endsAtLineStart ? range.end.line - 1 : range.end.line) + 1];
}

/** `covered`: every executable line in the range ran. `uncovered`: none did.
 *  `partial`: some did. `unmeasured`: it has no executable line. */
export function rangeMark(cov: ModelCoverage, range: Range | null | undefined): CoverageMark {
  if (!range) return "unmeasured";
  const [first, last] = linesOf(range);
  return linesMark(cov, first, last, []);
}

/** The mark of the 1-based lines `first`..`last`, leaving out `exclude` (each a
 *  1-based, inclusive `[first, last]`). */
function linesMark(cov: ModelCoverage, first: number, last: number, exclude: ReadonlyArray<readonly [number, number]>): CoverageMark {
  const inside = (l: number): boolean => l >= first && l <= last && !exclude.some(([a, b]) => l >= a && l <= b);
  const ran = cov.ran.filter(inside).length;
  const missed = cov.missed.filter(inside).length;
  if (ran === 0 && missed === 0) return "unmeasured";
  if (missed === 0) return "covered";
  return ran === 0 ? "uncovered" : "partial";
}

/** The mark of a sequence diagram's branch. Its range is the arm's source
 *  (bynk#3584), which overreaches in two ways that would mark a branch tested
 *  when its body never ran:
 *  - an `else if` arm's range covers the rest of the chain (bynk#3599), and an
 *    arm's range can share its last line with the next arm (`} else {`), so the
 *    lines of every later branch of the block are left out;
 *  - an `if`'s `then` range starts at the `if` keyword, and its condition line
 *    runs whenever the `if` is reached, taken or not, so that first line is
 *    left out. A `then` arm that fits on its condition's line has nothing left
 *    and reads as unmeasured, rather than as tested.
 *  Whether the arm was entered is then whether its own body lines ran. */
export function branchMark(cov: ModelCoverage, block: Pick<AltBlock, "kind" | "branches">, index: number): CoverageMark {
  const range = block.branches[index]?.range;
  if (!range) return "unmeasured";
  let [first, last] = linesOf(range);
  if (block.kind === "If" && index === 0) first += 1;
  const later = block.branches.slice(index + 1).flatMap((b): Array<[number, number]> => (b.range ? [linesOf(b.range)] : []));
  return linesMark(cov, first, last, later);
}

/** Whether a mark counts as exercised: a partly-run range was reached. */
export const reached = (m: CoverageMark): boolean => m === "covered" || m === "partial";

/** Several marks as one: all covered, none, or mixed. Unmeasured ones are
 *  left out (they say nothing); with nothing measured the result is too. */
export function combineMarks(marks: readonly CoverageMark[]): CoverageMark {
  const measured = marks.filter((m) => m !== "unmeasured");
  if (measured.length === 0) return "unmeasured";
  if (measured.every((m) => m === "covered")) return "covered";
  if (measured.every((m) => m === "uncovered")) return "uncovered";
  return "partial";
}

/** "3 of 5", for the counts a view shows. */
export interface Tally {
  /** Elements whose lines ran (wholly or in part). */
  tested: number;
  total: number;
  /** Elements coverage says nothing about; counted in `total`. */
  unmeasured: number;
}

function tally(marks: readonly CoverageMark[]): Tally {
  return {
    tested: marks.filter(reached).length,
    total: marks.length,
    unmeasured: marks.filter((m) => m === "unmeasured").length,
  };
}

export const tallyText = (t: Tally, noun: string): string =>
  `${t.tested} of ${t.total} ${t.total === 1 ? noun : /(ch|sh|s|x)$/.test(noun) ? `${noun}es` : `${noun}s`} tested` +
  (t.unmeasured > 0 ? ` (${t.unmeasured} not measured)` : "");

// -- Agent state machines. --

export interface StateCoverage {
  /** One mark per `machine.edges[i]`. */
  edges: CoverageMark[];
  /** One mark per drawn transition, by `stateIds.transition(from, to)`. */
  transitions: Record<string, CoverageMark>;
  /** `untested` for a state no covered transition enters; the initial state
   *  and a state nothing is known about are left out. */
  states: Record<string, "reached" | "untested">;
  /** The machine's transitions: every path that writes the field. */
  tally: Tally;
}

export function stateCoverage(machine: StateMachine, cov: ModelCoverage): StateCoverage {
  const edges = machine.edges.map((e) => rangeMark(cov, e.range));
  const transitions: Record<string, CoverageMark> = {};
  // The groups drawn with unchanged self-loops on, so every edge has an id.
  for (const g of groupTransitions(machine, { showUnchanged: true })) {
    transitions[stateIds.transition(g.from, g.to)] = combineMarks(g.edges.map((e) => edges[machine.edges.indexOf(e)]));
  }
  // A state is reached when a transition that writes it ran. The initial
  // state is reached by creating the agent, which no edge stands for.
  const entered = new Set<string>();
  machine.edges.forEach((e, i) => {
    if (e.to.kind === "State" && reached(edges[i])) entered.add(e.to.state);
  });
  const measuredAny = edges.some((m) => m !== "unmeasured");
  const states: StateCoverage["states"] = {};
  for (const s of machine.states) {
    if (s === machine.initial || !measuredAny) continue;
    const written = machine.edges.some((e) => e.to.kind === "State" && e.to.state === s);
    if (!written) continue; // nothing writes it: coverage cannot say
    states[s] = entered.has(s) ? "reached" : "untested";
  }
  const moves = machine.edges.flatMap((e, i) => (e.to.kind === "Unchanged" ? [] : [edges[i]]));
  return { edges, transitions, states, tally: tally(moves) };
}

// -- Sequence diagrams. --

export interface SequenceCoverage {
  /** By the diagram's message id (`m<index>`): calls and sends. */
  messages: Record<string, CoverageMark>;
  /** By the diagram's operand id (`b<block>.<branch>`). */
  branches: Record<string, CoverageMark>;
  calls: Tally;
  branchTally: Tally;
}

export function sequenceCoverage(model: SequenceModel, cov: ModelCoverage): SequenceCoverage {
  const messages: Record<string, CoverageMark> = {};
  model.messages.forEach((m, i) => {
    // A reply and a state write are not calls; they share a call's lines.
    if (m.kind === "Call" || m.kind === "Send") messages[sequenceIds.message(i)] = rangeMark(cov, m.range);
  });
  const branches: Record<string, CoverageMark> = {};
  for (const b of model.blocks) {
    if (b.kind === "Collapsed") continue;
    b.branches.forEach((br, i) => {
      // `range` is bynk#3584 (v0.625.2): an older server sends none, and
      // coverage says nothing about the branch rather than guess from the block.
      if (br.range) branches[sequenceIds.operand(b.id, i)] = branchMark(cov, b, i);
    });
  }
  return {
    messages,
    branches,
    calls: tally(Object.values(messages)),
    branchTally: tally(Object.values(branches)),
  };
}

// -- Wording. --

/** The legend line under a view's coverage toggle: what the marks mean, when
 *  the run started (a time of day, which stays true as the page sits open, where
 *  an age would not), and that they are not per-test. */
export function coverageNote(cov: ModelCoverage): string[] {
  const lines = [
    `Line coverage from the last whole-run coverage run (${cov.scope}), started ${clockTime(cov.runAt)}. ` +
      "An element counts as tested when its lines ran; this cannot say which test reached it.",
  ];
  if (cov.stale) {
    lines.push("The source has changed since that run, so these marks may be out of date. Run with Coverage again.");
  }
  return lines;
}

/** A time of day, `14:32` (the local zone, 24 hours), with the date when it
 *  is not today: `16 Nov, 14:32`. `now` is the page's clock. */
export function clockTime(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date(now).toDateString()
    ? time
    : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/** The word a mark adds to an element's accessible name and tooltip, so a
 *  mark never depends on colour alone. */
export const MARK_WORD: Record<Exclude<CoverageMark, "unmeasured">, string> = {
  covered: "tested",
  partial: "partly tested",
  uncovered: "not tested",
};
