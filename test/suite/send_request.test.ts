// #67: Bynk: Send Request end to end. The form comes from the real language
// server's `bynk/wireContract`; the request goes to the stand-in `bynk dev`
// (test/fixtures/fake-bynk, `BYNK_FAKE_DEV=http`), which echoes what it was
// sent. The page itself is not driven: the `bynk._sendRequestSend` seam sends
// as its Send button does.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import type { SrPayload, SrResult } from "../../src/sendRequestCore";
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

service inner {
  on call() -> Effect[Int] {
    1
  }
}
`;

function lineOf(needle: string): number {
  return SRC.split("\n").findIndex((l) => l.includes(needle));
}

const payload = () => vscode.commands.executeCommand<SrPayload | null>("bynk._sendRequestPayload");

describe("Bynk: Send Request (#67)", () => {
  let dir: string;
  let uri: vscode.Uri;
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".sr-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "sr"\n\n[paths]\ninclude = ["src"]\n');
    fs.writeFileSync(path.join(dir, "src", "shop.bynk"), SRC);
    uri = vscode.Uri.file(path.join(dir, "src", "shop.bynk"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
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

  it("puts a Send request lens on HTTP handlers only", async function () {
    this.timeout(60_000);
    const lenses = await waitFor(
      () => vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri),
      (ls) => (ls ?? []).some((l) => l.command?.command === "bynk.sendRequest"),
      "the Send request lenses",
      60_000,
    );
    const lines = lenses.filter((l) => l.command?.command === "bynk.sendRequest").map((l) => l.range.start.line);
    assert.deepStrictEqual(lines, [lineOf('GET("/ping")'), lineOf('PUT("/items/:id")')]);
  });

  it("builds the form from the wire contract, and says the dev server is not running", async function () {
    this.timeout(60_000);
    const at = new vscode.Position(lineOf('PUT("/items/:id")') + 1, 4);
    const p = (await waitFor(
      async () => {
        await vscode.commands.executeCommand("bynk.sendRequest", uri.toString(), at);
        return payload();
      },
      (q) => q?.form.path === "/items/:id",
      "the Send Request panel to show the PUT handler",
      60_000,
    ))!;
    assert.strictEqual(p.form.method, "PUT");
    assert.deepStrictEqual(p.form.pathParams, ["id"]);
    assert.ok(p.form.body?.kind === "json");
    assert.deepStrictEqual(JSON.parse(p.form.body.skeleton), { name: "", qty: 0 });
    assert.deepStrictEqual(p.target, { kind: "stopped" });
    const r = await vscode.commands.executeCommand<SrResult>("bynk._sendRequestSend", { path: { id: "a" }, headers: "", body: "{}" });
    assert.ok(r.kind === "error" && /isn't running/.test(r.message), JSON.stringify(r));
  });

  it("sends the request to the handler's context on the dev server", async function () {
    if (process.platform === "win32") this.skip();
    this.timeout(60_000);
    process.env.BYNK_FAKE_DEV = "http";
    process.env.BYNK_FAKE_DEV_CONTEXT = "shop";
    await vscode.commands.executeCommand("bynk.startDevServer");
    // The panel follows the dev server: its target turns ready.
    const p = (await waitFor(payload, (q) => q?.target.kind === "ready", "the panel to see the dev server", 30_000))!;
    assert.ok(p.target.kind === "ready");

    const r = await vscode.commands.executeCommand<SrResult>("bynk._sendRequestSend", {
      path: { id: "a b" },
      headers: "Authorization: Bearer t\n# a comment",
      body: '{"name":"x","qty":2}',
    });
    assert.ok(r.kind === "response", JSON.stringify(r));
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.url, `${p.target.url}/items/a%20b`);
    assert.ok(r.json, "a JSON response is pretty-printed");
    const echo = JSON.parse(r.body) as { method: string; url: string; headers: Record<string, string>; body: string };
    assert.strictEqual(echo.method, "PUT");
    assert.strictEqual(echo.url, "/items/a%20b");
    assert.strictEqual(echo.headers.authorization, "Bearer t");
    assert.strictEqual(echo.headers["content-type"], "application/json");
    assert.strictEqual(echo.body, '{"name":"x","qty":2}', "the body goes as typed");
    assert.ok(r.headers.some(([k, v]) => k === "x-fake" && v === "echo"));
  });

  it("refuses a form that is not filled in, without sending", async () => {
    const r = await vscode.commands.executeCommand<SrResult>("bynk._sendRequestSend", { path: {}, headers: "", body: "{}" });
    assert.deepStrictEqual(r, { kind: "error", message: "Fill in :id.", method: undefined, url: undefined });
  });
});
