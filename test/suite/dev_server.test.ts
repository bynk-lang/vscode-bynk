// #2094 integration test: `Bynk: Start Dev Server` runs `bynk dev --format json`
// as the `bynk: dev` task, and `Bynk: Stop Dev Server` ends it with a SIGTERM to
// its process group. Runs against the stand-in `bynk` (test/fixtures/fake-bynk),
// so it needs no wrangler and serves nothing real.

import * as assert from "assert";
import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

function nextTask(
  event: vscode.Event<vscode.TaskStartEvent | vscode.TaskEndEvent>,
): Promise<vscode.TaskExecution> {
  return new Promise((resolve) => {
    const sub = event((e) => {
      if (e.execution.task.definition.type === "bynk") {
        sub.dispose();
        resolve(e.execution);
      }
    });
  });
}

describe("Bynk dev server (#2094)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;

  before(async () => {
    fake = await useFakeBynk();
  });

  after(async () => {
    await vscode.commands.executeCommand("bynk.stopDevServer");
    await fake.restore();
  });

  it("contributes the bynk: dev task", async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: "bynk" });
    const dev = tasks.find((t) => t.definition.command === "dev");
    assert.ok(dev, "a bynk: dev task is provided");
    assert.strictEqual(dev.isBackground, true);
  });

  it("starts `bynk dev --format json` and stops its process group", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(30_000);

    const started = nextTask(vscode.tasks.onDidStartTask);
    await vscode.commands.executeCommand("bynk.startDevServer");
    const execution = await started;
    assert.strictEqual(execution.task.definition.command, "dev");

    await waitFor(() => fake.read().some((e) => e.argv?.[0] === "dev"), truthy, "the stand-in to start");
    const argv = fake.read().find((e) => e.argv?.[0] === "dev")!.argv!;
    assert.deepStrictEqual(argv.slice(0, 3), ["dev", "--format", "json"]);

    const ended = nextTask(vscode.tasks.onDidEndTask);
    await vscode.commands.executeCommand("bynk.stopDevServer");
    await ended;
    assert.ok(
      fake.read().some((e) => e.signal === "SIGTERM"),
      "Stop sends SIGTERM, which `bynk dev` traps to tear down every worker",
    );
  });

  it("puts a failing rebuild in Problems and clears it on the next good one", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    const devProblems = () =>
      vscode.languages
        .getDiagnostics()
        .flatMap(([, ds]) => ds)
        .filter((d) => d.source === "bynk dev");
    // The stand-in emits `rebuild_failed` after 1s and `rebuild_ok` after 5s,
    // and its `check` reports one error meanwhile.
    process.env.BYNK_FAKE_DEV = "rebuilds";
    try {
      const started = nextTask(vscode.tasks.onDidStartTask);
      await vscode.commands.executeCommand("bynk.startDevServer");
      await started;
      await waitFor(() => devProblems().length > 0, truthy, "the rebuild error in Problems");
      const [diag] = devProblems();
      assert.strictEqual(diag.message, "fake rebuild error");
      assert.strictEqual(diag.code, "bynk.fake.rebuild");
      await waitFor(() => devProblems().length === 0, truthy, "the good rebuild to clear Problems");
      assert.ok(
        fake.read().some((e) => e.argv?.join(" ") === "check . --format short"),
        "the failing rebuild ran `bynk check . --format short`",
      );
    } finally {
      const ended = nextTask(vscode.tasks.onDidEndTask);
      await vscode.commands.executeCommand("bynk.stopDevServer");
      await ended;
      delete process.env.BYNK_FAKE_DEV;
    }
  });

  it("shows the workers' logs, with .bynk frames, filterable by level and context (#2474)", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(45_000);
    const lines = () => vscode.commands.executeCommand<string[]>("bynk.logLines").then((l) => l ?? []);
    await vscode.commands.executeCommand("bynk.clearLogs");
    process.env.BYNK_FAKE_DEV = "logs";
    try {
      const started = nextTask(vscode.tasks.onDidStartTask);
      await vscode.commands.executeCommand("bynk.startDevServer");
      await started;
      assert.ok(
        fake.read().some((e) => e.argv?.includes("--log-events")),
        "the session asks the driver for log events",
      );
      await waitFor(
        async () => (await lines()).some((l) => l.includes("slow handler")),
        truthy,
        "the worker logs in the view",
      );
      const shown = await lines();
      assert.ok(shown.some((l) => l === "[fixture] Error: boom"), "a headline is tagged with its context");
      assert.ok(
        shown.some((l) => l === "[fixture]     at http_GET (/work/src/shop.bynk:12:3)"),
        "a frame keeps its .bynk location, for the output channel to link",
      );

      await vscode.commands.executeCommand("bynk.filterLogs", { minLevel: "error" });
      const errors = await lines();
      assert.ok(errors.every((l) => !l.includes("GET / 500") && !l.includes("slow handler")));
      assert.ok(errors.some((l) => l.includes("shop.bynk:12:3")), "the errors stay");

      await vscode.commands.executeCommand("bynk.filterLogs", { minLevel: "info", contexts: ["other"] });
      const other = (await lines()).filter((l) => !l.includes("--- bynk dev"));
      assert.deepStrictEqual(other, ["[other] ▲ [WARNING] slow handler"]);

      await vscode.commands.executeCommand("bynk.filterLogs", { minLevel: "info" });
      assert.ok((await lines()).length >= 4, "clearing the filter shows them all again");

      await vscode.commands.executeCommand("bynk.clearLogs");
      assert.deepStrictEqual(await lines(), [], "Clear empties the buffer");
    } finally {
      const ended = nextTask(vscode.tasks.onDidEndTask);
      await vscode.commands.executeCommand("bynk.stopDevServer");
      await ended;
      delete process.env.BYNK_FAKE_DEV;
    }
  });

  // #143: `--trace-events`, the `request` events, and the store behind the
  // sequence diagram's overlay. The stand-in writes bynk v0.639.1's exact shape.
  it("asks for request traces, and keeps each request with its steps and callee joined (#143)", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(45_000);
    type Traces = Array<{
      id: string;
      context: string;
      route: string;
      status: number;
      steps: Array<{ target: string; outcome: string; at: { uri: string; range: { start: { line: number; character: number } } } | null }>;
      fault: { message: string; frames: Array<{ text: string; at: unknown }> } | null;
      callees: Record<number, { id: string; route: string }>;
    }>;
    const traces = () => vscode.commands.executeCommand<Traces>("bynk._requestTraces").then((t) => t ?? []);
    process.env.BYNK_FAKE_DEV = "traces";
    try {
      const started = nextTask(vscode.tasks.onDidStartTask);
      await vscode.commands.executeCommand("bynk.startDevServer");
      await started;
      assert.ok(fake.read().some((e) => e.argv?.includes("--trace-events")), "the session asks the driver for traces");
      const all = await waitFor(traces, (t) => t.some((x) => x.id === "r1"), "the request trace to arrive");
      const r1 = all.find((t) => t.id === "r1")!;
      assert.strictEqual(r1.route, "GET /a");
      assert.strictEqual(r1.status, 500);
      assert.deepStrictEqual(r1.steps.map((s) => s.target), ["other.authorise", "Ledger.tally"]);
      assert.ok(r1.steps[0].at?.uri.endsWith("/src/shop.bynk"), "a span resolves into the project");
      assert.deepStrictEqual(r1.steps[0].at?.range.start, { line: 4, character: 4 }, "1-based line and column become 0-based");
      assert.strictEqual(r1.steps[1].at, null, "a step with no span has no location");
      assert.deepStrictEqual(r1.callees[0].id, "c1", "the caller's step is joined to the callee's request");
      assert.strictEqual(r1.fault?.message, "Error: boom");
      assert.ok(r1.fault?.frames[0].at, "a .bynk frame links to its source");
      assert.strictEqual(r1.fault?.frames[1].at, null, "a frame outside .bynk does not");
      const lines = await vscode.commands.executeCommand<string[]>("bynk.logLines");
      assert.ok(!(lines ?? []).some((l) => l.includes("GET /a")), "a trace is never written to the logs");
    } finally {
      const ended = nextTask(vscode.tasks.onDidEndTask);
      await vscode.commands.executeCommand("bynk.stopDevServer");
      await ended;
      delete process.env.BYNK_FAKE_DEV;
    }
  });

  // #218: the request timing diagram, from the same stand-in's events.
  it("shows a request's timing: nested callee, longest chain, outcomes, comparison (#218)", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(45_000);
    interface Bar {
      id: string;
      row: string;
      label: string;
      kind: string;
      start: number;
      end: number;
      ms: number;
      outcome: string;
      critical: boolean;
      at: { uri: string; range: { start: { line: number; character: number } } } | null;
    }
    interface Snapshot {
      requestId: string;
      route: string;
      choices: string[];
      timeline: { rows: Array<{ label: string; kind: string; depth: number }>; bars: Bar[]; end: number; critical: string[]; unjoined: number };
      comparison?: { b: { bars: Bar[] }; deltas: Record<string, number>; totalDelta: number; onlyA: string[]; onlyB: string[]; end: number };
    }
    const need = <T>(v: T | undefined, what = "a value"): T => {
      assert.ok(v !== undefined, `expected ${what}`);
      return v;
    };
    const timing = (...args: string[]) => vscode.commands.executeCommand<Snapshot | undefined>("bynk.showRequestTiming", ...args);
    process.env.BYNK_FAKE_DEV = "traces";
    process.env.BYNK_FAKE_TRACE_SECOND = "1";
    try {
      const started = nextTask(vscode.tasks.onDidStartTask);
      await vscode.commands.executeCommand("bynk.startDevServer");
      await started;
      await waitFor(
        () => vscode.commands.executeCommand<Array<{ id: string }>>("bynk._requestTraces").then((t) => t ?? []),
        (t) => t.some((x) => x.id === "r2"),
        "both requests to arrive",
      );

      // No argument: the newest request.
      const newest = await timing();
      assert.strictEqual(newest?.requestId, "r2");

      const one = need(await timing("r1"));
      assert.strictEqual(one.route, "GET /a");
      assert.deepStrictEqual(
        one.timeline.rows.map((r) => [r.label, r.kind, r.depth]),
        [
          ["GET /a", "request", 0],
          ["other", "call", 1],
          ["POST /authorise", "request", 2],
          ["Db", "capability", 3],
          ["Ledger", "agent", 1],
        ],
        "the callee joined by request/parent is nested under its call, with its own step",
      );
      const bar = (label: string): Bar => need(one.timeline.bars.find((b) => b.label === label), label);
      // Durations only: end to end, in order.
      assert.deepStrictEqual([bar("other.authorise").start, bar("other.authorise").end], [0, 3.1]);
      assert.deepStrictEqual([bar("Ledger.tally").start, bar("Ledger.tally").end], [3.1, 4.3]);
      assert.deepStrictEqual([bar("Db.query").start, bar("Db.query").end], [0, 1.5], "the callee's step starts where its call does");
      assert.strictEqual(bar("Ledger.tally").outcome, "fault");
      assert.ok(bar("other.authorise").at?.uri.endsWith("/src/shop.bynk"), "a bar opens its call site");
      assert.deepStrictEqual(bar("other.authorise").at?.range.start, { line: 4, character: 4 });
      assert.strictEqual(bar("Ledger.tally").at, null);
      assert.deepStrictEqual(
        one.timeline.critical.map((id) => one.timeline.bars.find((b) => b.id === id)?.label),
        ["GET /a", "other.authorise", "POST /authorise", "Db.query"],
        "the longest chain: the heaviest step, then into its callee",
      );
      assert.strictEqual(one.timeline.end, 12.5);
      assert.strictEqual(one.timeline.unjoined, 0);
      assert.deepStrictEqual(one.choices.sort(), ["r1", "r2"], "the page can pick and compare traces of this route");

      // The panel's own view of what it holds.
      const held = need(await vscode.commands.executeCommand<Snapshot | undefined>("bynk._requestTiming"));
      assert.strictEqual(held.requestId, "r1");

      // Two traces of the route, stacked.
      const both = need(await timing("r1", "r2"));
      const cmp = need(both.comparison);
      assert.strictEqual(cmp.totalDelta, -9, "r2 took 3.5 ms against r1's 12.5");
      const tally = need(cmp.b.bars.find((b) => b.label === "Ledger.tally"));
      assert.ok(Math.abs((cmp.deltas[tally.id] ?? 0) - -0.8) < 1e-9, "the delta is on B's own step");
      assert.strictEqual(cmp.onlyA.length + cmp.onlyB.length, 0);

      // A request that is not held says so; nothing is drawn.
      assert.strictEqual(await timing("nope"), undefined);

      const lines = await vscode.commands.executeCommand<string[]>("bynk.logLines");
      assert.ok(!(lines ?? []).some((l) => l.includes("GET /a")), "a trace is never written to the logs");
    } finally {
      const ended = nextTask(vscode.tasks.onDidEndTask);
      await vscode.commands.executeCommand("bynk.stopDevServer");
      await ended;
      delete process.env.BYNK_FAKE_DEV;
      delete process.env.BYNK_FAKE_TRACE_SECOND;
    }
  });

  it("starts an older bynk without --trace-events, and says so once in the logs (#143)", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    await vscode.commands.executeCommand("bynk.clearLogs");
    process.env.BYNK_FAKE_VERSION = "0.626.0";
    const devRuns = () => fake.read().filter((e) => e.argv?.[0] === "dev");
    try {
      for (let run = 0; run < 2; run++) {
        const before = devRuns().length;
        const started = nextTask(vscode.tasks.onDidStartTask);
        await vscode.commands.executeCommand("bynk.startDevServer");
        await started;
        // The stand-in logs its argv as it starts, which can be after the task does.
        const runs = await waitFor(devRuns, (r) => r.length > before, "the stand-in to start");
        try {
          assert.ok(!runs[runs.length - 1].argv!.includes("--trace-events"), "an older bynk is not given the flag");
        } finally {
          const ended = nextTask(vscode.tasks.onDidEndTask);
          await vscode.commands.executeCommand("bynk.stopDevServer");
          await ended;
        }
      }
      const lines = (await vscode.commands.executeCommand<string[]>("bynk.logLines")) ?? [];
      assert.strictEqual(lines.filter((l) => l.includes("Request traces need bynk v0.627.1")).length, 1, "said once, not at every start");
    } finally {
      delete process.env.BYNK_FAKE_VERSION;
    }
  });

  it("starts without --trace-events when bynk.dev.traceRequests is off (#143)", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(45_000);
    const config = vscode.workspace.getConfiguration("bynk");
    await config.update("dev.traceRequests", false, vscode.ConfigurationTarget.Global);
    try {
      const devRuns = () => fake.read().filter((e) => e.argv?.[0] === "dev");
      const before = devRuns().length;
      const started = nextTask(vscode.tasks.onDidStartTask);
      await vscode.commands.executeCommand("bynk.startDevServer");
      await started;
      const runs = await waitFor(devRuns, (r) => r.length > before, "the stand-in to start");
      assert.ok(!runs[runs.length - 1].argv!.includes("--trace-events"));
    } finally {
      await config.update("dev.traceRequests", undefined, vscode.ConfigurationTarget.Global);
      const ended = nextTask(vscode.tasks.onDidEndTask);
      await vscode.commands.executeCommand("bynk.stopDevServer");
      await ended;
    }
  });
});
