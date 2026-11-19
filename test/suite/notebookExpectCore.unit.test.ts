// #209: `expect` lines in notebook cells, the pure part: finding them, reading
// the failure `bynk eval` reports (v0.639.1: the first one only), and running a
// cell again with each failed one blanked to learn every outcome.

import * as assert from "assert";

import { NOTHING_LEFT, analyseCell, blankExpects, buildSnippet, rerunNote, decodeExpectFailure, expectDiagnostics, expectJson, expectations, matchFailure, renderExpectations, runWithExpectations, type EvalResult } from "../../src/notebookCore";
import { handlerSource } from "../../src/notebookHandlerCore";

const CELL = ["let a = discount(2000, 25)", "expect a == 1500", "expect a > 99999", "expect a", "  >= 3", "a"].join("\n");

/** What `bynk eval` v0.639.1 printed for a failed `expect`. */
const failure = (expr: string, detail = "", file = "src/shop/money.eval.bynk:2:8"): EvalResult => ({
  kind: "error",
  errorKind: "runtime",
  message: `${expr}${detail ? `\n${detail}` : ""}\n  at ${file}`,
  diagnostics: [],
});
const value = (v: unknown, type = "Int"): EvalResult => ({ kind: "value", value: v, type, diagnostics: [] });

describe("expect lines: finding them (#209)", () => {
  it("lists the top-level expects with their lines, a multi-line one as one", () => {
    assert.deepStrictEqual(
      expectations(CELL).map((e) => [e.line, e.end]),
      [
        [1, 1],
        [2, 2],
        [3, 4],
      ],
    );
  });
  it("leaves out an expect inside another statement, and the header's lines", () => {
    assert.deepStrictEqual(expectations("stub A.b(_) returns 1\nlet x = if true {\n  expect 1 == 1\n  2\n} else { 3 }\nx"), []);
  });
  it("blanks the given expects and keeps every line where it was", () => {
    const es = expectations(CELL);
    const out = blankExpects(CELL, [es[1], es[2]]);
    assert.deepStrictEqual(out.split("\n"), ["let a = discount(2000, 25)", "expect a == 1500", "", "", "", "a"]);
    assert.strictEqual(blankExpects(CELL, []), CELL);
  });
  it("does not carry an earlier cell's expects into a later one", () => {
    const snippet = buildSnippet(
      [
        { source: "let a = 1\nexpect a == 1\nlet b = a + 1\nexpect b == 2", unit: "u", ran: true },
        { source: "b", unit: "u", ran: false },
      ],
      1,
      "u",
    );
    assert.strictEqual(snippet.text, "let a = 1\nlet b = a + 1\nb");
  });
});

describe("expect lines: reading a failure (#209)", () => {
  it("reads the expect, the values compared and drops the position", () => {
    const f = decodeExpectFailure("expect a > 10000\n  expected: a > 10000\n  actual:   1500 > 10000\n  at src/shop/money.eval.bynk:2:8");
    assert.deepStrictEqual(f, { header: "expect a > 10000", detail: "expected: a > 10000\nactual:   1500 > 10000" });
  });
  it("reads an `is` expect, which has no values", () => {
    assert.deepStrictEqual(decodeExpectFailure("expect r is NotFound\n  at tests/todos.bynk:9:8"), { header: "expect r is NotFound", detail: "" });
  });
  it("reads an expect that spans lines", () => {
    const f = decodeExpectFailure("expect a ==\n  7\n  expected: a ==\n  7\n  actual:   1500 == 7\n  at src/m.eval.bynk:2:8");
    assert.strictEqual(f?.header, "expect a ==\n  7");
  });
  it("is not an expect failure for any other error", () => {
    assert.strictEqual(decodeExpectFailure("Mailer.send is not stubbed"), undefined);
    assert.strictEqual(decodeExpectFailure("an expectation was not met"), undefined);
  });
  it("matches the failure to its expect by text, not by the line in the synthetic file", () => {
    const es = expectations(CELL);
    assert.strictEqual(matchFailure({ header: "expect a > 99999", detail: "" }, es, -1), es[1]);
    assert.strictEqual(matchFailure({ header: "expect a\n  >= 3", detail: "" }, es, -1), es[2]);
    assert.strictEqual(matchFailure({ header: "expect nothing like it", detail: "" }, es, -1), undefined);
  });
  it("matches an expect that has a comment, which the message does not quote", () => {
    const es = expectations('expect a > 1 // floor\nexpect b == "//x" // why\nexpect c ==  // mid\n  3');
    assert.strictEqual(matchFailure({ header: "expect a > 1", detail: "" }, es, -1), es[0]);
    assert.strictEqual(matchFailure({ header: 'expect b == "//x"', detail: "" }, es, -1), es[1]);
    assert.strictEqual(matchFailure({ header: "expect c ==\n  3", detail: "" }, es, -1), es[2]);
  });
  it("matches the first one after the previous failure when the text is repeated", () => {
    const es = expectations("expect f() == 1\nexpect f() == 1\nexpect f() == 1");
    assert.strictEqual(matchFailure({ header: "expect f() == 1", detail: "" }, es, -1), es[0]);
    assert.strictEqual(matchFailure({ header: "expect f() == 1", detail: "" }, es, 0), es[1]);
  });
});

describe("expect lines: running until every one has an outcome (#209)", () => {
  /** A cell whose `fails` expects (by index) fail; the run stops at the first live one. */
  const cell = (fails: number[]) => {
    const es = expectations(CELL);
    const calls: number[][] = [];
    const attempt = async (blank: readonly (typeof es)[number][]) => {
      const blanked = new Set(blank);
      calls.push(es.map((e, i) => (blanked.has(e) ? i : -1)).filter((i) => i >= 0));
      const first = es.findIndex((e, i) => !blanked.has(e) && fails.includes(i));
      const result = first < 0 ? value(1500) : failure(es[first].text, `  expected: ${es[first].text}\n  actual:   (the values)`);
      return { result };
    };
    return { es, calls, attempt };
  };

  it("runs once when every expect holds", async () => {
    const { es, calls, attempt } = cell([]);
    const run = await runWithExpectations(es, attempt);
    assert.ok(run !== "cancelled");
    assert.deepStrictEqual(calls, [[]]);
    assert.strictEqual(rerunNote(run.runs), undefined);
    assert.deepStrictEqual(run.outcomes.map((o) => o.status), ["passed", "passed", "passed"]);
    assert.deepStrictEqual(run.last.result, value(1500));
  });
  it("runs again with the failed one blanked, to reach the value and the later expects", async () => {
    const { es, calls, attempt } = cell([1]);
    const run = await runWithExpectations(es, attempt);
    assert.ok(run !== "cancelled");
    assert.deepStrictEqual(calls, [[], [1]]);
    assert.deepStrictEqual(run.outcomes.map((o) => o.status), ["passed", "failed", "passed"]);
    assert.match(run.outcomes[1].detail ?? "", /expected: expect a > 99999/);
    assert.strictEqual(run.last.result.kind, "value");
  });
  it("reports every failure, one run each, and the expects before and after them", async () => {
    const { es, calls, attempt } = cell([0, 2]);
    const run = await runWithExpectations(es, attempt);
    assert.ok(run !== "cancelled");
    assert.deepStrictEqual(calls, [[], [0], [0, 2]]);
    assert.strictEqual(run.runs, 3);
    assert.match(rerunNote(run.runs) ?? "", /^Ran 3 times: .*stops at the first failed/);
    assert.deepStrictEqual(run.outcomes.map((o) => o.status), ["failed", "passed", "failed"]);
  });
  it("leaves the expects it never reached as not run when the cell then fails for its own reason", async () => {
    const es = expectations(CELL);
    let n = 0;
    const run = await runWithExpectations(es, async () => {
      n++;
      return { result: n === 1 ? failure(es[0].text) : ({ kind: "error", errorKind: "runtime", message: "Mailer.send is not stubbed", diagnostics: [] } as EvalResult) };
    });
    assert.ok(run !== "cancelled");
    assert.deepStrictEqual(run.outcomes.map((o) => o.status), ["failed", "not-run", "not-run"]);
    assert.match((run.last.result as { message: string }).message, /not stubbed/);
  });
  it("does not run a cell without expects more than once, whatever it answers", async () => {
    let n = 0;
    const run = await runWithExpectations([], async () => {
      n++;
      return { result: failure("expect x") };
    });
    assert.ok(run !== "cancelled");
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(run.outcomes, []);
  });
  it("reports an expect failure it cannot place as the cell's own error", async () => {
    const es = expectations(CELL);
    const run = await runWithExpectations(es, async () => ({ result: failure("expect something else") }));
    assert.ok(run !== "cancelled");
    assert.deepStrictEqual(run.outcomes.map((o) => o.status), ["not-run", "not-run", "not-run"]);
  });
  it("has nothing left to run when every expect of an expects-only cell has failed", async () => {
    const src = "expect total == 1\nexpect total == 2 // two";
    const es = expectations(src);
    const sent: string[] = [];
    const run = await runWithExpectations(es, async (blank) => {
      const text = blankExpects(src, blank);
      if (analyseCell(text).body.length === 0) return { result: NOTHING_LEFT };
      sent.push(text);
      const first = es.find((e) => !blank.includes(e)) as (typeof es)[number];
      return { result: failure(first.text.split(" //")[0], `  expected: ${first.text}`) };
    });
    assert.ok(run !== "cancelled");
    assert.strictEqual(sent.length, 2, "the empty cell is not sent");
    assert.deepStrictEqual(run.outcomes.map((o) => o.status), ["failed", "failed"]);
    assert.strictEqual(run.last.result, NOTHING_LEFT);
    assert.strictEqual(run.runs, 3);
  });
  it("stops when cancelled", async () => {
    assert.strictEqual(await runWithExpectations(expectations(CELL), async () => "cancelled"), "cancelled");
  });
});

describe("expect lines: showing them (#209)", () => {
  const es = expectations(CELL);
  const outcomes = [
    { expectation: es[0], status: "passed" as const },
    { expectation: es[1], status: "failed" as const, detail: "expected: a > 99999\nactual:   1500 > 99999" },
    { expectation: es[2], status: "not-run" as const },
  ];
  it("counts them and gives a line each, a failure with the values compared", () => {
    assert.strictEqual(
      renderExpectations(outcomes),
      ["Expectations: 1 passed, 1 failed, 1 not run", "", "✓ line 2  expect a == 1500", "✗ line 3  expect a > 99999", "    expected: a > 99999", "    actual:   1500 > 99999", "– line 4  expect a >= 3  (not reached)"].join("\n"),
    );
  });
  it("says nothing when none ran", () => {
    assert.strictEqual(renderExpectations(outcomes.map((o) => ({ ...o, status: "not-run" as const }))), "");
    assert.strictEqual(renderExpectations([]), "");
  });
  it("gives a failure as a diagnostic on the expect's own line, with the values", () => {
    const d = expectDiagnostics(outcomes, 3);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].cell, 3);
    assert.strictEqual(d[0].at, 2);
    assert.strictEqual(d[0].severity, "error");
    assert.match(d[0].message, /^expect a > 99999 failed:\nexpected: a > 99999\nactual: {3}1500 > 99999$/);
  });
  it("gives them as JSON, lines counted from 1", () => {
    assert.deepStrictEqual(expectJson(outcomes), {
      expectations: [
        { line: 2, text: "expect a == 1500", status: "passed" },
        { line: 3, text: "expect a > 99999", status: "failed", detail: "expected: a > 99999\nactual:   1500 > 99999" },
        { line: 4, text: "expect a >= 3", status: "not-run" },
      ],
    });
  });
});

describe("expect lines in a handler cell (#209)", () => {
  const CALL = 'let r <- api.POST("/todos", "x") by Visitor';
  it("observes the response of the call when expects follow it, the match after them", () => {
    const { text, cell } = handlerSource(["// @handler", "stub Mailer.send(_) returns true", CALL, "expect r is Created(_)", "expect trace(Mailer.send).length() == 1"].join("\n"));
    const lines = text.split("\n");
    assert.deepStrictEqual(lines.slice(0, 5), ["// @handler", "stub Mailer.send(_) returns true", CALL, "expect r is Created(_)", "expect trace(Mailer.send).length() == 1"]);
    assert.strictEqual(lines[5], "match r {");
    assert.strictEqual(cell.response, "r");
    assert.strictEqual(cell.appendedFrom, 5);
  });
  it("binds a bare call that the expects follow, keeping every line", () => {
    const { text, cell } = handlerSource(['api.POST("/todos", "x") by Visitor', "expect trace(Mailer.send).length() == 1"].join("\n"));
    assert.strictEqual(text.split("\n")[0], 'let response__ <- api.POST("/todos", "x") by Visitor');
    assert.strictEqual(text.split("\n")[1], "expect trace(Mailer.send).length() == 1");
    assert.deepStrictEqual([cell.response, cell.rewritten, cell.appendedFrom], ["response__", 0, 2]);
  });
  it("runs a cell of only expects as written", () => {
    assert.deepStrictEqual(handlerSource("expect 1 == 1\nexpect 2 == 2"), { text: "expect 1 == 1\nexpect 2 == 2", cell: {} });
  });
  it("does not shift an expect's line when the failed ones are blanked", () => {
    const src = ["stub Mailer.send(_) returns true", CALL, "expect r is NotFound", "expect r is Created(_)"].join("\n");
    const es = expectations(src);
    const { text } = handlerSource(blankExpects(src, [es[0]]));
    assert.deepStrictEqual(text.split("\n").slice(0, 4), ["stub Mailer.send(_) returns true", CALL, "", "expect r is Created(_)"]);
  });
});
