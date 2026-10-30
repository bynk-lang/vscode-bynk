// #40: one project-root rule, bounded by the workspace folder, with a nested
// project in the workspace — inside the extension host. The `bynkc: check` task is one per project, each in its own
// directory, and a root lookup never leaves the workspace.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { projectRootFor } from "../../src/projectRoots";
import { waitFor } from "./util";

const WORKSPACE = path.resolve(__dirname, "../../../test/fixtures/workspace");

describe("Project roots with a nested project (#40)", () => {
  let dir: string;
  let nested: string;

  const same = (a: string | undefined, b: string): boolean => a !== undefined && fs.realpathSync(a) === fs.realpathSync(b);

  before(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(WORKSPACE, ".roots-")));
    nested = path.join(dir, "apps", "web");
    fs.mkdirSync(path.join(nested, "src"), { recursive: true });
    fs.writeFileSync(path.join(nested, "bynk.toml"), '[project]\nname = "web"\n\n[paths]\ninclude = ["src"]\n');
    fs.writeFileSync(path.join(nested, "src", "a.bynk"), "commons a\n");
    fs.mkdirSync(path.join(dir, "loose"));
    fs.writeFileSync(path.join(dir, "loose", "b.bynk"), "commons b\n");
  });
  after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("roots a nested file at its own project and others at the workspace project", async () => {
    const inNested = await projectRootFor(vscode.Uri.file(path.join(nested, "src", "a.bynk")));
    assert.ok(same(inNested?.fsPath, nested), String(inNested));
    const inOuter = await projectRootFor(vscode.Uri.file(path.join(dir, "loose", "b.bynk")));
    assert.ok(same(inOuter?.fsPath, WORKSPACE), String(inOuter));
  });

  it("does not look outside the workspace folder", async () => {
    // `test/fixtures` sits above the workspace folder and is in no folder itself.
    const outside = vscode.Uri.file(path.resolve(WORKSPACE, "..", "hello-web.bynk"));
    assert.strictEqual(await projectRootFor(outside), undefined);
  });

  it("offers one check task per project, each in its own directory", async function () {
    this.timeout(60_000);
    const tasks = await waitFor(
      () => vscode.tasks.fetchTasks({ type: "bynkc" }),
      (all) => all.some((t) => typeof t.definition.project === "string" && t.definition.project.endsWith("apps/web")),
      "a check task for the nested project",
    );
    const cwdOf = (t: vscode.Task): string | undefined => (t.execution as vscode.ShellExecution).options?.cwd;
    const web = tasks.find((t) => String(t.definition.project).endsWith("apps/web"))!;
    assert.ok(same(cwdOf(web), nested), String(cwdOf(web)));
    const root = tasks.find((t) => t.definition.project === undefined)!;
    assert.ok(same(cwdOf(root), WORKSPACE), String(cwdOf(root)));
  });
});
