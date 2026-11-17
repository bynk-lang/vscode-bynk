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
  it("compares two revisions, with nothing linked to the working tree (#155)", async function () {
    this.timeout(120_000);
    const diff = await waitFor(
      () => vscode.commands.executeCommand<(ModelDiff & { graphs: DiffGraphs }) | undefined>("bynk.compareModel", first, "HEAD"),
      (d): d is ModelDiff & { graphs: DiffGraphs } => !!d && d.sections.every((s) => !s.unavailable),
      "the two-revision diff to cover every section",
      90_000,
    );
    const arch = diff.sections.find((s) => s.id === "architecture")!;
    assert.ok(
      arch.entries.some((e) => e.change === "added" && e.element === "service" && e.name === "md.second"),
      `the second commit's service is added: ${JSON.stringify(arch.entries)}`,
    );
    assert.ok(diff.sections.every((s) => s.entries.every((e) => e.loc === null)), "no row links to a file");
    assert.strictEqual(diff.graphs.linked, false);
    // Both checkouts are gone, and neither left diagnostics behind.
    assert.deepStrictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("bynk-model-diff-")), []);
    assert.strictEqual(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
    assert.deepStrictEqual(
      vscode.languages.getDiagnostics().filter(([uri]) => uri.path.includes("bynk-model-diff-")).map(([uri]) => uri.fsPath),
      [],
    );
  });
  it("falls back to asking for the revisions when the pull request's shape is not recognised (#155)", async function () {
    this.timeout(60_000);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()));
    const realPick = vscode.window.showQuickPick;
    const realInfo = vscode.window.showInformationMessage;
    const picks: string[] = [];
    const infos: string[] = [];
    // The picker is answered with a cancel, so nothing is compared.
    (vscode.window as { showQuickPick: unknown }).showQuickPick = async (_items: unknown, o?: { title?: string }) => {
      picks.push(o?.title ?? "");
      return undefined;
    };
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (m: string) => {
      infos.push(m);
      return undefined;
    };
    try {
      await vscode.commands.executeCommand("bynk.compareModelPullRequest", { pullRequestModel: { base: 42 } });
    } finally {
      (vscode.window as { showQuickPick: unknown }).showQuickPick = realPick;
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = realInfo;
    }
    assert.ok(infos.some((m) => /could not read this pull request/.test(m)), JSON.stringify(infos));
    assert.strictEqual(picks.length, 1, "the revision picker was offered");
  });
});

// #154: the invariants and the response shape, from the real server. Two
// projects, so that neither depends on the other's source analysing cleanly (a
// revision with an error has no wire contracts): an agent whose `invariant` is
// replaced by a `transition` rule, and an HTTP handler that answers a String
// in the first commit and an Int in the second.
function twoCommitRepo(prefix: string, first: string, second: string): { dir: string; first: string; file: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(dir, "init", "-q");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "bynk.toml"), MANIFEST);
  const file = path.join(dir, "src", "md.bynk");
  fs.writeFileSync(file, first);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  const rev = git(dir, "rev-parse", "HEAD").trim();
  fs.writeFileSync(file, second);
  git(dir, "commit", "-qam", "second");
  return { dir, first: rev, file };
}

async function diffAgainst(file: string, rev: string): Promise<ModelDiff> {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  return waitFor(
    () => vscode.commands.executeCommand<ModelDiff | undefined>("bynk.compareModel", rev),
    (d): d is ModelDiff => !!d && d.sections.every((s) => !s.unavailable),
    "the model diff to cover every section",
    90_000,
  );
}

describe("compare model: agent invariants (#154)", () => {
  const AGENT = (rule: string) => `
type OrderStatus = enum { Pending, Placed, Paid }

agent Order {
  key id: String

  store status: Cell[OrderStatus] = Pending
  store paymentRef: Cell[Option[String]] = None

  ${rule}

  on call place() -> Effect[()] {
    status := Placed
  }
}
`;
  let repo: { dir: string; first: string; file: string };

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    repo = twoCommitRepo(
      "bynk-md-rules-",
      HEAD + AGENT("invariant paid_has_ref: status is Paid implies paymentRef.isSome()"),
      HEAD + AGENT("transition paid_is_terminal: old.status is Paid implies new.status is Paid"),
    );
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(repo.dir, { recursive: true, force: true });
  });

  it("reports an invariant removed and a transition rule added", async function () {
    this.timeout(120_000);
    const diff = await diffAgainst(repo.file, repo.first);
    const agents = diff.sections.find((s) => s.id === "agents")!;
    const rules = agents.entries
      .filter((e) => e.element === "invariant" || e.element === "transition rule")
      .map((e) => `${e.change} ${e.element} ${e.name}`)
      .sort();
    assert.deepStrictEqual(rules, [
      "added transition rule md.Order: paid_is_terminal",
      "removed invariant md.Order: paid_has_ref",
    ]);
  });
});

describe("compare model: the response shape of an HTTP handler (#154)", () => {
  const ANSWER = (type: string, value: string) => `
service answers from http {
  on GET("/answer") () -> Effect[HttpResult[${type}]] by v: Visitor given Logger {
    let _ <- Logger.info("answer")
    Ok(${value})
  }
}
`;
  let repo: { dir: string; first: string; file: string };

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    repo = twoCommitRepo("bynk-md-response-", HEAD + ANSWER("String", '"a"'), HEAD + ANSWER("Int", "1"));
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(repo.dir, { recursive: true, force: true });
  });

  it("calls a response whose type changed breaking, naming the response", async function () {
    this.timeout(120_000);
    const diff = await diffAgainst(repo.file, repo.first);
    const wire = diff.sections.find((s) => s.id === "wire")!;
    const answer = wire.entries.find((e) => e.name.includes("GET /answer"));
    assert.ok(answer, `the handler is compared: ${JSON.stringify(wire.entries)}`);
    assert.strictEqual(answer.change, "changed", JSON.stringify(answer));
    assert.strictEqual(answer.verdict, "breaking", JSON.stringify(answer));
    assert.ok(answer.detail?.startsWith("response "), `the reason names the response: ${answer.detail}`);
  });
});
