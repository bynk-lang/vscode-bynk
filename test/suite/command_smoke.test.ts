// #44: smoke tests for commands no other test runs. Each runs the command and
// checks its visible effect: the file it opens, the CLI run it makes, the file it
// writes.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { truthy, waitFor } from "./util";

const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
const manifest = path.join(workspace, "bynk.toml");

const openManifest = () =>
  waitFor(
    () => vscode.window.activeTextEditor?.document.uri.fsPath,
    (p) => p === manifest,
    "bynk.toml to be the active editor",
  );

describe("Bynk command smoke tests (#44)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  before(async () => {
    fake = await useFakeBynk();
  });
  after(async () => {
    await fake.restore();
  });
  beforeEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));
  afterEach(() => vscode.commands.executeCommand("workbench.action.closeAllEditors"));

  it("bynk.openProjectConfig opens the project's bynk.toml", async () => {
    await vscode.commands.executeCommand("bynk.openProjectConfig");
    await openManifest();
  });

  it("bynk.dependencies.openManifest opens the bynk.toml of a root", async () => {
    await vscode.commands.executeCommand("bynk.dependencies.openManifest", vscode.Uri.file(workspace));
    await openManifest();
  });

  it("bynk.migrate.refresh asks the driver for the migration status", async function () {
    if (process.platform === "win32") this.skip();
    await vscode.commands.executeCommand("bynk.migrate.refresh");
    await waitFor(
      () => fake.read().some((e) => e.argv?.[0] === "migrate" && e.argv[1] === "status"),
      truthy,
      "`bynk migrate status` to run",
    );
  });

  it("bynk.exportOpenapi runs `bynk openapi` into the chosen file", async function () {
    if (process.platform === "win32") this.skip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-openapi-"));
    const target = path.join(dir, "api.json");
    const win = vscode.window as unknown as Record<string, unknown>;
    const real = { showSaveDialog: win.showSaveDialog, showInformationMessage: win.showInformationMessage };
    const told: string[] = [];
    win.showSaveDialog = async () => vscode.Uri.file(target);
    win.showInformationMessage = async (m: string) => (told.push(m), undefined);
    try {
      await vscode.commands.executeCommand("bynk.exportOpenapi");
      await waitFor(() => told.length, truthy, "the export to report");
      assert.match(told[0], /^Wrote /);
      assert.strictEqual(JSON.parse(fs.readFileSync(target, "utf8")).openapi, "3.1.0");
      const run = fake.read().find((e) => e.argv?.[0] === "openapi")!;
      assert.deepStrictEqual(run.argv!.slice(2), ["--out", target]);
    } finally {
      Object.assign(win, real);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bynk.showServerOutput and bynk.showLogs run", async () => {
    // An output channel cannot be read back, so this only proves the commands
    // are wired and complete.
    await vscode.commands.executeCommand("bynk.showServerOutput");
    await vscode.commands.executeCommand("bynk.showLogs");
  });
});
