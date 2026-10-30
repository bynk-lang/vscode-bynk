// The Testing view's "Doc examples" node (#8): every suite with doc-comment examples
// holds those cases under a group node of its own. Case ids do not change, so seed
// pins, failures and run planning still key on `${suiteId}::${name}`.
//
// Two halves, both against the stand-in `bynk` (test/fixtures/fake-bynk), whose log
// shows the exact `--suite` / `--case` arguments the extension runs:
//   - a controller of the test's own, filled by `reconcile` and run by `runHandler`:
//     the node, running it, running the suite, the move between doc and ordinary,
//     and a pin that survives reconcile;
//   - the extension's own controller, through its commands: file runs, code lenses
//     and a seed pin on a doc case.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { docGroupId, isDocGroupId, type JsonCase, type JsonSuite } from "../../src/testPlan";
import { reconcile } from "../../src/testDiscovery";
import { runHandler } from "../../src/testRun";
import { type SeedState } from "../../src/testSeedState";
import { newDriverSupport } from "../../src/testStream";
import { planCases, requestRef, suiteCases, suiteIdOf } from "../../src/testTree";
import type { RunEnv } from "../../src/testEnv";
import type { ViewRefresh } from "../../src/viewRefresh";
import { FAKE_BYNK, useFakeBynk, type FakeLogEntry } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const WORKSPACE = path.resolve(__dirname, "../../../test/fixtures/workspace");
const ROOT = vscode.Uri.file(WORKSPACE);
const SUITE_DEF: Pick<JsonSuite, "name" | "kind"> = { name: "docs", kind: "unit" };
const SUITE = suiteIdOf({ ...SUITE_DEF, cases: [] }, ROOT.toString());

const at = (line: number) => ({ path: "src/text.bynk", line, col: 1 });
const ordinary = (name: string, line: number): JsonCase => ({ name, outcome: "pass", location: at(line) });
const doc = (name: string, line: number): JsonCase => ({ ...ordinary(name, line), origin: "doc" });

/** A seed memory that never touches workspace state. */
function seedState(): SeedState {
  const data = new Map<string, unknown>();
  const store = {
    keys: () => [...data.keys()],
    get: <T>(k: string, d?: T) => (data.has(k) ? (data.get(k) as T) : d),
    update: (k: string, v: unknown) => {
      data.set(k, v);
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
  return { pins: new Map(), failures: new Map(), generative: new Map(), store };
}

function runsOf(entries: FakeLogEntry[], from: number): string[][] {
  return entries
    .slice(from)
    .map((e) => e.argv ?? [])
    .filter((a) => a[0] === "test" && !a.includes("--no-run"));
}

const flagValues = (argv: string[], flag: string): string[] =>
  argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

describe("the Doc examples node", () => {
  let ctrl: vscode.TestController;
  let env: RunEnv;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let dir: string;

  /** A second suite, so that running one suite is a narrowing of the project. */
  const OTHER: JsonSuite = { name: "other", kind: "unit", cases: [ordinary("elsewhere", 9)] };
  const reported: string[] = [];

  /** Point the stand-in at a document of `cases` in the `docs` suite, beside `other`. */
  function serve(suites: JsonSuite[]): void {
    const file = path.join(dir, "doc.json");
    fs.writeFileSync(file, JSON.stringify({ passed: 1, failed: 0, suites }));
    process.env.BYNK_FAKE_TEST_DOC = file;
  }
  const load = (cases: JsonCase[]): void => {
    const suites = [{ ...SUITE_DEF, cases }, OTHER];
    serve(suites);
    reconcile(ctrl, env.seeds, suites, ROOT, true);
  };
  const suiteItem = (): vscode.TestItem => {
    const s = ctrl.items.get(ROOT.toString())?.children.get(SUITE);
    assert.ok(s, "the suite item exists");
    return s;
  };
  const group = (): vscode.TestItem | undefined => suiteItem().children.get(docGroupId(SUITE));
  const names = (item: vscode.TestItem): string[] => {
    const out: string[] = [];
    item.children.forEach((c) => void out.push(c.label));
    return out.sort();
  };

  async function run(include?: vscode.TestItem[], exclude?: vscode.TestItem[]): Promise<string[]> {
    const from = fake.read().length;
    const cts = new vscode.CancellationTokenSource();
    reported.length = 0;
    try {
      await runHandler(env, new vscode.TestRunRequest(include, exclude), cts.token);
    } finally {
      cts.dispose();
    }
    const argv = await waitFor(() => runsOf(fake.read(), from)[0], (a) => a !== undefined, "the run's process");
    return argv;
  }

  before(async function () {
    this.timeout(30_000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-doc-examples-"));
    fs.chmodSync(FAKE_BYNK, 0o755);
    fake = await useFakeBynk();
    ctrl = vscode.tests.createTestController("bynk-doc-examples-test", "Doc examples test");
    // The same controller, but a run's passed cases are recorded.
    const bound = (o: object, k: string | symbol): unknown => {
      const v = (o as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(o) : v;
    };
    const recording = new Proxy(ctrl, {
      get: (t, k) =>
        k === "createTestRun"
          ? (...a: Parameters<vscode.TestController["createTestRun"]>) =>
              new Proxy(t.createTestRun(...a), {
                get: (rt, rk) =>
                  rk === "passed"
                    ? (item: vscode.TestItem, d?: number) => {
                        reported.push(item.id);
                        rt.passed(item, d);
                      }
                    : bound(rt, rk),
              })
          : bound(t, k),
    });
    env = {
      ctrl: recording,
      problems: vscode.languages.createDiagnosticCollection("bynk-doc-examples-test"),
      seeds: seedState(),
      hub: null as unknown as ViewRefresh,
      driverSupport: newDriverSupport(),
    };
  });
  after(async () => {
    env.problems.dispose();
    ctrl.dispose();
    delete process.env.BYNK_FAKE_TEST_DOC;
    await fake.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => ctrl.items.replace([]));

  it("shows a node holding the doc cases, and keeps every case's id", () => {
    load([ordinary("an example", 1), doc("doc one", 2), doc("doc two", 3)]);
    const g = group();
    assert.ok(g, "the suite has a Doc examples node");
    assert.strictEqual(g.label, "Doc examples");
    assert.ok(isDocGroupId(g.id));
    assert.deepStrictEqual(names(g), ["doc one", "doc two"]);
    assert.deepStrictEqual(names(suiteItem()), ["Doc examples", "an example"]);
    assert.ok(g.children.get(`${SUITE}::doc one`), "a doc case keeps the id suite::name under the node");
    assert.deepStrictEqual(suiteCases(suiteItem()).map((c) => c.label).sort(), ["an example", "doc one", "doc two"]);
    assert.deepStrictEqual(
      planCases(ctrl).map((c) => c.name).sort(),
      ["an example", "doc one", "doc two"],
      "the plan sees the doc cases, not the node",
    );
  });

  it("has no node for a suite without doc examples, and drops it when the last goes", () => {
    load([ordinary("an example", 1)]);
    assert.strictEqual(group(), undefined);
    load([ordinary("an example", 1), doc("doc one", 2)]);
    assert.ok(group());
    load([ordinary("an example", 1)]);
    assert.strictEqual(group(), undefined, "the node is pruned with its last case");
    assert.deepStrictEqual(names(suiteItem()), ["an example"]);
  });

  it("prunes a removed doc case but keeps the node while others remain", () => {
    load([doc("doc one", 2), doc("doc two", 3)]);
    load([doc("doc two", 3)]);
    assert.deepStrictEqual(names(group() as vscode.TestItem), ["doc two"]);
  });

  it("moves a case between the node and the suite, with the same id", () => {
    load([ordinary("flips", 1), doc("stays", 2)]);
    const id = `${SUITE}::flips`;
    env.seeds.pins.set(id, { seed: "0x5f3a", fingerprint: [] });
    env.seeds.failures.set(id, { seed: "0x5f3a", counterexample: "p = 1" });
    assert.ok(suiteItem().children.get(id));
    load([doc("flips", 1), doc("stays", 2)]);
    assert.strictEqual(suiteItem().children.get(id), undefined, "gone from the suite");
    assert.ok(group()?.children.get(id), "under the node, same id");
    load([ordinary("flips", 1), doc("stays", 2)]);
    assert.ok(suiteItem().children.get(id));
    assert.strictEqual(group()?.children.get(id), undefined);
    assert.deepStrictEqual(names(group() as vscode.TestItem), ["stays"]);
    assert.ok(env.seeds.pins.has(id), "the pin survives both moves");
    assert.ok(env.seeds.failures.has(id), "so does the remembered failure");
    env.seeds.pins.clear();
    env.seeds.failures.clear();
  });

  it("maps a request for the node, or for a case under it, to the real suite", () => {
    load([ordinary("an example", 1), doc("doc one", 2), doc("doc two", 3)]);
    const g = group() as vscode.TestItem;
    assert.deepStrictEqual(requestRef(new vscode.TestRunRequest([g])).include, [
      { suiteId: SUITE, name: "doc one" },
      { suiteId: SUITE, name: "doc two" },
    ]);
    const c = g.children.get(`${SUITE}::doc two`) as vscode.TestItem;
    assert.deepStrictEqual(requestRef(new vscode.TestRunRequest([c])).include, [{ suiteId: SUITE, name: "doc two" }]);
    assert.deepStrictEqual(requestRef(new vscode.TestRunRequest(undefined, [g])).exclude, [
      { suiteId: SUITE, name: "doc one" },
      { suiteId: SUITE, name: "doc two" },
    ]);
    assert.deepStrictEqual(requestRef(new vscode.TestRunRequest([suiteItem()])).include, [{ suiteId: SUITE }]);
  });

  it("runs exactly the doc cases when the node is run", async function () {
    this.timeout(60_000);
    load([ordinary("an example", 1), doc("doc one", 2), doc("doc two", 3)]);
    const argv = await run([group() as vscode.TestItem]);
    assert.deepStrictEqual(flagValues(argv, "--suite"), ["docs"]);
    assert.deepStrictEqual(flagValues(argv, "--case").sort(), ["doc one", "doc two"]);
  });

  it("runs everything when the suite is run", async function () {
    this.timeout(60_000);
    load([ordinary("an example", 1), doc("doc one", 2), doc("doc two", 3)]);
    const argv = await run([suiteItem()]);
    assert.deepStrictEqual(flagValues(argv, "--suite"), ["docs"]);
    assert.deepStrictEqual(flagValues(argv, "--case"), [], `no case filter: ${argv}`);
    await waitFor(
      () => [...reported].sort(),
      (r) => ["an example", "doc one", "doc two"].every((n) => r.includes(`${SUITE}::${n}`)),
      "results for the suite's ordinary and doc cases",
    );
    assert.ok(!reported.includes(`${SUITE.replace("docs", "other")}::elsewhere`), "the other suite did not run");
  });

  it("runs the suite without its doc examples when the node is excluded", async function () {
    this.timeout(60_000);
    load([ordinary("an example", 1), doc("doc one", 2), doc("doc two", 3)]);
    const argv = await run([suiteItem()], [group() as vscode.TestItem]);
    assert.deepStrictEqual(flagValues(argv, "--case"), ["an example"]);
  });

  it("runs one doc case under the node by its own name", async function () {
    this.timeout(60_000);
    load([ordinary("an example", 1), doc("doc one", 2), doc("doc two", 3)]);
    const c = (group() as vscode.TestItem).children.get(`${SUITE}::doc two`) as vscode.TestItem;
    const argv = await run([c]);
    assert.deepStrictEqual(flagValues(argv, "--case"), ["doc two"]);
  });

  it("keeps a seed pin on a doc case, and drops one for a case that is gone", () => {
    const keep = `${SUITE}::doc one`;
    const gone = `${SUITE}::vanished`;
    env.seeds.pins.set(keep, { seed: "0x5f3a", fingerprint: [] });
    env.seeds.pins.set(gone, { seed: "0x5f3a", fingerprint: [] });
    load([ordinary("an example", 1), doc("doc one", 2)]);
    assert.ok(env.seeds.pins.has(keep), "a pin on a case under the node holds");
    assert.ok(!env.seeds.pins.has(gone));
    env.seeds.pins.clear();
  });
});

describe("the Doc examples node and the extension's commands", () => {
  const FAILING = "doc that fails";
  const textFile = vscode.Uri.file(path.join(WORKSPACE, "src", "text.bynk"));
  const id = `bynk-test:unit:docs::${FAILING}`;
  let dir: string;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;

  const lensNames = async (): Promise<string[]> => {
    const lenses = (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", textFile)) ?? [];
    return lenses.filter((l) => l.command?.command === "bynk.runTestCase").map((l) => String(l.command?.arguments?.[0]));
  };

  before(async function () {
    this.timeout(90_000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-doc-examples-ext-"));
    fs.chmodSync(FAKE_BYNK, 0o755);
    fake = await useFakeBynk();
    const cases: JsonCase[] = [
      ordinary("an example", 1),
      doc("doc one", 2),
      { ...doc(FAILING, 3), outcome: "fail", message: "property failed (seed 0x5f3a)", kind: "property", seed: "0x5f3a", counterexample: "p = 1" } as JsonCase,
    ];
    const file = path.join(dir, "doc.json");
    fs.writeFileSync(file, JSON.stringify({ passed: 2, failed: 1, suites: [{ ...SUITE_DEF, cases }] }));
    process.env.BYNK_FAKE_TEST_DOC = file;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(textFile));
    await vscode.commands.executeCommand("testing.refreshTests");
    await waitFor(lensNames, (n) => n.includes(FAILING) && n.includes("doc one"), "lenses for the doc cases", 45_000);
  });
  after(async () => {
    await vscode.commands.executeCommand("bynk.unpinSeed", { id });
    delete process.env.BYNK_FAKE_TEST_DOC;
    await fake.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("puts a code lens on every case, doc examples included", async () => {
    const names = await lensNames();
    for (const n of ["an example", "doc one", FAILING]) assert.ok(names.includes(n), `${n} in ${names}`);
  });

  it("runs the doc cases with the rest of a file", async function () {
    this.timeout(60_000);
    const from = fake.read().length;
    await vscode.commands.executeCommand("bynk.runTestsInFile", textFile);
    const argv = await waitFor(() => runsOf(fake.read(), from)[0], (a) => a !== undefined, "the file run");
    // Every case of the file is selected, so the run is the whole project, as before.
    assert.deepStrictEqual(flagValues(argv, "--case"), []);
  });

  it("pins the seed of a failed doc case and passes it to a run of that case", async function () {
    this.timeout(90_000);
    const runCase = async (): Promise<string[]> => {
      const from = fake.read().length;
      await vscode.commands.executeCommand("bynk.runTestCase", FAILING);
      return waitFor(() => runsOf(fake.read(), from)[0], (a) => a !== undefined, "the case's run");
    };
    await runCase(); // the failure whose seed is remembered
    await vscode.commands.executeCommand("bynk.pinSeed", { id });
    const pinned = await runCase();
    assert.deepStrictEqual(pinned.slice(pinned.indexOf("--case")), ["--case", FAILING, "--seed", "0x5f3a"]);
  });
});
