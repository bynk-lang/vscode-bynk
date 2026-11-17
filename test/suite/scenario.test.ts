// #149: request scenarios end to end. Routes and body shapes come from the
// real language server (`bynk/wireContract`); the requests go to the stand-in
// `bynk dev` (test/fixtures/fake-bynk, `BYNK_FAKE_DEV=http`), which answers 201
// with an echo of what it was sent.

import * as assert from "assert";
import * as fs from "fs";
import * as http from "http";
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

  // #160: the contract carries `success` and each response's `payload`/`body`
  // (v0.633.4, v0.633.9), so a capture is checked against what the handler
  // answers. This fails, rather than skips, if the pinned server stops sending them.
  it("warns when a capture names nothing in the response, or can't fit where it is used (#160)", async function () {
    this.timeout(90_000);
    const uri = write(
      "scenarios/types.bynk-http",
      `@context shop

### create
PUT /items/abc
Content-Type: application/json

{ "name": "x", "qty": 2 }

? status == 200
? body.nope exists

### again
PUT /items/{{create.body.nope}}
Content-Type: application/json

{ "name": "x", "qty": {{create.body}} }

### fine
GET /ping
X: {{create.body}}

? status == 200
? body == "pong"

### also_fine
PUT /items/{{create.body}}
Content-Type: application/json

{ "name": {{create.body}}, "qty": 1 }
`,
    );
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    const ds = await waitFor(
      () => vscode.languages.getDiagnostics(uri),
      (d) => d.some((x) => x.message.includes("has no field")),
      "the response-type warnings",
      60_000,
    );
    const at = (line: number) => ds.filter((d) => d.range.start.line === line);
    assert.match(at(9)[0].message, /^`\? body\.nope`: `String` has no field `nope` \(`PUT \/items\/:id` answers 200\)/);
    assert.match(at(12)[0].message, /`\{\{create\.body\.nope\}\}`: `String` has no field `nope`/);
    assert.match(at(15)[0].message, /body\.qty: `\{\{create\.body\}\}` is String \(string\), but number is expected here/);
    // The correct ones, against the same real contract: a header capture, a `? body ==` the
    // String response can hold, a path parameter and a body field that are Strings: nothing.
    for (const l of [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]) assert.deepStrictEqual(at(l), [], `line ${l}`);
    // Every response-side diagnostic is a warning.
    assert.ok([9, 12, 15].every((l) => at(l).every((d) => d.severity === vscode.DiagnosticSeverity.Warning)), JSON.stringify(ds.map((d) => d.message)));
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

  describe("promoted to a system-tier suite (#158)", () => {
    const PROMO = `@context shop

### create
PUT /items/abc
Content-Type: application/json

{ "name": "x", "qty": 2 }

? status == 200

### ping
GET /ping
Authorization: Bearer {{env.PROMO_TOKEN}}

? header content-type == "application/json"
`;
    const kept = () => path.join(dir, ".promote-suite.bynk");

    async function promote(answer: string | undefined) {
      const pick = vscode.window.showQuickPick;
      const info = vscode.window.showInformationMessage;
      (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: readonly string[]) => items[0];
      (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async () => answer;
      try {
        write("scenarios/promo.bynk-http", PROMO);
        const uri = vscode.Uri.file(path.join(dir, "scenarios", "promo.bynk-http"));
        return await vscode.commands.executeCommand<vscode.Uri | undefined>("bynk.scenario.promote", uri.toString());
      } finally {
        (vscode.window as { showQuickPick: unknown }).showQuickPick = pick;
        (vscode.window as { showInformationMessage: unknown }).showInformationMessage = info;
      }
    }

    after(() => {
      delete process.env.BYNK_FAKE_CHECK;
      delete process.env.BYNK_FAKE_CHECK_SUITE;
    });

    it("checks the suite with the compiler in a scratch copy, lists what it cannot express and writes nothing secret", async function () {
      this.timeout(60_000);
      process.env.BYNK_FAKE_CHECK_SUITE = kept();
      const target = await promote("Write suite");
      assert.ok(target, "the suite was written");
      assert.strictEqual(target.fsPath, path.join(dir, "tests", "promo.bynk"));
      const text = fs.readFileSync(target.fsPath, "utf8");
      assert.ok(text.includes("suite shop as system {"), text);
      assert.ok(text.includes('let Ok(_) <- api.PUT("/items/:id", "abc", Item { name: "x", qty: 2 }) by Visitor else { expect false }'), text);
      assert.ok(text.includes("// Not expressed (1 of 2 expectations"), text);
      assert.ok(text.includes("content-type"), text);
      assert.ok(!/PROMO_TOKEN|Bearer/.test(text), text);
      // What the compiler checked was this text, at its path in a scratch copy of the project.
      assert.strictEqual(fs.readFileSync(kept(), "utf8"), text);
      fs.rmSync(target.fsPath);
    });

    it("writes nothing when the compiler refuses the suite", async function () {
      this.timeout(60_000);
      process.env.BYNK_FAKE_CHECK = "errors";
      try {
        assert.strictEqual(await promote("Write suite"), undefined);
      } finally {
        delete process.env.BYNK_FAKE_CHECK;
      }
      assert.ok(!fs.existsSync(path.join(dir, "tests", "promo.bynk")));
    });

    it("writes nothing when the question is not answered", async function () {
      this.timeout(60_000);
      assert.strictEqual(await promote(undefined), undefined);
      assert.ok(!fs.existsSync(path.join(dir, "tests", "promo.bynk")));
    });
  });

  describe("against a [test.targets] target (#159)", () => {
    let server: http.Server;
    let port: number;
    const received: { method?: string; url?: string; auth?: string }[] = [];
    const AGAINST = "@context shop\n\n### list\nGET /ping\nAuthorization: {{env.AGAINST_TOKEN}}\n\n? status == 200\n\n### add\nPUT /items/abc\nContent-Type: application/json\n\n{ \"name\": \"x\", \"qty\": 1 }\n\n? status == 200\n";

    before(async () => {
      server = http.createServer((req, res) => {
        received.push({ method: req.method, url: req.url, auth: String(req.headers.authorization) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ echoed: req.headers.authorization }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      port = (server.address() as { port: number }).port;
      fs.writeFileSync(
        path.join(dir, "bynk.toml"),
        `[project]\nname = "sc"\n\n[paths]\ninclude = ["src"]\n\n` +
          `[test.targets.preview]\nurl.shop = "http://127.0.0.1:${port}"\nsecrets = ["AGAINST_SIGNING"]\n\n` +
          `[test.targets.prod]\nurl.shop = "http://127.0.0.1:${port}"\n\n` +
          `[test.targets.live]\nurl.shop = "http://127.0.0.1:${port}"\nproduction = true\n\n` +
          `[test.targets.elsewhere]\nurl.other = "http://127.0.0.1:${port}"\n`,
      );
      write("scenarios/against.bynk-http", AGAINST);
      process.env.AGAINST_TOKEN = "against-token-value";
    });

    after(async () => {
      delete process.env.AGAINST_TOKEN;
      await new Promise((r) => server.close(r));
    });

    /** Run **Run Scenario Against…** with the picker and prompts answered. */
    async function runAgainst(target: string, input?: (opts: vscode.InputBoxOptions) => string | undefined) {
      const pick = vscode.window.showQuickPick;
      const box = vscode.window.showInputBox;
      (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: readonly { label: string }[]) => items.find((i) => i.label === target);
      (vscode.window as { showInputBox: unknown }).showInputBox = async (o: vscode.InputBoxOptions) => (input ? input(o) : undefined);
      try {
        const uri = vscode.Uri.file(path.join(dir, "scenarios", "against.bynk-http"));
        return await vscode.commands.executeCommand<StepResult[] | undefined>("bynk.scenario.runAgainst", uri.toString());
      } finally {
        (vscode.window as { showQuickPick: unknown }).showQuickPick = pick;
        (vscode.window as { showInputBox: unknown }).showInputBox = box;
      }
    }

    it("sends each step to the target's URL for its context, hiding the environment", async function () {
      this.timeout(60_000);
      received.length = 0;
      const results = await runAgainst("preview");
      assert.ok(results);
      assert.deepStrictEqual(results.map((r) => [r.step, r.state]), [["list", "passed"], ["add", "passed"]]);
      assert.deepStrictEqual(received.map((r) => `${r.method} ${r.url}`), ["GET /ping", "PUT /items/abc"]);
      assert.strictEqual(received[0].auth, "against-token-value");
      assert.ok(!JSON.stringify(results).includes("against-token-value"));
    });

    it("asks for the target's name before a write to a target named like production, and sends nothing without it", async function () {
      this.timeout(60_000);
      received.length = 0;
      let prompt = "";
      assert.strictEqual(await runAgainst("prod", (o) => ((prompt = o.prompt ?? ""), "nope")), undefined);
      assert.match(prompt, /reads as production/);
      assert.match(prompt, /PUT \/items\/abc/);
      assert.deepStrictEqual(received, []);
      const results = await runAgainst("prod", () => "prod");
      assert.deepStrictEqual(results?.map((r) => r.state), ["passed", "passed"]);
      assert.strictEqual(received.length, 2);
    });

    it("refuses a target marked production = true, and does not offer it", async function () {
      this.timeout(60_000);
      received.length = 0;
      let offered: string[] = [];
      const pick = vscode.window.showQuickPick;
      (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: readonly { label: string }[]) => {
        offered = items.map((i) => i.label);
        return undefined;
      };
      try {
        const uri = vscode.Uri.file(path.join(dir, "scenarios", "against.bynk-http"));
        await vscode.commands.executeCommand("bynk.scenario.runAgainst", uri.toString());
      } finally {
        (vscode.window as { showQuickPick: unknown }).showQuickPick = pick;
      }
      assert.ok(offered.includes("preview") && offered.includes("prod"), offered.join());
      assert.ok(!offered.includes("live"), "a production = true target is not offered");
      // Typed by hand, it is still refused, and nothing is sent.
      const results = await runAgainst("Enter a target name…", () => "live");
      assert.strictEqual(results, undefined);
      assert.deepStrictEqual(received, []);
    });

    it("reports a context the target does not serve, per step", async function () {
      this.timeout(60_000);
      received.length = 0;
      const results = await runAgainst("elsewhere");
      assert.deepStrictEqual(results?.map((r) => r.state), ["error", "error"]);
      assert.match(results?.[0].message ?? "", /no URL for `shop`/);
      assert.deepStrictEqual(received, []);
    });

    it("refuses a literal credential in the file against a target", async function () {
      this.timeout(60_000);
      received.length = 0;
      const file = write("scenarios/against.bynk-http", AGAINST.replace("{{env.AGAINST_TOKEN}}", "Bearer literal-secret"));
      // The open buffer follows the file on the watcher's schedule: wait for it.
      await waitFor(
        async () => (await vscode.workspace.openTextDocument(file)).getText(),
        (t) => t.includes("literal-secret"),
        "the scenario's buffer to read the rewritten file",
        15_000,
      );
      const results = await runAgainst("preview");
      assert.strictEqual(results?.[0].state, "error");
      assert.match(results?.[0].message ?? "", /literal credential/);
      assert.ok(!JSON.stringify(results).includes("literal-secret"));
      assert.deepStrictEqual(received.map((r) => r.url), ["/items/abc"]);
      write("scenarios/against.bynk-http", AGAINST);
    });
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
