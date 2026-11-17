// #182: Worker groups end to end, in a project copied from test/fixtures/groups
// (one group `core` holding shop.orders and shop.catalogue, and shop.payment on
// a Worker of its own). The Environments view, Send Request, scenarios on the
// dev server and against a target, and the deploy and tail argument lists all
// resolve a member's Worker through the group. The stand-in `bynk` serves the
// group as `bynk dev` does: one Worker, named by its key, on one port.

import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

import * as vscode from "vscode";

import type { EnvNodeData } from "../../src/environmentsCore";
import type { StepResult } from "../../src/scenarioCore";
import type { SrPayload, SrResult } from "../../src/sendRequestCore";
import { useFakeBynk } from "./fakeBynk";
import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/groups");
const win = vscode.window as unknown as Record<string, unknown>;

interface Snapshot {
  id: string;
  label: string;
  description?: string;
  contextValue: string;
  data: EnvNodeData;
  children: Snapshot[];
}

describe("Worker groups (#182)", () => {
  let dir: string;
  let orders: vscode.Uri;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let seen = 0;
  const runs = (cmd: string) => fake.read().slice(seen).filter((e) => e.argv?.[0] === cmd);

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".wg-")));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    orders = vscode.Uri.file(path.join(dir, "src", "shop", "orders.bynk"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(orders));
    fake = await useFakeBynk();
  });

  after(async () => {
    await vscode.commands.executeCommand("bynk.stopDevServer");
    delete process.env.BYNK_FAKE_DEV;
    delete process.env.BYNK_FAKE_DEV_CONTEXT;
    await fake?.restore();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    seen = fake.read().length;
    // The project is the active .bynk file's: a plan panel opened by an earlier test takes the
    // focus, and the next command would then run against the workspace's own project.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(orders));
  });

  it("shows the group as one node holding its members in the Environments view", async function () {
    this.timeout(60_000);
    const tree = await waitFor(
      () => vscode.commands.executeCommand<Snapshot[]>("bynk._environmentsSnapshot"),
      (t) => (t ?? []).some((e) => e.id === "default" && e.children.some((c) => c.label === "core")),
      "the Environments view to list the group",
      30_000,
    );
    const env = tree.find((e) => e.id === "default")!;
    const core = env.children.find((c) => c.label === "core")!;
    assert.strictEqual(core.contextValue, "bynkEnvWorker");
    assert.deepStrictEqual(
      core.children.filter((c) => c.contextValue === "bynkEnvContext").map((c) => c.label),
      ["shop.orders", "shop.catalogue"],
    );
    assert.ok(!env.children.some((c) => c.label === "shop.orders"), "a member is not a Worker of its own");
    assert.ok(!env.children.some((c) => /not deployed/.test(c.description ?? "") && c.contextValue === "bynkEnvContext"));
    assert.ok(env.children.some((c) => c.label === "shop.payment" && c.contextValue === "bynkEnvContext"));
  });

  it("plans a deploy of a member as `--worker core`, and of another context as `--context`", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    const real = win.showInformationMessage;
    const told: string[] = [];
    win.showInformationMessage = async (m: string) => (told.push(m), undefined);
    try {
      await vscode.commands.executeCommand("bynk.showDeployPlan", { environment: "staging", context: "shop.orders" });
      await waitFor(() => runs("deploy").length, (n) => n >= 1, "the member's dry run", 20_000);
      await vscode.commands.executeCommand("bynk.showDeployPlan", { environment: "staging", worker: "core" });
      await vscode.commands.executeCommand("bynk.showDeployPlan", { environment: "staging", context: "shop.payment" });
      await waitFor(() => runs("deploy").length, (n) => n >= 3, "the other dry runs", 20_000);
    } finally {
      win.showInformationMessage = real;
    }
    assert.deepStrictEqual(
      runs("deploy").map((e) => e.argv),
      [
        ["deploy", "--dry-run", "--format", "json", "--env", "staging", "--worker", "core"],
        ["deploy", "--dry-run", "--format", "json", "--env", "staging", "--worker", "core"],
        ["deploy", "--dry-run", "--format", "json", "--env", "staging", "--context", "shop.payment"],
      ],
    );
    assert.match(told[0] ?? "", /shop\.orders is in the Worker group `core`/);
  });

  it("offers the group as one choice when picking what to deploy", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    let offered: { label: string }[] = [];
    const real = win.showQuickPick;
    win.showQuickPick = async (items: { label: string; scope?: unknown }[]) => {
      offered = items;
      return items.find((i) => i.label === "core");
    };
    try {
      await vscode.commands.executeCommand("bynk.showDeployPlan", { environment: "staging" });
      await waitFor(() => runs("deploy").length, (n) => n >= 1, "the group's dry run", 20_000);
    } finally {
      win.showQuickPick = real;
    }
    assert.deepStrictEqual(offered.map((i) => i.label), ["Whole project", "core", "shop.payment"]);
    assert.deepStrictEqual(runs("deploy")[0].argv, ["deploy", "--dry-run", "--format", "json", "--env", "staging", "--worker", "core"]);
  });

  it("tails a member's group through `--context core`", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    const real = win.showInformationMessage;
    win.showInformationMessage = async () => undefined;
    try {
      await vscode.commands.executeCommand("bynk.tailLogs", { environment: "staging", context: "shop.catalogue" });
      const terminal = await waitFor(
        () => vscode.window.terminals.find((t) => t.name === "Bynk Tail (staging)"),
        (t) => t !== undefined,
        "the tail terminal",
        20_000,
      );
      const options = terminal!.creationOptions as vscode.TerminalOptions;
      assert.deepStrictEqual(options.shellArgs, ["tail", "--env", "staging", "--context", "core"]);
    } finally {
      win.showInformationMessage = real;
      vscode.window.terminals.filter((t) => t.name === "Bynk Tail (staging)").forEach((t) => t.dispose());
    }
  });

  describe("on the dev server", () => {
    it("routes a member's request to the group's one port, and a scenario step with it", async function () {
      if (process.platform === "win32") this.skip();
      this.timeout(120_000);
      process.env.BYNK_FAKE_DEV = "http";
      // `bynk dev` serves a group as one Worker, named by its key.
      process.env.BYNK_FAKE_DEV_CONTEXT = "core";
      const real = win.showQuickPick;
      win.showQuickPick = async (items: { all?: boolean }[]) => items.find((i) => i.all);
      try {
        const at = new vscode.Position(3, 4);
        await vscode.commands.executeCommand("bynk.startDevServer");
        const p = (await waitFor(
          async () => {
            await vscode.commands.executeCommand("bynk.sendRequest", orders.toString(), at);
            return vscode.commands.executeCommand<SrPayload | null>("bynk._sendRequestPayload");
          },
          (q) => q?.target.kind === "ready",
          "Send Request to see the dev server serve the group",
          60_000,
        ))!;
        assert.strictEqual(p.unit, "shop.orders");
        const r = await vscode.commands.executeCommand<SrResult>("bynk._sendRequestSend", { path: { id: "7" }, headers: "", body: "" });
        assert.ok(r.kind === "response", JSON.stringify(r));
        assert.strictEqual(r.status, 201);
        assert.ok(p.target.kind === "ready" && r.url === `${p.target.url}/orders/7`);

        const scenario = vscode.Uri.file(path.join(dir, "scenarios", "orders.bynk-http"));
        fs.writeFileSync(scenario.fsPath, "@context shop.orders\n\n### fetch\nGET /orders/42\n\n? status == 201\n");
        const results = await vscode.commands.executeCommand<StepResult[] | undefined>("bynk.scenario.run", scenario.toString());
        assert.deepStrictEqual(results?.map((s) => [s.step, s.state]), [["fetch", "passed"]]);
      } finally {
        win.showQuickPick = real;
        await vscode.commands.executeCommand("bynk.stopDevServer");
      }
    });
  });

  describe("against a [test.targets] target", () => {
    let server: http.Server;
    const received: string[] = [];

    before(async () => {
      server = http.createServer((req, res) => {
        received.push(`${req.method} ${req.url}`);
        res.end("{}");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      // `url.<worker>` is keyed by Worker directory: the group's key.
      const manifest = path.join(dir, "bynk.toml");
      fs.writeFileSync(
        manifest,
        fs
          .readFileSync(manifest, "utf8")
          .replace("https://core-preview.example.workers.dev", `http://127.0.0.1:${port}`),
      );
    });

    after(async () => {
      await new Promise((r) => server.close(r));
      // A workspace remembers the last target it ran against (`bynk.test.lastTarget`) and
      // offers it first. Finish on `dev`, the picker's default, so later suites see the order
      // they expect.
      const quick = win.showQuickPick;
      const warn = win.showWarningMessage;
      win.showQuickPick = async (items: { label: string }[]) => items.find((i) => i.label === "dev");
      win.showWarningMessage = async () => undefined;
      try {
        await vscode.commands.executeCommand(
          "bynk.scenario.runAgainst",
          vscode.Uri.file(path.join(dir, "scenarios", "orders.bynk-http")).toString(),
        );
      } finally {
        win.showQuickPick = quick;
        win.showWarningMessage = warn;
      }
    });

    it("sends a member's step to the URL keyed by the group, not by the member", async function () {
      this.timeout(60_000);
      const scenario = path.join(dir, "scenarios", "orders.bynk-http");
      fs.writeFileSync(scenario, "@context shop.orders\n\n### fetch\nGET /orders/42\n\n? status == 200\n");
      const real = win.showQuickPick;
      const box = win.showInputBox;
      win.showQuickPick = async (items: { label: string }[]) => items.find((i) => i.label === "preview");
      win.showInputBox = async () => undefined;
      let results: StepResult[] | undefined;
      try {
        results = await vscode.commands.executeCommand<StepResult[] | undefined>("bynk.scenario.runAgainst", vscode.Uri.file(scenario).toString());
      } finally {
        win.showQuickPick = real;
        win.showInputBox = box;
      }
      assert.deepStrictEqual(results?.map((s) => [s.step, s.state]), [["fetch", "passed"]], JSON.stringify(results));
      assert.deepStrictEqual(received, ["GET /orders/42"]);
    });
  });
});
