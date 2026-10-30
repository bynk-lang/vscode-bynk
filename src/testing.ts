// Bynk Test Explorer (v0.59).
//
// Runs a project's Bynk tests via `bynk test --format json` and reports
// pass/fail through the VS Code Test API, with click-through from a failing
// assertion to its `.bynk` source. The extension links no Rust — it shells the
// `bynk` driver (v0.138+, #487/#486), inheriting its richer `bynkc` resolution
// (`BYNK_BYNKC` → PATH → sibling-of-`bynk`) instead of reimplementing one here.
//
// Discovery (v0.67): `bynk test --no-run --format json` lists the project's
// suites/cases without running them — a pure compile, no `tsc`/`node`. The
// controller's `resolveHandler` seeds the tree from it when the Testing view
// opens and `refreshHandler` backs the Refresh control. A discovered case
// carries `outcome: "discovered"` and its declaration location, so the tree
// links to the `.bynk` source before any run. Without this seeding the tree is
// empty, VS Code shows its generic "no test provider" welcome, and `Run All` has
// no root item to dispatch, so a run can never be bootstrapped from the UI. A
// run (`--format json`, no `--no-run`) reconciles onto the same tree items
// (same suite name/kind, same case names) and adds pass/fail state.


import * as vscode from "vscode";

import { debugBynkTests } from "./debug";
import { devServerRunning, stopDevServer } from "./devServer";
import { ContinuousScheduler, FailureOnce, runPass } from "./continuousRun";
import type { ViewRefresh } from "./viewRefresh";
import type { DriverSupport } from "./testStream";
import { caseKey, casesInFile, debugTarget } from "./testPlan";
import { DEV_TARGET } from "./testTargets";
import { describePins, loadPins, savePins, suiteFingerprint, type SeedState } from "./testSeedState";
import { pickTarget } from "./testTargetPicker";
import { discover } from "./testDiscovery";
import { detailedCoverage } from "./testReport";
import type { RunEnv } from "./testEnv";
import { runHandler } from "./testRun";
import { caseItem, fileKey, findCase, findSuite, forEachCase, planCases, requestRef, requestedRoots } from "./testTree";

// The surface the integration tests and `testCodeLens.ts` reach through here.
export { applyDocument, placeHandlers, type HandlerLookup, type RunSink } from "./testReport";
export { runBynkcTestStream } from "./testDriver";
export { upsertCase } from "./testTree";
/** The slice — v0.78 — surface the discovered test locations + a change signal so the
 *  Test CodeLens provider (testCodeLens.ts) can place and refresh its lenses. */
export interface TestApi {
  /** Case declarations in `uri` — range + name (suites carry no discovered
   *  location). v0.127: the name feeds the per-case run/debug commands. */
  testCases(uri: vscode.Uri): { range: vscode.Range; name: string }[];
  /** Fires after a discovery settles (the tree may have changed). */
  onDidChangeTests: vscode.Event<void>;
}

export function registerTesting(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
  driverSupport: DriverSupport,
): TestApi {
  // What a driver understands is learned from its refusals (see `DriverSupport` in testStream.ts),
  // so it is forgotten when the user points the extension at a different binary.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("bynk.bynkPath") || e.affectsConfiguration("bynk.compilerPath")) {
        driverSupport.ndjson = true;
        driverSupport.sets = true;
      }
    }),
  );
  const ctrl = vscode.tests.createTestController("bynk", "Bynk Tests");
  context.subscriptions.push(ctrl);
  const seedState: SeedState = {
    pins: loadPins(context.workspaceState),
    failures: new Map(),
    generative: new Map(),
    store: context.workspaceState,
  };

  // Compile failures surfaced by a run go to the Problems panel, exactly as the
  // `bynkc: check` task does — but in their own collection so a later clean run
  // clears them without disturbing the LSP's live diagnostics.
  const problems = vscode.languages.createDiagnosticCollection("bynk-tests");
  context.subscriptions.push(problems);
  const env: RunEnv = { ctrl, problems, seeds: seedState, hub, driverSupport };

  // Slice E: the Run profile alone supports a continuous run (DECISION C). Debug is
  // interactive, and Coverage needs the `tsc → node` path, so on a machine with only
  // `tsx` every save would raise the "coverage is unavailable" notice.
  const profile = ctrl.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    (request, token) => (request.continuous ? watchTests(request, token) : runHandler(env, request, token)),
    true,
    undefined,
    true,
  );
  context.subscriptions.push(profile);

  // Slice E: the Watch toggle. Each continuous request is a set of items to keep
  // rerunning; they share one scheduler, so two watches never run at once, and one
  // failure policy, so a missing `bynk` is announced once for the session (DECISION
  // D). The session lasts while any watch is on. Turning Watch on does not itself
  // run anything: the tests run when a model source next changes.
  const watched = new Set<vscode.TestRunRequest>();
  let session: { scheduler: ContinuousScheduler; changes: vscode.Disposable } | undefined;
  const endSession = (): void => {
    session?.changes.dispose();
    session?.scheduler.dispose();
    session = undefined;
  };
  context.subscriptions.push({ dispose: endSession });

  const watchTests = (request: vscode.TestRunRequest, token: vscode.CancellationToken): void => {
    watched.add(request);
    if (!session) {
      const once = new FailureOnce();
      const scheduler = new ContinuousScheduler((slot) =>
        runPass([...watched], slot, once, async (watch) => {
          const cts = new vscode.CancellationTokenSource();
          const stop = slot.onCancel(() => cts.cancel());
          try {
            const rerun = new vscode.TestRunRequest(watch.include, watch.exclude, watch.profile, true);
            await runHandler(env, rerun, cts.token, false, undefined, undefined, once);
          } finally {
            stop();
            cts.dispose();
          }
        }),
      );
      session = { scheduler, changes: hub.onDidChangeSource(() => scheduler.signal()) };
    }
    token.onCancellationRequested(() => {
      watched.delete(request);
      if (watched.size === 0) endSession();
    });
  };

  // Test seam (not contributed, so never in the palette): turning Watch on in the real
  // UI goes through a quick pick, so the integration suite switches it here instead.
  let seamWatch: vscode.CancellationTokenSource | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand("bynk._watchTests", (on: boolean) => {
      seamWatch?.cancel();
      seamWatch?.dispose();
      seamWatch = undefined;
      if (!on) return;
      seamWatch = new vscode.CancellationTokenSource();
      watchTests(new vscode.TestRunRequest(undefined, undefined, profile, true), seamWatch.token);
    }),
  );

  // Slice B: run the `system` suites against a named target (`bynk test
  // --against`). One profile with a quick pick rather than one per target, so the
  // profile list does not track the manifest. Run-only: the driver refuses
  // `--against` with `--inspect` or `--coverage`, so there is no Debug or Coverage
  // variant of it. The extension passes only a name the manifest declares (or
  // `dev`, or one typed by hand, which the driver validates); it never builds an
  // endpoint, sets `BYNK_TEST_TARGETS` or reads a secret.
  const runAgainst = async (
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const roots = await requestedRoots(ctrl, request);
    const picked = await pickTarget(context, roots);
    if (!picked) return;
    const { target, declaring } = picked;
    if (target === DEV_TARGET && devServerRunning()) {
      // Like debug (#2094 DECISION C): a running `bynk dev` holds the ports the
      // test run's own dev server needs. Ask rather than fail on a clash.
      const stop = "Stop and Run";
      const choice = await vscode.window.showWarningMessage(
        "A Bynk dev server is running. Stop the running dev server and run the tests against dev?",
        { modal: true },
        stop,
      );
      if (choice !== stop) return;
      await stopDevServer();
    }
    await runHandler(env, request, token, false, { target, skipUnsupported: false, roots: declaring });
  };
  context.subscriptions.push(
    ctrl.createRunProfile("Run against…", vscode.TestRunProfileKind.Run, runAgainst, false),
  );

  // v0.72: the headline debug entry (ADR 0104, DECISION C). VS Code renders a
  // **Debug** action beside Run from this profile; it shells `bynk test
  // --inspect` and hands off to the JS debugger so a breakpoint in a test body
  // (or the code it exercises) pauses. The whole suite runs under the inspector;
  // the breakpoint decides where it stops.
  const debugProfile = ctrl.createRunProfile(
    "Debug",
    vscode.TestRunProfileKind.Debug,
    (request) => {
      // The selection decides the target: one case debugs just that case, and a
      // suite or several cases debug as one set (a driver that predates the set
      // filter cannot narrow them, so the whole project runs and the user is told).
      const target = debugTarget(planCases(ctrl), requestRef(request), { sets: driverSupport.sets });
      if (target.nothing) {
        void vscode.window.showInformationMessage(target.notice ?? "Bynk: nothing is selected to debug.");
        return;
      }
      if (target.notice) void vscode.window.showInformationMessage(target.notice);
      void debugBynkTests({ caseName: target.caseName, suites: target.suites, cases: target.cases });
    },
    false,
  );
  context.subscriptions.push(debugProfile);

  // #2104: **Run with Coverage** — the Run command plus `--coverage`. VS Code's
  // Test Coverage view shows each `.bynk` file's line percentage, and the
  // editor gutter marks covered and uncovered lines.
  const coverageProfile = ctrl.createRunProfile(
    "Coverage",
    vscode.TestRunProfileKind.Coverage,
    (request, token) => runHandler(env, request, token, true),
    false,
  );
  coverageProfile.loadDetailedCoverage = async (_run, fc) => detailedCoverage(fc);
  context.subscriptions.push(coverageProfile);

  // v0.78: one discovery runner, *coalesced* (never stack the project compile —
  // a request arriving mid-run sets a rerun flag) and signalling `changed` when it
  // settles. The view-open/refresh handlers and the eager triggers all route here.
  const changed = new vscode.EventEmitter<void>();
  let discovering = false;
  let rerun = false;
  // `only` limits a pass to the projects owning these files (an eager trigger knows
  // which project it touched); without it every project in the workspace is discovered.
  // A request that arrives mid-run is kept: all projects, or the union of the files.
  let queued: { all: boolean; files: Set<string> } = { all: false, files: new Set() };
  const runDiscovery = async (token?: vscode.CancellationToken, only?: vscode.Uri[]): Promise<void> => {
    if (discovering) {
      rerun = true;
      if (only) for (const f of only) queued.files.add(f.toString());
      else queued.all = true;
      return;
    }
    discovering = true;
    try {
      await discover(env, only, token);
    } finally {
      discovering = false;
      changed.fire();
      if (rerun) {
        rerun = false;
        const next = queued;
        queued = { all: false, files: new Set() };
        void runDiscovery(undefined, next.all ? undefined : [...next.files].map((f) => vscode.Uri.parse(f)));
      }
    }
  };

  // Seed the tree when the Testing view first resolves its root, and back the
  // Refresh control. VS Code calls `resolveHandler(undefined)` to discover the
  // top-level tests; we build the whole tree in one shot (projects + suites + cases).
  ctrl.resolveHandler = async (item) => {
    if (item) return;
    await runDiscovery();
  };
  ctrl.refreshHandler = (token) => runDiscovery(token);

  // v0.78: eager discovery — so the test items (and VS Code's native gutter glyphs,
  // and the CodeLens) exist whenever a `.bynk` file is on screen, not only when the
  // Testing view is open. Discovery compiles the files on disk, so it follows a save,
  // an open and a focus change — never a keystroke, whose edit it could not see.
  // Debounced (one project compile per burst), and limited to the touched projects.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touched = new Map<string, vscode.Uri>();
  const schedule = (doc: vscode.TextDocument): void => {
    if (doc.uri.scheme !== "file") return;
    touched.set(doc.uri.toString(), doc.uri);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...touched.values()];
      touched.clear();
      void runDiscovery(undefined, files);
    }, 500);
  };
  context.subscriptions.push({ dispose: () => timer && clearTimeout(timer) });
  const isBynk = (d?: vscode.TextDocument): d is vscode.TextDocument => d?.languageId === "bynk";

  context.subscriptions.push(
    changed,
    vscode.workspace.onDidOpenTextDocument((d) => isBynk(d) && schedule(d)),
    vscode.window.onDidChangeActiveTextEditor((e) => e && isBynk(e.document) && schedule(e.document)),
    vscode.workspace.onDidSaveTextDocument((d) => isBynk(d) && schedule(d)),
    // Slice B: the palette entry for the same thing, over every system test.
    vscode.commands.registerCommand("bynk.runTestsAgainst", async () => {
      const cts = new vscode.CancellationTokenSource();
      try {
        await runAgainst(new vscode.TestRunRequest(), cts.token);
      } finally {
        cts.dispose();
      }
    }),
    vscode.commands.registerCommand("bynk.runTests", () => {
      void vscode.commands.executeCommand("testing.runAll");
    }),
    // v0.78: the CodeLens "Debug Test" target — the suite runs under the inspector,
    // the breakpoint pauses.
    vscode.commands.registerCommand("bynk.debugTests", () => {
      void debugBynkTests();
    }),
    // v0.127 (editor-currency slice 6): the per-case run/debug lens targets. Run
    // routes a single-item request through the run handler (which threads
    // `--case`), so the tree item lights up its own pass/fail; debug launches the
    // inspector filtered to the one case. An unknown name falls back to the whole
    // project, so a stale lens never runs nothing.
    vscode.commands.registerCommand("bynk.runTestCase", async (name: string) => {
      const item = findCase(ctrl, name);
      if (!item) {
        void vscode.commands.executeCommand("testing.runAll");
        return;
      }
      const request = new vscode.TestRunRequest([item]);
      const cts = new vscode.CancellationTokenSource();
      try {
        await runHandler(env, request, cts.token);
      } finally {
        cts.dispose();
      }
    }),
    vscode.commands.registerCommand("bynk.debugTestCase", (name: string) => {
      void debugBynkTests(name);
    }),
    // Slice C: reproduce, pin and unpin a generative test's seed. The menu hands
    // over the test item; each needs a seed that a failed run reported.
    vscode.commands.registerCommand("bynk.rerunWithSeed", async (arg?: unknown) => {
      const item = caseItem(ctrl, arg);
      const failure = item && seedState.failures.get(item.id);
      if (!item || !failure) {
        void vscode.window.showInformationMessage(
          "Bynk: this test has no failed run with a seed to reproduce. Run it, and let it fail, first.",
        );
        return;
      }
      const cts = new vscode.CancellationTokenSource();
      try {
        await runHandler(env, new vscode.TestRunRequest([item]), cts.token, false, undefined, failure.seed);
      } finally {
        cts.dispose();
      }
    }),
    vscode.commands.registerCommand("bynk.pinSeed", async (arg?: unknown) => {
      const item = caseItem(ctrl, arg);
      const failure = item && seedState.failures.get(item.id);
      if (!item || !failure) {
        void vscode.window.showInformationMessage(
          "Bynk: this test has no failed run with a seed to pin. Run it, and let it fail, first.",
        );
        return;
      }
      seedState.pins.set(item.id, { seed: failure.seed, fingerprint: suiteFingerprint(seedState, item.id) });
      await savePins(seedState);
      describePins(ctrl, seedState);
    }),
    vscode.commands.registerCommand("bynk.unpinSeed", async (arg?: unknown) => {
      const item = caseItem(ctrl, arg);
      if (!item || !seedState.pins.delete(item.id)) return;
      await savePins(seedState);
      describePins(ctrl, seedState);
    }),
    // Slice A: run every test declared in a file. The cases come from the tree's
    // discovered locations, so it needs no new `bynk test` flag; the run plan then
    // decides between a process per case and one filtered whole-project run.
    vscode.commands.registerCommand("bynk.runTestsInFile", async (arg?: unknown) => {
      const uri =
        arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        void vscode.window.showInformationMessage("Bynk: open a .bynk file to run its tests.");
        return;
      }
      const refs = casesInFile(planCases(ctrl), fileKey(uri));
      const items = refs
        .map((r) => findSuite(ctrl, r.suiteId)?.children.get(caseKey(r.suiteId, r.name ?? "")))
        .filter((i): i is vscode.TestItem => i !== undefined);
      if (items.length === 0) {
        void vscode.window.showInformationMessage(
          `Bynk: no tests are declared in ${uri.path.split("/").pop() ?? "this file"}.`,
        );
        return;
      }
      const cts = new vscode.CancellationTokenSource();
      try {
        await runHandler(env, new vscode.TestRunRequest(items), cts.token);
      } finally {
        cts.dispose();
      }
    }),
  );
  // Discover now if a `.bynk` file is already the active document on activation.
  const activeDoc = vscode.window.activeTextEditor?.document;
  if (isBynk(activeDoc)) schedule(activeDoc);

  const testCases = (uri: vscode.Uri): { range: vscode.Range; name: string }[] => {
    const cases: { range: vscode.Range; name: string }[] = [];
    const target = uri.toString();
    forEachCase(ctrl, (c) => {
      if (c.uri?.toString() === target && c.range) {
        cases.push({ range: c.range, name: c.label });
      }
    });
    return cases;
  };

  return { testCases, onDidChangeTests: changed.event };
}
