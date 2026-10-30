// #40: one project-root rule, bounded by the workspace folder, with a nested
// project in the workspace — inside the extension host. The `bynkc: check`
// task is one per project, each in its own directory with its diagnostics on
// that project's files. (That a lookup never leaves the workspace folder is
// covered by projectRootsCore.unit.test.ts.)

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { projectRootFor } from "../../src/projectRoots";
import { present, waitFor } from "./util";

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

  it("puts a nested check's diagnostics on the nested file", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    // A stand-in `bynk` that reports one error the way the driver prints it:
    // a path relative to the project it ran in.
    const script = path.join(dir, "bynk-reports-error");
    fs.writeFileSync(script, '#!/bin/sh\necho "src/a.bynk:1:1: error[test.boom]: boom"\nexit 1\n', { mode: 0o755 });
    const config = vscode.workspace.getConfiguration("bynk");
    const previous = config.inspect<string>("bynkPath")?.globalValue;
    await config.update("bynkPath", script, vscode.ConfigurationTarget.Global);
    try {
      const web = await waitFor(
        async () => (await vscode.tasks.fetchTasks({ type: "bynkc" })).find((t) => String(t.definition.project).endsWith("apps/web")),
        present,
        "a check task for the nested project",
      );
      await vscode.tasks.executeTask(web);
      const nestedFile = vscode.Uri.file(path.join(nested, "src", "a.bynk"));
      const outerFile = vscode.Uri.file(path.join(WORKSPACE, "src", "a.bynk"));
      const boom = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.source === "bynkc");
      await waitFor(() => boom(nestedFile), present, "the error in the nested project's Problems", 40_000);
      assert.deepStrictEqual(boom(outerFile), [], "not on the same path under the workspace folder");
    } finally {
      await vscode.workspace.getConfiguration("bynk").update("bynkPath", previous, vscode.ConfigurationTarget.Global);
    }
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
