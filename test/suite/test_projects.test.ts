// The Testing view in a workspace of several Bynk projects (#33), inside the
// extension host against the stand-in `bynk` (#2094). Each project is its own
// top-level item, discovery is not rooted at whichever editor is focused, and a run
// goes to the project its items belong to.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { FAKE_BYNK, useFakeBynk, type FakeLogEntry } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const WORKSPACE = path.resolve(__dirname, "../../../test/fixtures/workspace");

describe("Testing view with two projects", () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let a: string;
  let b: string;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const lenses = async (uri: vscode.Uri): Promise<string[]> => {
    // The provider answers for a document the editor has loaded.
    await vscode.workspace.openTextDocument(uri);
    return ((await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)) ?? [])
      .filter((l) => l.command?.command === "bynk.runTestCase")
      .map((l) => String(l.command?.arguments?.[0]));
  };
  /** Invocations of `bynk test` (discovery or a run) in `root`, oldest first. */
  const invocations = (root: string, run: boolean): FakeLogEntry[] =>
    fake
      .read()
      .filter(
        (e) =>
          e.argv?.[0] === "test" &&
          e.argv.includes("--no-run") === !run &&
          e.cwd !== undefined &&
          fs.realpathSync(e.cwd) === fs.realpathSync(root),
      );

  before(async () => {
    fs.chmodSync(FAKE_BYNK, 0o755);
    dir = fs.realpathSync(fs.mkdtempSync(path.join(WORKSPACE, ".proj-")));
    for (const name of ["a", "b"]) {
      const root = path.join(dir, name);
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "bynk.toml"), `[project]\nname = "${name}"\n\n[paths]\ninclude = ["src"]\n`);
      for (const file of ["alpha", "beta"]) {
        fs.writeFileSync(path.join(root, "src", `${file}.bynk`), "commons c {\n  fn f() -> Int { 1 }\n}\n");
      }
      fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n`);
    }
    a = path.join(dir, "a");
    b = path.join(dir, "b");
    // Both projects list the same suite and case, declared in their own `alpha.bynk`
    // (`beta.bynk` declares none): the ids alone must tell them apart.
    const doc = {
      passed: 1,
      failed: 0,
      suites: [
        {
          name: "shared",
          kind: "unit",
          cases: [{ name: "same name", outcome: "pass", tier: "unit", location: { path: "src/alpha.bynk", line: 2, col: 1 } }],
        },
      ],
    };
    const file = path.join(dir, "doc.json");
    fs.writeFileSync(file, JSON.stringify(doc));
    process.env.BYNK_FAKE_TEST_DOC = file;
    fake = await useFakeBynk();
  });
  after(async () => {
    await fake.restore();
    delete process.env.BYNK_FAKE_TEST_DOC;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("discovers every project, and Refresh from a non-Bynk editor keeps the tree", async function () {
    this.timeout(60_000);
    const alphaA = vscode.Uri.file(path.join(a, "src", "alpha.bynk"));
    const alphaB = vscode.Uri.file(path.join(b, "src", "alpha.bynk"));

    await vscode.commands.executeCommand("testing.refreshTests");
    await waitFor(
      async () => (await lenses(alphaA)).length > 0 && (await lenses(alphaB)).length > 0,
      truthy,
      "both projects' cases to be discovered",
      45_000,
    );

    // Focus a document that belongs to no Bynk file, then refresh.
    const readme = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(a, "README.md")));
    await vscode.window.showTextDocument(readme);
    const before = invocations(a, false).length;
    await vscode.commands.executeCommand("testing.refreshTests");
    await waitFor(() => invocations(a, false).length > before, truthy, "the refresh to rediscover");
    await sleep(1000);

    assert.deepStrictEqual(await lenses(alphaA), ["same name"], "project A keeps its case");
    assert.deepStrictEqual(await lenses(alphaB), ["same name"], "project B keeps its case");
  });

  it("runs the project the items belong to, not the focused file's", async function () {
    this.timeout(60_000);
    const alphaA = vscode.Uri.file(path.join(a, "src", "alpha.bynk"));
    // Project B's file is the one in front.
    const betaB = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(b, "src", "beta.bynk")));
    await vscode.window.showTextDocument(betaB);

    const runsA = invocations(a, true).length;
    const runsB = invocations(b, true).length;
    await vscode.commands.executeCommand("bynk.runTestsInFile", alphaA);
    await waitFor(() => invocations(a, true).length > runsA, truthy, "project A to run");

    assert.strictEqual(invocations(b, true).length, runsB, "project B did not run");
  });
});
