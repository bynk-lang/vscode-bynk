// #2196: the agent state view end to end, against the real language server —
// the `Show State` lens, the agent-scoped cursor-follow (retarget per agent,
// highlight per handler without a re-request) and the empty state. State is
// read through the `bynk._liveViewState` test seam, as in `liveViews.test.ts`.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";
import { useFakeBynk } from "./fakeBynk";
import { waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const VIEW = "bynkAgentState";

interface Snapshot {
  open: boolean;
  target: { uri: string; position?: { line: number; character: number } } | undefined;
  handler: string | undefined;
  refreshes: number;
  updates: number;
  hasPayload: boolean;
  focus: string | undefined;
  payload: { live?: { instances: Array<{ ref: string; key: string; context: string }>; problems: string[] } } | undefined;
}

const SRC = `context orders

type OrderStatus = enum { Pending, Placed, Cancelled }
type OrderError = enum { AlreadyPlaced, AlreadyCancelled }

agent Order {
  key id: String

  store status: Cell[OrderStatus] = Pending

  on call place() -> Effect[Result[(), OrderError]] {
    match status {
      Pending => {
        status := Placed
        Ok(())
      }
      Placed    => Err(AlreadyPlaced)
      Cancelled => Err(AlreadyCancelled)
    }
  }

  on call cancel() -> Effect[Result[(), OrderError]] {
    match status {
      Pending => {
        status := Cancelled
        Ok(())
      }
      Placed    => Err(AlreadyPlaced)
      Cancelled => Err(AlreadyCancelled)
    }
  }
}

agent Counter {
  key id: String

  store total: Cell[Int]

  on call bump() -> Effect[Int] {
    total := total + 1
    total
  }
}
`;

function state(): Thenable<Snapshot> {
  return vscode.commands.executeCommand<Snapshot>("bynk._liveViewState", VIEW);
}

function lineOf(needle: string): number {
  return SRC.split("\n").findIndex((l) => l.includes(needle));
}

describe("agent state view (#2196)", () => {
  let dir: string;
  let uri: vscode.Uri;
  let editor: vscode.TextEditor;

  before(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();

    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".as-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "as"\n\n[paths]\ninclude = ["src"]\n');
    fs.writeFileSync(path.join(dir, "src", "orders.bynk"), SRC);
    uri = vscode.Uri.file(path.join(dir, "src", "orders.bynk"));
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));

    // Open on `place`'s body once the server has committed a round.
    const inPlace = new vscode.Position(lineOf("status := Placed"), 8);
    await waitFor(
      async () => {
        await vscode.commands.executeCommand("bynk.showAgentState", uri.toString(), inPlace);
        return state();
      },
      (s) => s?.open === true && s.hasPayload,
      "the agent state view to open",
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

  it("offers one Show State lens per agent", async function () {
    this.timeout(40_000);
    const lenses = await waitFor(
      async () =>
        ((await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri)) ?? [])
          .filter((l) => l.command?.command === "bynk.showAgentState"),
      (l) => l.length >= 2,
      "the Show State lenses",
      30_000,
    );
    assert.deepStrictEqual(
      lenses.map((l) => l.range.start.line).sort((a, b) => a - b),
      [lineOf("agent Order"), lineOf("agent Counter")],
    );
  });

  it("targets the agent and highlights the handler the command was run in", async () => {
    const s = await state();
    assert.ok(s.handler?.includes("#Order@"), `keyed on the agent: ${s.handler}`);
    assert.strictEqual(s.focus, "place");
  });

  it("moves the highlight within the agent without re-requesting its model", async function () {
    this.timeout(40_000);
    editor = await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One);
    const before = await state();
    const inCancel = new vscode.Position(lineOf("status := Cancelled"), 8);
    editor.selection = new vscode.Selection(inCancel, inCancel);
    const after = await waitFor(() => state(), (s) => s.focus === "cancel", "the highlight to move", 30_000);
    assert.strictEqual(after.handler, before.handler, "still the same agent");
    assert.strictEqual(after.updates, before.updates, "no new model was rendered");
  });

  it("retargets to another agent, which has no state field", async function () {
    this.timeout(40_000);
    const before = await state();
    const inBump = new vscode.Position(lineOf("total := total + 1"), 6);
    editor.selection = new vscode.Selection(inBump, inBump);
    const after = await waitFor(() => state(), (s) => s.handler !== before.handler, "a retarget to Counter", 30_000);
    assert.ok(after.handler?.includes("#Counter@"), `keyed on Counter: ${after.handler}`);
    assert.ok(after.hasPayload, "an agent with no state field still has a (machine-free) model");
    assert.strictEqual(after.focus, "bump");
  });
});

// #145: live instances, against the stand-in `bynk` (which answers
// `bynk dev inspect` in v0.639.1's shape) and the real language server.
describe("agent state view: live instances (#145)", () => {
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  let dir: string;
  let uri: vscode.Uri;
  let at: vscode.Position;

  const show = () => vscode.commands.executeCommand("bynk.showAgentState", uri.toString(), at);
  const live = async () => (await state()).payload?.live;

  before(async function () {
    this.timeout(120_000);
    if (process.platform === "win32") this.skip();
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    fake = await useFakeBynk();
    const workspace = path.resolve(__dirname, "../../../test/fixtures/workspace");
    dir = fs.realpathSync(fs.mkdtempSync(path.join(workspace, ".li-")));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "bynk.toml"), '[project]\nname = "li"\n\n[paths]\ninclude = ["src"]\n');
    fs.writeFileSync(path.join(dir, "src", "orders.bynk"), SRC);
    uri = vscode.Uri.file(path.join(dir, "src", "orders.bynk"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    at = new vscode.Position(lineOf("status := Placed"), 8);
    await waitFor(async () => (await show(), state()), (s) => s?.open === true && s.hasPayload, "the view to open", 60_000);
  });

  after(async () => {
    await vscode.commands.executeCommand("bynk.stopDevServer");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await fake?.restore();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("offers no instances while no dev server runs, and runs no inspection", async () => {
    assert.strictEqual(await live(), undefined);
    assert.ok(!fake.read().some((e) => e.argv?.[1] === "inspect"));
  });

  it("lists the agent's instances once the dev server runs, and reads one", async function () {
    this.timeout(60_000);
    await vscode.commands.executeCommand("bynk.startDevServer");
    const l = await waitFor(live, (v) => (v?.instances.length ?? 0) > 0, "the instances to be listed", 40_000);
    assert.deepStrictEqual(l?.instances.map((i) => i.key), ["7", "o1"], "a numeric key and a string key, in Bynk's terms");
    assert.ok(l?.instances.every((i) => i.context === "orders"));
    const argv = fake.read().find((e) => e.argv?.[1] === "inspect" && e.argv[2] === "agents")?.argv;
    assert.deepStrictEqual(argv, ["dev", "inspect", "agents", ".", "--class", "Order"], "only this agent's class is asked for");

    const o1 = l!.instances.find((i) => i.key === "o1")!;
    const msg = (await vscode.commands.executeCommand("bynk._readLiveInstance", o1.ref)) as {
      inspection?: { exists: boolean; readable: boolean; states: Record<string, string | null>; schema: { behind: boolean }; history: unknown[] };
    };
    assert.strictEqual(msg.inspection?.readable, true);
    assert.deepStrictEqual(msg.inspection?.states, { status: "Placed" }, "the machine's current state, from the tagged cell");
    assert.strictEqual(msg.inspection?.history.length, 2);
    const read = fake.read().find((e) => e.argv?.[2] === "agent")?.argv;
    assert.deepStrictEqual(read, ["dev", "inspect", "agent", "--path", ".", "--context", "orders", "--", "Order", "o1"]);

    const seven = l!.instances.find((i) => i.key === "7")!;
    const old = (await vscode.commands.executeCommand("bynk._readLiveInstance", seven.ref)) as typeof msg;
    assert.strictEqual(old.inspection?.schema.behind, true, "an instance behind the class's schema version");
    assert.strictEqual(fake.read().filter((e) => e.argv?.[2] === "agent").pop()?.argv?.at(-1), "7", "a numeric key goes as its JSON");
  });

  it("reads only an instance it listed", async () => {
    const msg = await vscode.commands.executeCommand("bynk._readLiveInstance", "Order\u0000\"nobody\"");
    assert.strictEqual(msg, undefined);
  });

  it("says why when the inspection fails, and stops offering instances when the server stops", async function () {
    this.timeout(60_000);
    process.env.BYNK_FAKE_INSPECT = "none";
    try {
      await show();
      const l = await waitFor(live, (v) => (v?.problems.length ?? 0) > 0, "the failure to be reported", 30_000);
      assert.deepStrictEqual(l?.instances, []);
      assert.ok(l?.problems[0].includes("no running `bynk dev` session"), l?.problems[0]);
    } finally {
      delete process.env.BYNK_FAKE_INSPECT;
    }
    await vscode.commands.executeCommand("bynk.stopDevServer");
    await waitFor(live, (v) => v === undefined, "the listing to go with the session", 30_000);
  });
});
