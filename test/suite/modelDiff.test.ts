// #147 integration test: "Bynk: Compare Model with…" against the real pinned
// language server and a real git repository. The approach (open a file of a
// project outside the workspace in the running server, ask for its models)
// rests on server behaviour that is not documented, so this is its guard.
// A two-commit fixture: the first commit has a context with a type error (so
// the server publishes diagnostics for the checkout) and one service; the
// second removes the error and adds a service.

import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import type { ModelDiff } from "../../src/modelDiffCore";
import type { DiffGraphs } from "../../src/modelDiffGraphCore";
import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";

const MANIFEST = '[project]\nname = "md"\nversion = "0.1.0"\n\n[paths]\ninclude = ["src"]\n';
const SERVICE = (name: string) => `
service ${name} from http {
  on GET("/${name}") () -> Effect[HttpResult[String]] by v: Visitor given Logger {
    let _ <- Logger.info("${name}")
    Ok("${name}")
  }
}
`;
const HEAD = "context md\n\nconsumes bynk { Logger }\n";
const FIRST = HEAD + SERVICE("first") + '\nlet broken: Int = "x"\n';
const SECOND = HEAD + SERVICE("first") + SERVICE("second");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
}

describe("compare model with a git revision (#147)", () => {
  let repo: string;
  let first: string;
  const file = () => path.join(repo, "src", "md.bynk");

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bynk-md-test-")));
    git(repo, "init", "-q");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "bynk.toml"), MANIFEST);
    fs.writeFileSync(file(), FIRST);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    first = git(repo, "rev-parse", "HEAD").trim();
    fs.writeFileSync(file(), SECOND);
    git(repo, "commit", "-qam", "second");
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("shows what a revision lacks, and leaves no worktree or diagnostics behind", async function () {
    this.timeout(120_000);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()));
    // The server commits its first round for the project asynchronously, so
    // the working-tree side may not have a model yet.
    const diff = await waitFor(
      () => vscode.commands.executeCommand<(ModelDiff & { graphs: DiffGraphs }) | undefined>("bynk.compareModel", first),
      (d): d is ModelDiff & { graphs: DiffGraphs } => !!d && d.sections.every((s) => !s.unavailable),
      "the model diff to cover every section",
      90_000,
    );
    const arch = diff.sections.find((s) => s.id === "architecture")!;
    const added = arch.entries.filter((e) => e.change === "added");
    assert.ok(
      added.some((e) => e.element === "service" && e.name === "md.second"),
      `the second commit's service is reported as added: ${JSON.stringify(arch.entries)}`,
    );
    assert.ok(added[0].loc?.uri.startsWith(vscode.Uri.file(repo).toString()), "an added row links to the working tree");

    // Each handler's wire contract is compared: the second commit's route is new.
    const wire = diff.sections.find((s) => s.id === "wire")!;
    assert.ok(
      wire.entries.some((e) => e.change === "added" && e.verdict === "compatible" && e.name.includes("GET /second")),
      `the added handler is a compatible wire change: ${JSON.stringify(wire)}`,
    );

    // The map is drawn from the merged model: the added service is marked.
    assert.strictEqual(
      diff.graphs.architecture?.marks.members["md\u0000service\u0000second"],
      "added",
      JSON.stringify(diff.graphs.architecture?.marks),
    );

    // The worktree is gone from git's records and from disk.
    assert.strictEqual(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    const leftovers = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("bynk-model-diff-"));
    assert.deepStrictEqual(leftovers, []);

    // None of the checkout's diagnostics reached the Problems panel.
    const scratch = vscode.languages
      .getDiagnostics()
      .filter(([uri]) => uri.path.includes("bynk-model-diff-"));
    assert.deepStrictEqual(scratch.map(([uri]) => uri.fsPath), []);
  });
});
