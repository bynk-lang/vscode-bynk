// #146 integration test: "Bynk: Show Impact" against the real pinned language
// server, over a project outside the workspace (opened in the editor so the
// server analyses it, as the model-diff and Query view tests do).

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";

const MANIFEST = '[project]\nname = "i"\nversion = "0.1.0"\n\n[paths]\ninclude = ["src"]\n';
const SOURCE = `context i

type Item = {
  name: String,
}

service api from http {
  on POST("/items") (body: Item) -> Effect[HttpResult[Item]] by Visitor {
    Ok(body)
  }
}
`;

describe("Bynk Show Impact (#146)", () => {
  let dir: string;
  const file = () => path.join(dir, "src", "i.bynk");

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bynk-impact-test-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), MANIFEST);
    fs.writeFileSync(file(), SOURCE);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()));
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds the route whose wire contract carries a type, in both directions", async function () {
    this.timeout(120_000);
    // The `Item` of `type Item`: line 2, column 5.
    const lines = await waitFor(
      async () => {
        await vscode.commands.executeCommand("bynk.showImpact", vscode.Uri.file(file()).toString(), { line: 2, character: 6 });
        return vscode.commands.executeCommand<string[]>("bynk._impactAnswer");
      },
      (l): l is string[] => !!l && l.some((x) => x.includes("POST /items")),
      "the impact of Item to list the route that carries it",
      90_000,
    );
    const route = lines.find((x) => x.includes("POST /items"));
    assert.ok(route?.includes("request and response"), `the route carries it both ways: ${lines.join(" | ")}`);
    // No other unit, event, client or test is involved here, and the view says so.
    assert.ok(lines.some((x) => x.includes("No other unit uses it")), lines.join(" | "));
    assert.ok(lines.some((x) => x.includes("No test mentions it")), lines.join(" | "));
    assert.ok(lines.some((x) => x.includes("The project has no [build.client]")), lines.join(" | "));
  });
});
