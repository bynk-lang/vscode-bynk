// #188: the last coverage run on the project sidebar — the dependency-free core.
//
// The sidebar already holds each handler's whole declaration range (from
// document symbols; `bynk/architectureModel` carries name spans only), so the
// run's line coverage (`modelCoverageCore`) is projected onto those ranges.
// Line-level and whole-run (ADR 0514): a handler counts as tested when its
// lines ran, and nothing here says which test reached it.
//
// Pure: no `vscode`. `projectTree.ts` fetches the ranges and attaches the text.

import {
  type CoverageMark,
  type ModelCoverage,
  type StateCoverage,
  MARK_WORD,
  rangeMark,
  reached,
  tallyText,
} from "./modelCoverageCore";
import type { Range } from "./webview/types";

/** What a sidebar node shows of the run. */
export interface NodeCoverage {
  /** The node's description (`tested`, `3 of 5 transitions tested`). */
  description: string;
  /** Added to the node's tooltip: what the mark means, and the stale warning. */
  tooltip: string;
}

/** The tooltip lines every covered node carries. Never attributes coverage to a
 *  test: only that lines ran. */
export function coverageTooltip(cov: ModelCoverage): string {
  const lines = [
    `Line coverage of the last whole-run coverage run (${cov.scope}): it counts as tested when its lines ran, and cannot say which test reached it.`,
  ];
  if (cov.stale) lines.push("The source has changed since that run, so this may be out of date. Run with Coverage again.");
  return lines.join("\n");
}

/** A handler's mark over its whole declaration. */
export function handlerMark(cov: ModelCoverage | undefined, range: Range | null | undefined): CoverageMark {
  return cov ? rangeMark(cov, range) : "unmeasured";
}

/** A handler node's coverage, or `undefined` to leave it unmarked: no run, a
 *  file the run did not list, or a handler with no executable line (never
 *  called tested). */
export function handlerCoverage(cov: ModelCoverage | undefined, range: Range | null | undefined): NodeCoverage | undefined {
  if (!cov) return undefined;
  const mark = rangeMark(cov, range);
  if (mark === "unmeasured") return undefined;
  return { description: MARK_WORD[mark], tooltip: coverageTooltip(cov) };
}

/** An agent node's coverage: its state transitions when the agent's state model
 *  has some measured (`states`, one `StateCoverage` per state-holding field,
 *  from `stateCoverage`), otherwise the share of its handlers tested. Unmeasured
 *  elements are counted in the total and said so, as the model views do. */
export function agentCoverage(
  cov: ModelCoverage | undefined,
  states: readonly StateCoverage[],
  handlerMarks: readonly CoverageMark[],
): NodeCoverage | undefined {
  if (!cov) return undefined;
  const moves = states.reduce(
    (t, s) => ({ tested: t.tested + s.tally.tested, total: t.total + s.tally.total, unmeasured: t.unmeasured + s.tally.unmeasured }),
    { tested: 0, total: 0, unmeasured: 0 },
  );
  if (moves.total > 0 && moves.unmeasured < moves.total) {
    return { description: tallyText(moves, "transition"), tooltip: coverageTooltip(cov) };
  }
  if (handlerMarks.length === 0 || handlerMarks.every((m) => m === "unmeasured")) return undefined;
  return {
    description: tallyText(
      {
        tested: handlerMarks.filter(reached).length,
        total: handlerMarks.length,
        unmeasured: handlerMarks.filter((m) => m === "unmeasured").length,
      },
      "handler",
    ),
    tooltip: coverageTooltip(cov),
  };
}
