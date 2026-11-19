// #221 integration test: Bynk: Check Deploy Readiness, against the stand-in
// `bynk` (test/fixtures/fake-bynk), in a project copied from test/fixtures/groups.
// The stand-in prints the pinned plan for a dry run, refuses a real deploy, and
// can refuse a Worker-script move as bynk v0.639.1 does, so nothing here can
// reach Cloudflare. The check must be read-only: one dry run, no `--yes` or
// `--prune`, no deploy, and `bynk.schema.lock` left as it was.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import type { ReadinessReport } from "../../src/deployReadinessCore";
import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/groups");
const LOCK_TEXT = "version = 2\n\n[events]\n\n# the committed lock\n";

const tabOpen = (label: string): boolean =>
  vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === label));

describe("Bynk deploy readiness (#221)", () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let seen = 0;
  const runs = (cmd: string) => fake.read().slice(seen).filter((e) => e.argv?.[0] === cmd);
  const report = (environment: string, extra: Record<string, string> = {}) =>
    vscode.commands.executeCommand<ReadinessReport | undefined>("bynk._deployReadiness", { environment, context: "", ...extra });
  const status = (r: ReadinessReport | undefined, id: string) => r?.checks.find((c) => c.id === id)?.status;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".rd-")));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bynk.schema.lock"), LOCK_TEXT);
    const orders = vscode.Uri.file(path.join(dir, "src", "shop", "orders.bynk"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(orders));
    fake = await useFakeBynk();
  });
  after(async () => {
    delete process.env.BYNK_FAKE_DEPLOY;
    delete process.env.BYNK_FAKE_DEPLOY_LOCK;
    await fake?.restore();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    seen = fake.read().length;
  });

  it("judges the pinned plan: secrets and orphans warn, migrations warn, size is not available", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    const r = await report("staging");
    assert.ok(r, "a report");
    assert.strictEqual(r.environment, "staging");
    assert.strictEqual(status(r, "plan"), "pass");
    assert.strictEqual(status(r, "secrets"), "warn");
    assert.strictEqual(status(r, "orphans"), "warn");
    assert.strictEqual(status(r, "workerMove"), "pass");
    assert.strictEqual(status(r, "migrations"), "warn", "the pinned status has shop.Cart deployed to staging");
    assert.strictEqual(status(r, "tests"), "warn", "no test run in this session");
    assert.strictEqual(status(r, "workerSize"), "unavailable", "never passed while bynk#3792 has not landed");
    assert.strictEqual(r.verdict, "warnings");
    // Names only: the plan's secret names, never a value.
    const secrets = r.checks.find((c) => c.id === "secrets");
    assert.ok(secrets?.details.some((d) => d.includes("WEBHOOK_SECRET")));
  });

  it("is read-only: one dry run, no --yes or --prune, no deploy, and a cached answer is not recomputed", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    await report("cached"); // fills the cache for this environment
    const before = runs("deploy").length;
    await report("cached");
    assert.strictEqual(runs("deploy").length, before, "the second answer came from the cache");
    const deploys = runs("deploy");
    assert.ok(deploys.length >= 1);
    for (const d of deploys) {
      assert.ok(d.argv?.includes("--dry-run"), "only ever a dry run");
      for (const banned of ["--yes", "--prune", "--force", "--secrets-file"]) assert.ok(!d.argv?.includes(banned), banned);
    }
    assert.ok(!runs("migrate").some((e) => e.argv?.[1] !== "status"), "only `migrate status`, never a sweep");
  });

  it("recomputes after a source is saved", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    await report("saved");
    const before = runs("deploy").length;
    const file = path.join(dir, "src", "shop", "payment.bynk");
    const doc = await vscode.workspace.openTextDocument(file);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), "\n");
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await waitFor(async () => (await report("saved"), runs("deploy").length), (n) => n > before, "a fresh dry run after the save", 20_000);
  });

  it("leaves bynk.schema.lock as the dry run found it, as the real driver would rewrite it", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    process.env.BYNK_FAKE_DEPLOY_LOCK = "1";
    try {
      await report("lock-env");
    } finally {
      delete process.env.BYNK_FAKE_DEPLOY_LOCK;
    }
    assert.strictEqual(fs.readFileSync(path.join(dir, "bynk.schema.lock"), "utf8"), LOCK_TEXT);
  });

  it("fails, and says so, when the dry run refuses a context moving Worker script", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    process.env.BYNK_FAKE_DEPLOY = "agent-move";
    try {
      const r = await report("moving");
      assert.strictEqual(status(r, "workerMove"), "fail");
      assert.strictEqual(status(r, "secrets"), "unavailable", "no plan, so not claimed as passed");
      assert.strictEqual(r?.verdict, "blocked");
      assert.ok(r?.checks.find((c) => c.id === "workerMove")?.details[0].includes("shop.orders (agent Counter): acme-core → shop-orders"));
    } finally {
      delete process.env.BYNK_FAKE_DEPLOY;
    }
  });

  it("the command shows the panel for the chosen environment", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("bynk.checkDeployReadiness", { environment: "staging", context: "" });
    await waitFor(() => tabOpen("Bynk Deploy Readiness: staging"), truthy, "the readiness panel", 20_000);
  });
});
