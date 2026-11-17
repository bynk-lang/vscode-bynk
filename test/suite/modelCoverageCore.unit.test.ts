// #144: line coverage projected onto the model views. Pure: no DOM, no VS Code.

import * as assert from "assert";

import type { FileLines } from "../../src/coverageModel";
import {
  branchMark,
  clockTime,
  combineMarks,
  coverageNote,
  type ModelCoverage,
  mergeRun,
  modelCoverageFor,
  rangeMark,
  sequenceCoverage,
  stateCoverage,
  tallyText,
} from "../../src/modelCoverageCore";
import type { StateEdge, StateMachine } from "../../src/webview/stateTypes";
import type { AltBlock, Message, Range, SequenceModel } from "../../src/webview/types";

/** Lines are 1-based in coverage, 0-based in ranges: `R(9)` is line 10. */
const R = (line: number, endLine = line, endCharacter = 4): Range => ({
  start: { line, character: 0 },
  end: { line: endLine, character: endCharacter },
});

const cov = (ran: number[], missed: number[], over: Partial<ModelCoverage> = {}): ModelCoverage => ({
  runAt: 1_000,
  scope: "the whole project",
  stale: false,
  ran,
  missed,
  ...over,
});

describe("modelCoverageFor", () => {
  const files: FileLines[] = [
    {
      file: "/work/shop/src/a.bynk",
      covered: 1,
      total: 3,
      statements: [
        { line: 2, executed: true },
        { line: 5, executed: false },
        { line: 6, executed: false },
      ],
    },
  ];
  it("lists the executed and missed lines of the file", () => {
    const c = modelCoverageFor(files, "/work/shop/src/a.bynk", { runAt: 5, scope: "x", stale: true });
    assert.deepStrictEqual(c, { runAt: 5, scope: "x", stale: true, ran: [2], missed: [5, 6] });
  });
  it("is undefined for a file the report does not list", () => {
    assert.strictEqual(modelCoverageFor(files, "/work/shop/src/b.bynk", { runAt: 5, scope: "x", stale: false }), undefined);
  });
  it("matches a Windows path whatever its case or separators", () => {
    const win: FileLines[] = [{ file: "C:\\Work\\Shop\\a.bynk", covered: 0, total: 1, statements: [{ line: 1, executed: false }] }];
    assert.ok(modelCoverageFor(win, "c:/work/shop/a.bynk", { runAt: 1, scope: "x", stale: false }));
  });
});

describe("mergeRun (#144)", () => {
  const part = (file: string, runAt: number, scope = "the whole project"): { files: FileLines[]; scope: string; runAt: number } => ({
    files: [{ file, covered: 1, total: 1, statements: [{ line: 1, executed: true }] }],
    scope,
    runAt,
  });
  it("keeps every project's files when a Run All reports them one after another", () => {
    const first = mergeRun(undefined, false, part("/a/x.bynk", 100));
    const both = mergeRun(first, true, part("/b/y.bynk", 120));
    assert.deepStrictEqual(both.files.map((f) => f.file), ["/a/x.bynk", "/b/y.bynk"]);
    assert.strictEqual(both.runAt, 100, "the earliest start, so a file saved during any part reads as changed");
  });
  it("does not describe parts that measured different things as one scope", () => {
    const mixed = mergeRun(part("/a/x.bynk", 100, 'the case "c"'), true, part("/b/y.bynk", 120));
    assert.strictEqual(mixed.scope, "several projects, each by its own scope");
    assert.strictEqual(mergeRun(part("/a/x.bynk", 100), true, part("/b/y.bynk", 120)).scope, "the whole project");
  });
  it("replaces a file only with a newer report of itself", () => {
    const merged = mergeRun(part("/a/x.bynk", 100), true, part("/a/x.bynk", 150));
    assert.strictEqual(merged.files.length, 1);
  });
  it("starts afresh for another run", () => {
    const next = mergeRun(part("/a/x.bynk", 100), false, part("/b/y.bynk", 200, 'the case "c"'));
    assert.deepStrictEqual(next.files.map((f) => f.file), ["/b/y.bynk"]);
    assert.strictEqual(next.scope, 'the case "c"');
    assert.strictEqual(next.runAt, 200);
  });
});

describe("rangeMark", () => {
  const c = cov([3, 4, 10], [7, 8, 10 + 1]);
  it("is covered when every executable line in the range ran", () => {
    assert.strictEqual(rangeMark(c, R(2, 3)), "covered"); // lines 3-4
  });
  it("is uncovered when none did", () => {
    assert.strictEqual(rangeMark(c, R(6, 7)), "uncovered"); // lines 7-8
  });
  it("is partial when some did", () => {
    assert.strictEqual(rangeMark(c, R(9, 10)), "partial"); // lines 10-11
  });
  it("is unmeasured when the range has no executable line, or no range", () => {
    assert.strictEqual(rangeMark(c, R(0)), "unmeasured"); // line 1
    assert.strictEqual(rangeMark(c, null), "unmeasured");
    assert.strictEqual(rangeMark(c, undefined), "unmeasured");
  });
  it("leaves out the line a range ends at the start of", () => {
    // Lines 3-4, ending at column 0 of line 5 (index 4): line 5 is not in it.
    assert.strictEqual(rangeMark(cov([3, 4], [5]), R(2, 4, 0)), "covered");
    assert.strictEqual(rangeMark(cov([3, 4], [5]), R(2, 4, 1)), "partial");
  });
});

describe("combineMarks and tallyText", () => {
  it("combines the measured marks", () => {
    assert.strictEqual(combineMarks(["covered", "covered", "unmeasured"]), "covered");
    assert.strictEqual(combineMarks(["uncovered", "unmeasured"]), "uncovered");
    assert.strictEqual(combineMarks(["covered", "uncovered"]), "partial");
    assert.strictEqual(combineMarks(["unmeasured"]), "unmeasured");
    assert.strictEqual(combineMarks([]), "unmeasured");
  });
  it("words a count", () => {
    assert.strictEqual(tallyText({ tested: 3, total: 5, unmeasured: 0 }, "transition"), "3 of 5 transitions tested");
    assert.strictEqual(tallyText({ tested: 1, total: 1, unmeasured: 0 }, "call"), "1 of 1 call tested");
    assert.strictEqual(tallyText({ tested: 0, total: 2, unmeasured: 1 }, "branch"), "0 of 2 branches tested (1 not measured)");
  });
});

const edge = (handler: string, from: string[], to: StateEdge["to"], line: number): StateEdge => ({
  handler,
  from,
  guards: [],
  to,
  outcome: null,
  range: R(line),
  violations: [],
});

function machine(): StateMachine {
  return {
    field: "status",
    fieldRange: R(1),
    states: ["Open", "Paid", "Closed", "Refunded"],
    initial: "Open",
    edges: [
      edge("pay", ["Open"], { kind: "State", state: "Paid" }, 10), // line 11
      edge("settle", ["Open"], { kind: "State", state: "Paid" }, 14), // line 15
      edge("close", ["Paid"], { kind: "State", state: "Closed" }, 18), // line 19
      edge("refund", ["Closed"], { kind: "State", state: "Refunded" }, 22), // line 23
      edge("peek", ["Open"], { kind: "Unchanged" }, 26), // line 27
      edge("guess", ["Open"], { kind: "Unknown" }, 30), // line 31
    ],
    reachable: ["Open", "Paid", "Closed", "Refunded"],
    truncated: [],
    notEvaluated: [],
  };
}

describe("stateCoverage", () => {
  // pay ran, settle did not, close ran, refund did not, peek ran, guess has no lines.
  const c = cov([11, 19, 27], [15, 23]);
  const sc = stateCoverage(machine(), c);

  it("marks each edge by its own lines", () => {
    assert.deepStrictEqual(sc.edges, ["covered", "uncovered", "covered", "uncovered", "covered", "unmeasured"]);
  });
  it("marks a drawn transition by every edge it stands for", () => {
    // Open→Paid is pay (ran) and settle (did not): partly tested.
    assert.strictEqual(sc.transitions["tr:Open->Paid"], "partial");
    assert.strictEqual(sc.transitions["tr:Paid->Closed"], "covered");
    assert.strictEqual(sc.transitions["tr:Closed->Refunded"], "uncovered");
    assert.strictEqual(sc.transitions["tr:Open->Open"], "covered"); // the unchanged self-loop
  });
  it("counts the transitions that write the field, not the unchanged paths", () => {
    // pay, settle, close, refund, guess: 5, of which pay and close ran; guess is unmeasured.
    assert.deepStrictEqual(sc.tally, { tested: 2, total: 5, unmeasured: 1 });
  });
  it("marks a state no tested transition enters", () => {
    assert.deepStrictEqual(sc.states, { Paid: "reached", Closed: "reached", Refunded: "untested" });
  });
  it("leaves the initial state, and a state nothing writes, unmarked", () => {
    const m = machine();
    m.states.push("Orphan");
    assert.strictEqual(stateCoverage(m, c).states.Orphan, undefined);
    assert.strictEqual(sc.states.Open, undefined);
  });
  it("marks no state when nothing in the machine was measured", () => {
    const none = stateCoverage(machine(), cov([], []));
    assert.deepStrictEqual(none.states, {});
    assert.deepStrictEqual(none.tally, { tested: 0, total: 5, unmeasured: 5 });
  });
});

const msg = (kind: Message["kind"], line: number, block: number | null = null): Message => ({
  from: 0,
  to: 1,
  kind,
  label: "x",
  range: R(line),
  block,
});

const block = (id: number, kind: AltBlock["kind"], branches: Array<{ range?: Range }>): AltBlock => ({
  id,
  kind,
  branches: branches.map((b, i) => ({ label: `b${i}`, messageIds: [], reply: null, ...b })),
  range: R(0, 99),
  parent: null,
  parentBranch: null,
});

describe("sequenceCoverage", () => {
  const model: SequenceModel = {
    participants: [],
    messages: [
      msg("Call", 4), // m0, line 5: ran
      msg("Return", 4), // m1: not a call
      msg("Send", 9, 0), // m2, line 10: missed
      msg("StateWrite", 12), // m3: not a call
    ],
    blocks: [
      // `then`: the `if` line (7) and its body (8-9); `else`: lines 10-12.
      block(0, "If", [{ range: R(6, 8) }, { range: R(9, 11) }, {}]),
      block(1, "Collapsed", [{ range: R(20) }]),
    ],
  };
  const c = cov([5, 8], [10, 11, 12]);
  const sc = sequenceCoverage(model, c);

  it("marks calls and sends, by the diagram's message ids", () => {
    assert.deepStrictEqual(sc.messages, { m0: "covered", m2: "uncovered" });
    assert.deepStrictEqual(sc.calls, { tested: 1, total: 2, unmeasured: 0 });
  });
  it("marks each branch of a block by its own range", () => {
    // The `then` body (lines 8-9) ran line 8; the `else` (lines 10-12) is all missed.
    assert.deepStrictEqual(sc.branches, { "b0.0": "covered", "b0.1": "uncovered" });
    assert.deepStrictEqual(sc.branchTally, { tested: 1, total: 2, unmeasured: 0 });
  });
  it("says nothing of a branch an older server sent no range for, nor a collapsed block", () => {
    assert.strictEqual(sc.branches["b0.2"], undefined);
    assert.strictEqual(sc.branches["b1.0"], undefined);
  });
});

describe("branchMark (#144, bynk#3599)", () => {
  // if a {            line 1  cond a
  //   X               line 2
  // } else if b {     line 3  cond b (the inner `if` starts here)
  //   Y               line 4
  // } else {          line 5
  //   Z               line 6
  // }                 line 7
  const outer = block(0, "If", [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } }, { range: { start: { line: 2, character: 9 }, end: { line: 6, character: 1 } } }]);
  const inner = block(1, "If", [{ range: { start: { line: 2, character: 9 }, end: { line: 4, character: 1 } } }, { range: { start: { line: 4, character: 7 }, end: { line: 6, character: 1 } } }]);

  it("does not call an arm tested because its condition, or a later arm, ran", () => {
    // Only the final `else` ran: both conditions were evaluated, then Z.
    const c = cov([1, 3, 6], [2, 4]);
    assert.strictEqual(branchMark(c, outer, 0), "uncovered", "X never ran: the condition line and the `} else if b {` line are not its body");
    assert.strictEqual(branchMark(c, inner, 0), "uncovered", "Y never ran, though `else if b` was evaluated");
    assert.strictEqual(branchMark(c, inner, 1), "covered", "Z ran");
    assert.strictEqual(branchMark(c, outer, 1), "partial", "the else arm was entered: its chain is partly run");
  });

  it("marks each arm tested when its own body ran", () => {
    const c = cov([1, 2], [4, 6]);
    assert.strictEqual(branchMark(c, outer, 0), "covered");
    assert.strictEqual(branchMark(c, inner, 0), "uncovered");
  });

  it("leaves a `then` arm that fits on its condition's line unmeasured, rather than tested", () => {
    const oneLine = block(2, "If", [{ range: R(0) }, { range: R(1) }]);
    assert.strictEqual(branchMark(cov([1], []), oneLine, 0), "unmeasured");
  });

  it("does not skip the first line of a `match` arm, or of an `else` arm", () => {
    const m = block(3, "Match", [{ range: R(0, 1) }, { range: R(2, 3) }]);
    assert.strictEqual(branchMark(cov([1], [3, 4]), m, 0), "covered");
    assert.strictEqual(branchMark(cov([1], [3, 4]), m, 1), "uncovered");
  });

  it("leaves a later arm unmeasured when it shares its only line with an earlier one", () => {
    // if a { X } else { Y }, all on line 1: nothing separates the arms.
    const one = block(5, "If", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } }, { range: { start: { line: 0, character: 11 }, end: { line: 0, character: 22 } } }]);
    assert.strictEqual(branchMark(cov([1], []), one, 0), "unmeasured");
    assert.strictEqual(branchMark(cov([1], []), one, 1), "unmeasured");
  });

  it("is unmeasured for a branch with no range (an older server)", () => {
    assert.strictEqual(branchMark(cov([1], []), block(4, "If", [{}]), 0), "unmeasured");
  });
});

describe("coverageNote and clockTime", () => {
  it("says what the marks are, when the run started, and that they are not per-test", () => {
    const [line] = coverageNote(cov([], [], { runAt: new Date(2026, 10, 17, 14, 32).getTime() }));
    assert.ok(line.includes("the whole project"));
    assert.ok(/started (14:32|16 Nov|17 Nov)/.test(line), line);
    assert.ok(line.includes("cannot say which test reached it"));
  });
  it("warns when the source changed after the run", () => {
    assert.strictEqual(coverageNote(cov([], [])).length, 1);
    const lines = coverageNote(cov([], [], { stale: true }));
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].includes("changed since that run"));
  });
  it("shows a time of day, with the date when it is not today", () => {
    const ran = new Date(2026, 10, 17, 9, 5).getTime();
    assert.strictEqual(clockTime(ran, new Date(2026, 10, 17, 23, 0).getTime()), "09:05");
    assert.strictEqual(clockTime(ran, new Date(2026, 10, 19, 8, 0).getTime()), "17 Nov, 09:05");
  });
});
