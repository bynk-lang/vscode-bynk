// #222 (Part 1) integration test: Bynk: Revert…, against the stand-in `bynk`
// (test/fixtures/fake-bynk), in a project copied from test/fixtures/groups. The
// stand-in answers `bynk revert --dry-run --format json` with the document
// recorded from the pinned driver (a refusal) or the same schema for a clean
// check, and a real revert only prints a line, so nothing reaches Cloudflare.
// The modals are stubbed; what is asserted is exactly what `bynk` was run with.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/groups");

describe("Bynk revert (#222)", () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let seen = 0;
  const runs = () => fake.read().slice(seen).filter((e) => e.argv?.[0] === "revert");
  const real = () => runs().filter((e) => e.argv?.includes("--yes"));
  const win = vscode.window as unknown as Record<string, unknown>;
  const originals: Record<string, unknown> = {};
  let modals: { title: string; detail?: string }[] = [];
  let errors: string[] = [];
  let answer: string | undefined;
  let typedAnswer: string | undefined;
  let typedPrompts = 0;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".rv-")));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    const orders = vscode.Uri.file(path.join(dir, "src", "shop", "orders.bynk"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(orders));
    fake = await useFakeBynk();
    for (const k of ["showWarningMessage", "showErrorMessage", "showInformationMessage", "showInputBox"]) originals[k] = win[k];
    win.showWarningMessage = async (title: string, opts: { detail?: string }, ...items: string[]) => {
      modals.push({ title, detail: opts?.detail });
      return answer === undefined ? undefined : items.find((i) => i === answer);
    };
    win.showErrorMessage = async (m: string) => (errors.push(m), undefined);
    win.showInformationMessage = async () => undefined;
    win.showInputBox = async () => (typedPrompts++, typedAnswer);
  });
  after(async () => {
    for (const [k, v] of Object.entries(originals)) win[k] = v;
    delete process.env.BYNK_FAKE_REVERT;
    await fake?.restore();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    seen = fake.read().length;
    modals = [];
    errors = [];
    answer = undefined;
    typedAnswer = undefined;
    typedPrompts = 0;
    delete process.env.BYNK_FAKE_REVERT;
  });
  const revert = (preset: object) => vscode.commands.executeCommand("bynk.revert", preset);

  it("a dry run that refuses ends there: no confirmation, no real revert", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    process.env.BYNK_FAKE_REVERT = "refused";
    await revert({ environment: "staging", worker: "core" });
    await waitFor(() => errors.length, (n) => n > 0, "the refusal message");
    assert.deepStrictEqual(runs().map((e) => e.argv), [["revert", "--dry-run", "--format", "json", "--env", "staging", "--worker", "core"]]);
    assert.match(errors[0], /refuses this revert .*core: history/);
    assert.strictEqual(modals.length, 0);
    assert.strictEqual(real().length, 0);
  });

  it("a dry run that would revert, then a cancelled confirmation, runs nothing", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    answer = undefined; // the modal is dismissed
    await revert({ environment: "staging", worker: "core" });
    await waitFor(() => modals.length, (n) => n > 0, "the confirmation");
    assert.match(modals[0].title, /Revert core in "staging"\?/);
    assert.match(modals[0].detail ?? "", /Environment: staging/);
    assert.match(modals[0].detail ?? "", /Worker group/, "core is a group: every member goes back together");
    assert.strictEqual(runs().length, 1, "only the dry run");
    assert.strictEqual(real().length, 0);
  });

  it("a confirmed revert runs bynk revert --yes with the previewed scope, and never an override", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    answer = "Revert";
    await revert({ environment: "staging", worker: "core" });
    await waitFor(() => real().length, (n) => n === 1, "the real revert");
    assert.deepStrictEqual(runs().map((e) => e.argv), [
      ["revert", "--dry-run", "--format", "json", "--env", "staging", "--worker", "core"],
      ["revert", "--yes", "--env", "staging", "--worker", "core"],
    ]);
    for (const e of runs()) for (const banned of ["--accept-schema-ahead", "--accept-secret-changes", "--to"]) assert.ok(!e.argv!.includes(banned));
    assert.strictEqual(typedPrompts, 0, "staging is not production");
  });

  it("a production-like environment needs its name typed too", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    answer = "Revert";
    typedAnswer = undefined; // typing cancelled
    await revert({ environment: "production", context: "" });
    await waitFor(() => typedPrompts, (n) => n === 1, "the typed confirmation");
    assert.strictEqual(real().length, 0, "nothing runs until it is typed");
    assert.deepStrictEqual(runs().map((e) => e.argv), [["revert", "--dry-run", "--format", "json", "--env", "production"]]);

    typedAnswer = "production";
    seen = fake.read().length;
    await revert({ environment: "production", context: "" });
    await waitFor(() => real().length, (n) => n === 1, "the real revert");
    assert.deepStrictEqual(real()[0].argv, ["revert", "--yes", "--env", "production"]);
  });

  it("a context in a group reverts the group's Worker", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    process.env.BYNK_FAKE_REVERT = "refused";
    await revert({ environment: "staging", context: "shop.orders" });
    await waitFor(() => runs().length, (n) => n === 1, "the dry run");
    assert.deepStrictEqual(runs()[0].argv, ["revert", "--dry-run", "--format", "json", "--env", "staging", "--worker", "core"]);
  });

  it("missing credentials are the CLI's to report: the extension says so and runs nothing more", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    process.env.BYNK_FAKE_REVERT = "credentials";
    await revert({ environment: "staging", worker: "core" });
    await waitFor(() => errors.length, (n) => n > 0, "the credentials message");
    assert.match(errors[0], /CLOUDFLARE_API_TOKEN/);
    assert.match(errors[0], /never stores, reads or asks/);
    assert.strictEqual(runs().length, 1);
    assert.strictEqual(modals.length + typedPrompts, 0);
  });
});
