// #148 integration test: the Bynk Query view's answers from the real pinned
// language server, over a project outside the workspace (opened in the editor,
// the way the model-diff test does, so the server analyses it).

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";

const MANIFEST = '[project]\nname = "q"\nversion = "0.1.0"\n\n[paths]\ninclude = ["src"]\n';
const SOURCE = `context q

consumes bynk { Logger }

service first from http {
  on GET("/first") () -> Effect[HttpResult[String]] by v: Visitor given Logger {
    let _ <- Logger.info("first")
    Ok("first")
  }
}

service second from http {
  on GET("/second") () -> Effect[HttpResult[String]] by v: Visitor {
    Ok("second")
  }
}
`;

describe("Bynk Query view (#148)", () => {
  let dir: string;
  const file = () => path.join(dir, "src", "q.bynk");
  const answer = (id: string) => vscode.commands.executeCommand<string[]>("bynk._queryAnswer", id);

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bynk-query-test-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), MANIFEST);
    fs.writeFileSync(file(), SOURCE);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file()));
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists which handlers use a capability, per context", async function () {
    this.timeout(90_000);
    const lines = await waitFor(
      () => answer("capabilities"),
      (l): l is string[] => !!l && l.some((x) => x.includes("Logger")),
      "the capabilities query to list Logger",
      60_000,
    );
    const logger = lines.findIndex((x) => x.trim().startsWith("bynk.Logger"));
    assert.ok(logger >= 0, `Logger is listed under the context: ${lines.join(" | ")}`);
    const rest = lines.slice(logger + 1).join("\n");
    assert.ok(/first/.test(rest), `the handler that gives Logger is listed as a user: ${lines.join(" | ")}`);
  });

  it("says there are no events in a project with none, and offers nothing to reach before a pick", async function () {
    this.timeout(60_000);
    const events = await answer("events");
    assert.ok(events.length >= 1);
    assert.ok(
      events.some((x) => /no events|does not report events/.test(x)),
      `an empty project says so: ${events.join(" | ")}`,
    );
    const reach = await answer("reachability");
    assert.ok(reach[0].startsWith("Choose a capability"), reach.join(" | "));
  });

  it("says there is no coverage yet, rather than listing every handler as untested", async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand("bynk.clearModelCoverage");
    const lines = await answer("untested");
    assert.ok(lines[0].startsWith("No coverage yet"), lines.join(" | "));
  });
});
