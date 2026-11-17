// #188: coverage on the project sidebar's handler and agent nodes. Pure.

import * as assert from "assert";

import type { ModelCoverage, StateCoverage } from "../../src/modelCoverageCore";
import { agentCoverage, coverageTooltip, handlerCoverage, handlerMark } from "../../src/projectCoverageCore";
import type { Range } from "../../src/webview/types";

/** Lines are 1-based in coverage, 0-based in ranges: `R(1, 3)` is lines 2-4. */
const R = (line: number, endLine = line): Range => ({
  start: { line, character: 0 },
  end: { line: endLine, character: 4 },
});
const cov = (ran: number[], missed: number[], over: Partial<ModelCoverage> = {}): ModelCoverage => ({
  runAt: 1_000,
  scope: "the whole project",
  stale: false,
  ran,
  missed,
  ...over,
});
const states = (tested: number, total: number, unmeasured = 0): StateCoverage => ({
  edges: [],
  transitions: {},
  states: {},
  tally: { tested, total, unmeasured },
});

describe("handlerCoverage", () => {
  it("says tested, partly tested and not tested", () => {
    const c = cov([2, 3, 6], [7, 10]);
    assert.strictEqual(handlerCoverage(c, R(1, 2))?.description, "tested");
    assert.strictEqual(handlerCoverage(c, R(5, 6))?.description, "partly tested");
    assert.strictEqual(handlerCoverage(c, R(9))?.description, "not tested");
  });
  it("leaves a handler with no executable line unmarked, never tested", () => {
    assert.strictEqual(handlerCoverage(cov([2], [3]), R(20, 22)), undefined);
    assert.strictEqual(handlerMark(cov([2], [3]), R(20, 22)), "unmeasured");
  });
  it("is unmarked without a run, or when the report did not list the file", () => {
    assert.strictEqual(handlerCoverage(undefined, R(1, 2)), undefined);
    assert.strictEqual(handlerMark(undefined, R(1, 2)), "unmeasured");
  });
  it("describes lines that ran, never a test, and warns when stale", () => {
    const fresh = handlerCoverage(cov([2], []), R(1))!.tooltip;
    assert.ok(/lines ran/.test(fresh) && /cannot say which test/.test(fresh), fresh);
    assert.ok(!/changed since/.test(fresh));
    const stale = handlerCoverage(cov([2], [], { stale: true }), R(1))!.tooltip;
    assert.ok(/changed since that run/.test(stale), stale);
    assert.ok(coverageTooltip(cov([], [], { scope: 'the case "x"' })).includes('the case "x"'));
  });
});

describe("agentCoverage", () => {
  const c = cov([2], [3]);
  it("counts transitions from the state model, across its fields", () => {
    assert.strictEqual(agentCoverage(c, [states(2, 3), states(1, 2)], [])?.description, "3 of 5 transitions tested");
  });
  it("says how many transitions were not measured", () => {
    assert.strictEqual(agentCoverage(c, [states(1, 3, 1)], [])?.description, "1 of 3 transitions tested (1 not measured)");
  });
  it("falls back to the share of handlers tested when there is no state model", () => {
    assert.strictEqual(agentCoverage(c, [], ["covered", "uncovered", "partial"])?.description, "2 of 3 handlers tested");
  });
  it("falls back when no transition was measured", () => {
    assert.strictEqual(agentCoverage(c, [states(0, 2, 2)], ["covered", "uncovered"])?.description, "1 of 2 handlers tested");
  });
  it("leaves an agent with nothing measured unmarked", () => {
    assert.strictEqual(agentCoverage(c, [], ["unmeasured"]), undefined);
    assert.strictEqual(agentCoverage(c, [], []), undefined);
    assert.strictEqual(agentCoverage(undefined, [states(1, 1)], ["covered"]), undefined);
  });
  it("carries the stale warning", () => {
    assert.ok(/changed since/.test(agentCoverage(cov([2], [], { stale: true }), [states(1, 1)], [])!.tooltip));
  });
});
