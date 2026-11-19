// #225: the payload-size hint against the real language server. A queue
// handler whose message holds `Bytes` gets an Information diagnostic from
// source "bynk limits" naming the queue limit, and the setting turns it off;
// a handler with nothing unbounded gets none. Runs in the extension host with
// the pinned toolchain's server (`bynk/wireContract`, v0.639.1).

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";

const SRC = `context uploads

type Upload = { name: String, data: Bytes }
type Ping = { note: String }

service intake from queue("uploads") {
  on message(message: Upload) -> Effect[QueueResult] {
    Ack
  }
}

service pings from queue("pings") {
  on message(message: Ping) -> Effect[QueueResult] {
    Ack
  }
}
`;

const limitsOf = (uri: vscode.Uri): vscode.Diagnostic[] => vscode.languages.getDiagnostics(uri).filter((d) => d.source === "bynk limits");

describe("platform limit hints (#225)", () => {
  let dir: string;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".pl-")));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "pl"\n\n[paths]\ninclude = ["src"]\n');
    fs.writeFileSync(path.join(dir, "src", "uploads.bynk"), SRC);
  });

  after(async () => {
    await vscode.workspace.getConfiguration("bynk").update("platform.limitHints", undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("contributes the plan and the hints settings", () => {
    const props = vscode.extensions.getExtension(EXT_ID)?.packageJSON.contributes.configuration.properties;
    assert.strictEqual(props["bynk.platform.plan"].default, "free");
    assert.deepStrictEqual(props["bynk.platform.plan"].enum, ["free", "paid"]);
    assert.strictEqual(props["bynk.platform.limitHints"].default, true);
  });

  it("marks the queue handler that takes Bytes, only, and the setting turns it off", async function () {
    this.timeout(120_000);
    const uri = vscode.Uri.file(path.join(dir, "src", "uploads.bynk"));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    const found = await waitFor(() => limitsOf(uri), (d) => d.length > 0, "the bynk limits diagnostic", 90_000);
    assert.strictEqual(found.length, 1, "only the handler with Bytes is marked");
    const [d] = found;
    assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Information);
    assert.match(d.message, /may be larger than a queue allows/);
    assert.match(d.message, /128 KB/);
    const code = d.code as { value: string; target: vscode.Uri };
    assert.strictEqual(code.value, "limits.queueMessage");
    assert.match(code.target.toString(), /developers\.cloudflare\.com\/queues/);
    assert.ok(doc.lineAt(d.range.start.line).text.includes("on message") || doc.lineAt(d.range.start.line).text.includes("message"), "on the handler");
    assert.ok(d.range.start.line < doc.positionAt(doc.getText().indexOf("service pings")).line, "on the first service's handler");

    await vscode.workspace.getConfiguration("bynk").update("platform.limitHints", false, vscode.ConfigurationTarget.Global);
    await waitFor(() => limitsOf(uri), (d2) => d2.length === 0, "the diagnostic to clear", 30_000);
  });
});
