// #44: the Bynk sidebar's view commands and the architecture map, end to end
// against the real language server. Each command opens a live view; the view's
// state is read through the `bynk._liveViewState` seam, as in liveViews.test.ts.
// The tree nodes are built by hand, as projectTree.test.ts does for the wire
// contract, since only their `uri`, `root` and `files` are read.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import { truthy, waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const ARCH = "bynkArchitectureMap";
const DOC = "bynkDocumentation";
const SEQ = "bynkSequenceDiagram";
const AGENT = "bynkAgentState";

interface Snapshot {
  open: boolean;
  target: { uri: string; position?: { line: number; character: number } } | undefined;
  hasPayload: boolean;
}

const SHOP = `context shop

service api from http {
  on GET("/a") () -> Effect[HttpResult[String]] by v: Visitor {
    Ok("a")
  }
}
`;

const ORDERS = `context orders

agent Counter {
  key id: String

  store total: Cell[Int]

  on call bump() -> Effect[Int] {
    total := total + 1
    total
  }
}
`;

const win = vscode.window as unknown as Record<string, unknown>;
const state = (view: string) => vscode.commands.executeCommand<Snapshot>("bynk._liveViewState", view);

describe("Bynk project view commands (#44)", () => {
  let dir: string;
  let root: vscode.Uri;
  let shop: vscode.Uri;
  let orders: vscode.Uri;

  /** Run `command` until `view` is open on `want` with its model drawn: the
   *  server may not have committed a round for the new project yet. */
  const opens = (command: string, args: unknown[], view: string, want: (uri: string) => boolean, what: string) =>
    waitFor(
      async () => {
        await vscode.commands.executeCommand(command, ...args);
        return state(view);
      },
      (s) => s?.open === true && s.hasPayload && s.target !== undefined && want(s.target.uri),
      what,
      45_000,
    );

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".cv-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "cv"\n\n[paths]\ninclude = ["src"]\n');
    fs.writeFileSync(path.join(dir, "src", "shop.bynk"), SHOP);
    fs.writeFileSync(path.join(dir, "src", "orders.bynk"), ORDERS);
    root = vscode.Uri.file(dir);
    shop = vscode.Uri.file(path.join(dir, "src", "shop.bynk"));
    orders = vscode.Uri.file(path.join(dir, "src", "orders.bynk"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(shop));
    // The tree has loaded the project once it lists a `shop` unit.
    await waitFor(
      () => vscode.commands.executeCommand<unknown[]>("bynk._projectTreeSnapshot", 3, true),
      (t) => JSON.stringify(t).includes('"shop"') && JSON.stringify(t).includes('"orders"'),
      "the project tree to list the new project",
      60_000,
    );
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("bynk.showArchitectureMap opens the map on the file's project", async function () {
    this.timeout(60_000);
    const s = await opens("bynk.showArchitectureMap", [shop.toString()], ARCH, (u) => u === shop.toString(), "the architecture map");
    assert.strictEqual(s.target?.uri, shop.toString());
  });

  it("bynk.showArchitectureMap says so when there is no .bynk file to resolve a project from", async function () {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitFor(() => vscode.window.activeTextEditor, (e) => e === undefined, "the editors to close");
    const real = { showErrorMessage: win.showErrorMessage };
    const errors: string[] = [];
    win.showErrorMessage = async (m: string) => (errors.push(m), undefined);
    try {
      await vscode.commands.executeCommand("bynk.showArchitectureMap");
    } finally {
      Object.assign(win, real);
    }
    assert.match(errors[0] ?? "", /needs a \.bynk file open/);
  });

  it("bynk.project.showArchitectureMap opens the map on one of the project's files", async function () {
    this.timeout(60_000);
    const mine = [shop.toString(), orders.toString()];
    await opens(
      "bynk.project.showArchitectureMap",
      [{ type: "project", root, groups: [] }],
      ARCH,
      (u) => mine.includes(u),
      "the architecture map for the project node",
    );
  });

  it("bynk.project.showDocumentation opens the unit's documentation", async function () {
    this.timeout(60_000);
    await opens(
      "bynk.project.showDocumentation",
      [{ type: "unit", root: root.toString(), unit: { files: [shop.toString()] } }],
      DOC,
      (u) => u === shop.toString(),
      "the documentation view",
    );
  });

  it("bynk.project.sequenceDiagram opens the diagram on the handler node", async function () {
    this.timeout(60_000);
    const start = { line: 3, character: 4 };
    const s = await opens(
      "bynk.project.sequenceDiagram",
      [{ type: "decl", uri: shop.toString(), handler: true, label: "on GET", symbol: { selectionRange: { start } } }],
      SEQ,
      (u) => u === shop.toString(),
      "the sequence view",
    );
    assert.strictEqual(s.target?.position?.line, start.line);
  });

  it("bynk.migrate.showAgentState opens the agent's state view at its declaration", async function () {
    this.timeout(60_000);
    const s = await opens(
      "bynk.migrate.showAgentState",
      [root, "orders.Counter"],
      AGENT,
      (u) => u === orders.toString(),
      "the agent state view",
    );
    assert.strictEqual(s.target?.position?.line, 2, "at `agent Counter`");
  });

  it("bynk.migrate.showAgentState warns when the agent is not in the sources", async function () {
    this.timeout(30_000);
    const real = { showWarningMessage: win.showWarningMessage };
    const warned: string[] = [];
    win.showWarningMessage = async (m: string) => (warned.push(m), undefined);
    try {
      await vscode.commands.executeCommand("bynk.migrate.showAgentState", root, "orders.Missing");
      await waitFor(() => warned.length, truthy, "the warning");
    } finally {
      Object.assign(win, real);
    }
    assert.match(warned[0], /could not find the agent `orders\.Missing`/);
  });
});
