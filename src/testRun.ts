// Run orchestration: plan a request, run `bynk test` per project and report onto
// the `TestRun`. Split out of `testing.ts`.

import * as vscode from "vscode";

import { BynkNotFoundError } from "./cli";
import { offerDoctor, reportBynkNotFound } from "./doctor";
import { coverageFiles, coverageUnavailable } from "./coverageModel";
import type { FailureOnce } from "./continuousRun";
import type { ViewRefresh } from "./viewRefresh";
import { rejectsSets, type DriverSupport } from "./testStream";
import {
  carriesTiers,
  coverageScope,
  groupByProject,
  planRun,
  projectOf,
  runNotes,
  systemOnly,
  unreported,
  type PlanCase,
  type RequestRef,
  type RunPlan,
  type TestRun,
} from "./testPlan";
import { parseCompileDiagnostics } from "./testDiagnosticsCore";
import { seedFor } from "./testSeeds";
import { offersSkipUnsupported, targetDetail, DEV_TARGET } from "./testTargets";
import { rememberSeeds, suiteFingerprint, type SeedState } from "./testSeedState";
import type { RunEnv } from "./testEnv";
import { runBynkcTest, runBynkcTestStream } from "./testDriver";
import { applyDocument, coverageDetail, placeHandlers } from "./testReport";
import {
  forEachCase,
  planCases,
  projectItem,
  projectLabel,
  requestRef,
  requestedRoots,
  upsertCase,
  upsertSuite,
} from "./testTree";

/** A run against a named target (`bynk test --against`). */
export interface AgainstRun {
  target: string;
  /** Pass `--skip-unsupported`: offered as a retry, never the default. */
  skipUnsupported: boolean;
  /** The projects that declare the target; others in the request are left out. */
  roots?: vscode.Uri[];
}

export async function runHandler(
  env: RunEnv,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  coverage = false,
  against?: AgainstRun,
  seedOverride?: string,
  once?: FailureOnce,
): Promise<void> {
  // Slice E (DECISION F): a coverage run of one case is named for it, so the Coverage
  // view says which case the report measures and it is never taken for the project's.
  const { ctrl, problems } = env;
  const scope = coverage ? coverageScope(planRun(planCases(ctrl), requestRef(request), { coverage: true })) : undefined;
  const run = ctrl.createTestRun(request, scope?.kind === "case" ? `Coverage: ${scope.name}` : undefined);
  problems.clear();

  // The projects come from the requested items, never from the editor that happens to
  // be focused; a request spanning several projects runs once in each. Before the tree
  // has been discovered there are no items, and "Run All" runs every project found.
  let roots = await requestedRoots(ctrl, request);
  if (against?.roots) {
    const declaring = new Set(against.roots.map((r) => r.toString()));
    roots = roots.filter((r) => declaring.has(r.toString()));
  }
  if (roots.length === 0) {
    run.appendOutput("Bynk: no bynk.toml found in the workspace.\r\n");
    run.end();
    return;
  }
  const requestedAll = requestRef(request);
  const included = requestedAll.include ? groupByProject(requestedAll.include) : undefined;
  for (const root of roots) {
    if (token.isCancellationRequested) break;
    const key = root.toString();
    const requested: RequestRef = {
      include: included ? (included.get(key) ?? []) : undefined,
      exclude: requestedAll.exclude?.filter((r) => projectOf(r.suiteId) === key),
    };
    const cases = planCases(ctrl).filter((c) => projectOf(c.suiteId) === key);
    const label = roots.length > 1 ? projectLabel(root) : undefined;
    const again = await runInProject(env, run, root, request, requested, cases, token, coverage, against, once, seedOverride, label);
    if (again === "retry") {
      run.end();
      return runHandler(env, request, token, coverage, against, seedOverride, once);
    }
  }
  run.end();
}

/** One project's share of a run: plan its requested items, run `bynk test` in its
 *  root, and report onto `run`. Returns `"retry"` when the driver turned out not to
 *  understand sets, so the whole request is planned again as one process per case. */
export async function runInProject(
  env: RunEnv,
  run: vscode.TestRun,
  root: vscode.Uri,
  request: vscode.TestRunRequest,
  requested: RequestRef,
  cases: PlanCase[],
  token: vscode.CancellationToken,
  coverage: boolean,
  against: AgainstRun | undefined,
  once: FailureOnce | undefined,
  seedOverride?: string,
  label?: string,
): Promise<"retry" | void> {
  const { ctrl, problems, seeds, hub, driverSupport } = env;
  // With several projects in the run, say which one a message is about.
  const say = (m: string): void => run.appendOutput(label ? m.replace(/^Bynk:/, `Bynk (${label}):`) : m);
  // DECISION D: in a continuous session a notification is shown once, and every
  // failure is still written to the run's output.
  const notify = (kind: string, show: () => void): void => {
    if (!once || once.first(kind)) show();
  };

  // Slice A: the selection decides the processes and what the run may report.
  // `--case` takes one name, so a handful of cases run one process each and
  // anything larger runs the whole project once; either way only the requested
  // items are reported, and excluded ones are not.
  if (against) {
    // Only the `system` suites run against a target; anything else selected is
    // left as it was.
    const system = systemOnly(cases, requested);
    if (system.empty) {
      say(`Bynk: none of the selected tests is system-tier, so nothing runs against ${against.target}.\r\n`);
      return;
    }
    cases = system.cases;
    requested = system.request;
    say(`Bynk: running the system tests against ${against.target}.\r\n`);
    if (against.target !== DEV_TARGET) say(`Bynk: ${targetDetail(against.target)}\r\n`);
  }
  const planned = planRun(cases, requested, { coverage, remote: against !== undefined, sets: driverSupport.sets });
  // The tree holds every tier, so a run against a target reports only what it
  // asked for, not whatever else the document happens to carry.
  const plan: RunPlan = against ? { ...planned, narrowed: true } : planned;
  if (plan.steps.length === 0) {
    say("Bynk: nothing is selected to run.\r\n");
    return;
  }
  // DECISION E: a coverage report is one case's or the whole project's, never a merge
  // of processes; a selection that is neither runs the project, and says so. Said from
  // the plan that runs, which the tree may have changed under since the run was named.
  const measured = coverage ? coverageScope(plan) : undefined;
  if (measured?.kind === "case") {
    say(`Bynk: coverage for the case "${measured.name}" alone — not the project's coverage report.\r\n`);
  } else if (measured?.narrowed) {
    // One item selected and yet the project ran: the plan only does that for a name
    // another suite shares, which `--case` would run in both.
    const why = plan.wanted.length === 1 ? " (another suite has a case with this name, and `--case` would run both)" : "";
    say(
      `Bynk: coverage measures one case or the whole project, so this ran the whole project${why}; the report is the project's, not the selection's.\r\n`,
    );
  }
  const items = new Map<string, vscode.TestItem>();
  forEachCase(ctrl, (c) => items.set(c.id, c));
  for (const key of plan.wanted) {
    const item = items.get(key);
    if (item) run.enqueued(item);
  }

  // Slice C: a pinned seed (or the one "Re-run with this seed" supplies) goes to a
  // run of exactly one case, since the seed is the run's root and one value per
  // process; a whole-project or suite run always draws a fresh one.
  const only = plan.steps.length === 1 && plan.steps[0].caseName !== undefined && plan.wanted.length === 1 && !against;
  let seed: string | undefined;
  if (only) {
    const key = plan.wanted[0];
    const chosen = seedOverride
      ? { seed: seedOverride, note: undefined }
      : seedFor(key, seeds.pins, (k) => suiteFingerprint(seeds, k), key.slice(key.indexOf("::") + 2));
    seed = chosen.seed;
    if (chosen.note) say(`Bynk: ${chosen.note}.\r\n`);
    if (seed) say(`Bynk: running with seed ${seed}.\r\n`);
  }

  const reported = new Set<string>();
  const noted = new Set<string>();
  let crashShown = false;
  let coverageDoc: TestRun | undefined;

  for (const step of plan.steps) {
    if (token.isCancellationRequested) break;

    // Slice D: apply the results to the tree one case at a time, as the driver
    // reports each, rather than all at once when it exits. Coverage is a whole-run
    // report and stays the one document, as does a driver that has no stream.
    // #2359: placing a refused step's handler asks the language server, so applying is
    // chained to keep the cases in the order the driver reported them; `settle` waits
    // for the chain before anything reads `reported` or ends the run.
    let applying: Promise<void> = Promise.resolve();
    const settle = () => applying;
    const applyResults = (results: TestRun, whole: TestRun = results) => {
      applying = applying.then(async () => {
        try {
          // A run that was told to stop (a newer change superseded it, DECISION B) shows
          // nothing more: its results describe code that has since changed.
          if (token.isCancellationRequested) return;
          const handlerAt = await placeHandlers(root, results, hub);
          if (token.isCancellationRequested) return;
          for (const key of applyDocument(
            run, items, plan, results, root,
            (suite, c) =>
              upsertCase(ctrl, upsertSuite(ctrl, projectItem(ctrl, root), suite, root), c, root, carriesTiers(whole.suites ?? []) ? undefined : suite.kind),
            handlerAt,
            root.toString(),
          )) {
            reported.add(key);
          }
        } catch (e) {
          // One case that cannot be applied must not drop the rest, nor hide the run's own error.
          say(`Bynk: could not report a test result — ${String(e)}\r\n`);
        }
      });
    };
    const stepOptions = {
      caseName: step.caseName,
      suites: step.suites,
      cases: step.cases,
      coverage,
      against: against?.target,
      skipUnsupported: against?.skipUnsupported,
      seed,
    };
    let doc: TestRun;
    let streamed = false;
    try {
      if (!coverage && driverSupport.ndjson) {
        ({ doc, streamed } = await runBynkcTestStream(root, token, stepOptions, (shown, soFar) =>
          applyResults({ passed: 0, failed: 0, suites: [shown] }, soFar),
        driverSupport));
      } else {
        doc = await runBynkcTest(root, token, stepOptions);
      }
    } catch (e) {
      await settle();
      // A cancelled run kills the process, which leaves no parseable document:
      // that is the user stopping the run, not a failure to run.
      if (token.isCancellationRequested) break;
      // A driver that predates the set filter (#2273) rejects a repeated `--case` or
      // a `--suite` before it runs anything. Remember that and plan the selection as
      // it was before: one process per case, or the whole project.
      if (driverSupport.sets && (step.suites || step.cases) && rejectsSets(String(e))) {
        driverSupport.sets = false;
        say("Bynk: this `bynk` cannot run several tests in one process; running them one at a time.\r\n");
        return "retry";
      }
      say(`Bynk: could not run tests — ${String(e)}\r\n`);
      // #2095: `bynk` missing is the one gap the Doctor can't diagnose; any
      // other failure to run is most likely a missing test tool.
      if (e instanceof BynkNotFoundError) notify("bynk-not-found", () => void reportBynkNotFound());
      else notify("could-not-run", () => void offerDoctor("Bynk: could not run the tests.", "test"));
      return;
    }
    // The process can finish just as a newer change cancels the run; its document is
    // stale all the same.
    if (token.isCancellationRequested) break;

    // A compile failure has no test outcomes: route the diagnostics to the
    // Problems panel (the `bynkc` shape) and stop. These are not test results.
    if (doc.error?.kind === "compile") {
      routeCompileDiagnostics(problems, root, doc.error.diagnostics ?? []);
      say(
        "Bynk: the project did not compile — see the Problems panel.\r\n",
      );
      if (against && !against.skipUnsupported && offersSkipUnsupported(doc.error.diagnostics ?? [])) {
        offerSkipUnsupported(env, request, against);
      }
      return;
    }

    if (!streamed) applyResults(doc);
    await settle();
    rememberSeeds(seeds, doc, reported, root);

    for (const note of runNotes(doc)) {
      if (!noted.has(note)) {
        noted.add(note);
        say(`Bynk: ${note}.\r\n`);
      }
    }

    // A runtime crash: the prefix above already reported; surface the crash as a
    // run-level note (not a `bynkc` diagnostic — it isn't one).
    const unavailable = coverage ? coverageUnavailable(doc.error?.message) : undefined;
    if (unavailable) {
      // #2104: the environment can't measure coverage (only `tsx`): relay the
      // driver's own reason, rather than failing silently.
      say(`Bynk: coverage is unavailable — ${unavailable}\r\n`);
      if (!crashShown) {
        crashShown = true;
        void offerDoctor(`Bynk: coverage is unavailable. ${unavailable}`, "test");
      }
    } else if (against && doc.error?.kind === "runtime" && !doc.suites?.length) {
      // The driver declined the run (an unknown or production target, a missing
      // secret, an unreachable target): its own message says why, and nothing
      // crashed, so no Doctor offer.
      say(`Bynk: the run against ${against.target} did not happen — ${doc.error.message ?? "unknown error"}\r\n`);
    } else if (doc.error?.kind === "runtime") {
      say(
        `Bynk: the test runner crashed — ${doc.error.message ?? "unknown error"}\r\n`,
      );
      if (doc.error.stderr) {
        say(doc.error.stderr.replace(/\n/g, "\r\n") + "\r\n");
      }
      if (!crashShown) {
        crashShown = true;
        notify("crash", () => void offerDoctor("Bynk: the test runner crashed.", "test"));
      }
    }
    coverageDoc = doc;
  }

  // A requested item no result reached: say so, rather than leave it queued.
  if (!token.isCancellationRequested) {
    for (const key of unreported(plan, reported)) {
      const item = items.get(key);
      if (!item) continue;
      run.errored(
        item,
        new vscode.TestMessage(
          "This test was not in the run's results. The test tree may be out of date; " +
            "refresh the Testing view.",
        ),
      );
    }
  }

  // #2104: the run's `.bynk` line coverage, resolved against the project root
  // this run used. A coverage run is one process, so it is reported once.
  if (coverage && coverageDoc?.coverage) {
    for (const f of coverageFiles(coverageDoc.coverage, root.fsPath)) {
      const fc = new vscode.FileCoverage(
        vscode.Uri.file(f.file),
        new vscode.TestCoverageCount(f.covered, f.total),
      );
      coverageDetail.set(fc, f.statements);
      run.addCoverage(fc);
    }
  }

}

/** Route `path:line:col: severity[category]: message` lines (the same shape the
 *  `$bynkc` problem-matcher parses) into the Problems panel. */
export function routeCompileDiagnostics(
  problems: vscode.DiagnosticCollection,
  root: vscode.Uri,
  lines: string[],
): void {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const d of parseCompileDiagnostics(lines)) {
    const uri = vscode.Uri.joinPath(root, d.file);
    const pos = new vscode.Position(d.line, d.col);
    const diag = new vscode.Diagnostic(
      new vscode.Range(pos, pos),
      d.message,
      d.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning,
    );
    diag.code = d.code;
    diag.source = "bynkc";
    const key = uri.toString();
    const list = byFile.get(key);
    if (list) list.push(diag);
    else byFile.set(key, [diag]);
  }
  for (const [key, diags] of byFile) {
    problems.set(vscode.Uri.parse(key), diags);
  }
}

/** After the driver refused a run for a case a real runtime cannot honour, offer
 *  to run again skipping those cases. Never the default: the refusal is shown
 *  first, and skipping is the user's call. */
export function offerSkipUnsupported(
  env: RunEnv,
  request: vscode.TestRunRequest,
  against: AgainstRun,
): void {
  const retry = "Retry, skipping unsupported cases";
  void vscode.window
    .showWarningMessage(
      `Bynk: a system test cannot run against ${against.target} (see the Problems panel).`,
      retry,
    )
    .then(async (choice) => {
      if (choice !== retry) return;
      const cts = new vscode.CancellationTokenSource();
      try {
        await runHandler(env, request, cts.token, false, { ...against, skipUnsupported: true });
      } finally {
        cts.dispose();
      }
    });
}
