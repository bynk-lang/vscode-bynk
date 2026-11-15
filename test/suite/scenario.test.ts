// #149: request scenarios end to end. Routes and body shapes come from the
// real language server (`bynk/wireContract`); the requests go to the stand-in
// `bynk dev` (test/fixtures/fake-bynk, `BYNK_FAKE_DEV=http`), which answers 201
// with an echo of what it was sent.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import type { StepResult } from "../../src/scenarioCore";
import { useFakeBynk } from "./fakeBynk";
import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";

const SRC = `context shop

type Item = { name: String, qty: Int }

service api from http {
  on GET("/ping") () -> Effect[HttpResult[String]] by v: Visitor {
    Ok("pong")
  }

  on PUT("/items/:id") (id: String, body: Item) -> Effect[HttpResult[String]] by v: Visitor {
    Ok(id)
  }
}
`;

const RUN = `@context shop

### create
PUT /items/abc
Content-Type: application/json

{ "name": "x", "qty": 2 }

? status == 201
? body.method == "PUT"

### ping
GET /ping
X-Prev: {{create.body.url}}
X-Secret: {{env.SCENARIO_TEST_SECRET}}

? body.headers.x-prev == "/items/abc"
? body.headers.x-secret == "nope"

### after
GET /ping
X-Prev: {{ping.body.url}}
`;

const BAD = `@context shop

### one
PUT /items/1

{ "name": "x" }

### two
GET /nope

### three
GET /ping?a=1
X: {{four.status}}

### four
GET /ping
`;

describe("Request scenarios (#149)", () => {
  let dir: string;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;

  const write = (rel: string, text: string): vscode.Uri => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return vscode.Uri.file(file);
  };

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".sc-")));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "sc"\n\n[paths]\ninclude = ["src"]\n');
    const src = write("src/shop.bynk", SRC);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(src));
    fake = await useFakeBynk();
  });

  after(async () => {
    await vscode.commands.executeCommand("bynk.stopDevServer");
    delete process.env.BYNK_FAKE_DEV;
    delete process.env.BYNK_FAKE_DEV_CONTEXT;
    delete process.env.SCENARIO_TEST_SECRET;
    await fake?.restore();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("checks a scenario against the wire contract", async function () {
    this.timeout(90_000);
    const uri = write("scenarios/bad.bynk-http", BAD);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const ds = await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (d) => d.some((x) => x.message.includes("missing")),
      "the scenario's diagnostics",
      60_000,
    );
    const at = (line: number) => ds.filter((d) => d.range.start.line === line).map((d) => d.message);
    assert.deepStrictEqual(at(5), ['body: missing "qty".']);
    assert.deepStrictEqual(at(8), ["No handler serves `GET /nope` in shop."]);
    assert.deepStrictEqual(at(12), ["`four` runs after this step, so `{{four.status}}` has nothing yet."]);
    assert.ok(ds.every((d) => d.source === "bynk scenario"));
  });

  it("puts Run lenses on the scenario and on each step", async function () {
    this.timeout(30_000);
    const uri = write("scenarios/run.bynk-http", RUN);
    const doc = await vscode.workspace.openTextDocument(uri);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);
    const titles = lenses.map((l) => [l.range.start.line, l.command?.title]);
    assert.ok(titles.some(([line, t]) => line === 2 && /Run scenario/.test(String(t))), JSON.stringify(titles));
    const steps = lenses.filter((l) => /Run step/.test(l.command?.title ?? "")).map((l) => l.range.start.line);
    assert.deepStrictEqual(steps, [2, 11, 19]);
    assert.strictEqual(doc.languageId, "bynk-http");
  });

  it("runs a scenario on the dev server, threading captures and hiding the environment", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    process.env.BYNK_FAKE_DEV = "http";
    process.env.BYNK_FAKE_DEV_CONTEXT = "shop";
    process.env.SCENARIO_TEST_SECRET = "s3cr3t-value";
    await vscode.commands.executeCommand("bynk.startDevServer");
    const uri = vscode.Uri.file(path.join(dir, "scenarios", "run.bynk-http"));
    const results = await waitFor(
      async () => {
        const r = await vscode.commands.executeCommand<StepResult[] | undefined>("bynk.scenario.run", uri.toString());
        return r?.[0]?.state === "error" ? undefined : r;
      },
      (r) => r !== undefined,
      "the dev server to be ready for the scenario",
      45_000,
    );
    assert.ok(results);
    assert.deepStrictEqual(
      results.map((r) => [r.step, r.state]),
      [
        ["create", "passed"],
        ["ping", "failed"],
        ["after", "skipped"],
      ],
    );
    const ping = results[1];
    assert.ok(ping.message?.includes("body.headers.x-secret == \"nope\""), String(ping.message));
    assert.ok(!JSON.stringify(results).includes("s3cr3t-value"), "the environment's value is not in the results");
    assert.strictEqual(results[2].message, "skipped: unresolved capture `ping.body.url`");
    const ds = vscode.languages.getDiagnostics(uri).filter((d) => d.source === "bynk scenario run");
    assert.deepStrictEqual(
      ds.map((d) => d.range.start.line),
      [17, 20],
    );
  });

  it("runs one step with only what it reads", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(30_000);
    const uri = vscode.Uri.file(path.join(dir, "scenarios", "run.bynk-http"));
    const results = await vscode.commands.executeCommand<StepResult[]>("bynk.scenario.run", uri.toString(), "ping");
    assert.deepStrictEqual(results.map((r) => r.step), ["create", "ping"]);
  });

  it("saves a request from Send Request to a scenario file, keeping credentials out", async function () {
    this.timeout(30_000);
    const pick = vscode.window.showQuickPick;
    const input = vscode.window.showInputBox;
    (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: readonly string[]) => items[0];
    (vscode.window as { showInputBox: unknown }).showInputBox = async () => "saved";
    try {
      const target = await vscode.commands.executeCommand<vscode.Uri | undefined>("bynk._scenarioSave", {
        handlerUri: vscode.Uri.file(path.join(dir, "src", "shop.bynk")).toString(),
        unit: "shop",
        method: "PUT",
        path: "/items/abc",
        headers: "Authorization: Bearer topsecret",
        body: '{ "name": "x", "qty": 1 }',
        status: 201,
      });
      assert.ok(target);
      assert.strictEqual(target.fsPath, path.join(dir, "scenarios", "saved.bynk-http"));
      const text = fs.readFileSync(target.fsPath, "utf8");
      assert.ok(!text.includes("topsecret"), text);
      assert.ok(text.includes("Authorization: {{env.AUTHORIZATION}}"), text);
      assert.ok(text.includes("### put_items_abc\nPUT /items/abc"), text);
      assert.ok(text.includes("? status == 201"), text);
      // What was saved is valid against the contract.
      await new Promise((r) => setTimeout(r, 2000));
      assert.deepStrictEqual(vscode.languages.getDiagnostics(target).map((d) => d.message), []);
    } finally {
      (vscode.window as { showQuickPick: unknown }).showQuickPick = pick;
      (vscode.window as { showInputBox: unknown }).showInputBox = input;
    }
  });
});
