// #44: the dev server's restart command and status-bar menu, and that none of
// them leaves a `bynk dev` process behind. The stand-in `bynk` (test/fixtures/
// fake-bynk) logs the pid of every run, so cleanup is checked by pid.

import * as assert from "assert";

import * as vscode from "vscode";

import { useFakeBynk } from "./fakeBynk";
import { present, waitFor } from "./util";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface FakeQuickPick {
  items: (vscode.QuickPickItem & { run?: () => unknown; url?: string })[];
  selectedItems: FakeQuickPick["items"];
  accept?: () => void;
  trigger?: (e: { item: FakeQuickPick["items"][number] }) => void;
  hidden: boolean;
}

describe("Bynk dev server restart and cleanup (#44)", function () {
  this.timeout(60_000);
  let fake: Awaited<ReturnType<typeof useFakeBynk>>;
  const window = vscode.window as unknown as { createQuickPick: unknown };
  const realCreateQuickPick = window.createQuickPick;
  let menus: FakeQuickPick[];

  const devRuns = () => fake.read().filter((e) => e.argv?.[0] === "dev");
  const devPids = () => [...new Set(devRuns().map((e) => e.pid!))];
  const running = () => devPids().filter(alive);
  const allGone = () => waitFor(running, (l) => l.length === 0, "every `bynk dev` process to exit", 20_000);
  const stop = () => vscode.commands.executeCommand("bynk.stopDevServer");

  /** Open the menu and return what it offered; its pick is made with `choose`. */
  const openMenu = async (): Promise<FakeQuickPick> => {
    await vscode.commands.executeCommand("bynk.devServerMenu");
    return menus[menus.length - 1];
  };
  const choose = (menu: FakeQuickPick, label: RegExp) => {
    const item = menu.items.find((i) => label.test(i.label));
    assert.ok(item, `the menu offers ${label}: ${menu.items.map((i) => i.label).join(" | ")}`);
    menu.selectedItems = [item];
    menu.accept!();
  };

  before(async () => {
    fake = await useFakeBynk();
  });

  beforeEach(() => {
    menus = [];
    // The menu is a `createQuickPick`, which has no stand-in helper; this one
    // records what it was given and lets the test accept an item.
    window.createQuickPick = () => {
      const qp: FakeQuickPick & Record<string, unknown> = {
        items: [],
        selectedItems: [],
        hidden: false,
        show: () => undefined,
        hide: () => void (qp.hidden = true),
        dispose: () => undefined,
        onDidAccept: (cb: () => void) => ((qp.accept = cb), { dispose: () => undefined }),
        onDidTriggerItemButton: (cb: FakeQuickPick["trigger"]) => ((qp.trigger = cb), { dispose: () => undefined }),
        onDidHide: () => ({ dispose: () => undefined }),
      };
      menus.push(qp);
      return qp;
    };
  });

  afterEach(async () => {
    window.createQuickPick = realCreateQuickPick;
    await stop();
  });

  after(async () => {
    await stop();
    await fake.restore();
  });

  it("restartDevServer replaces the session and leaves no process behind", async function () {
    if (process.platform === "win32") this.skip();
    await vscode.commands.executeCommand("bynk.startDevServer");
    await waitFor(devPids, (l) => l.length === 1, "the first `bynk dev`", 20_000);
    const [first] = devPids();

    await vscode.commands.executeCommand("bynk.restartDevServer");
    await waitFor(devPids, (l) => l.length === 2, "the restarted `bynk dev`", 20_000);
    const second = devPids().find((p) => p !== first)!;
    await waitFor(() => alive(first), (a) => !a, "the first `bynk dev` to exit", 20_000);
    assert.ok(alive(second), "the restarted `bynk dev` is running");
    const [a, b] = devRuns();
    assert.deepStrictEqual(b.argv, a.argv, "a restart runs the same command");

    await stop();
    await allGone();
  });

  it("devServerMenu starts a session, copies a context's URL, restarts and stops", async function () {
    if (process.platform === "win32") this.skip();
    const idle = await openMenu();
    assert.deepStrictEqual(
      idle.items.map((i) => i.label),
      ["$(play) Start Dev Server"],
    );
    choose(idle, /Start Dev Server/);
    await waitFor(devPids, (l) => l.length === 1, "the menu to start `bynk dev`", 20_000);
    const [first] = devPids();

    // The context's URL arrives with the `serving` event; reopen until it is there.
    const serving = await waitFor(
      async () => {
        const menu = await openMenu();
        return menu.items.some((i) => i.url) ? menu : undefined;
      },
      present,
      "the menu to list the served context",
      20_000,
    );
    const context = serving.items.find((i) => i.url)!;
    assert.match(context.url!, /^http:\/\/localhost:\d+$/);
    for (const label of [/Show Terminal/, /Show Logs/, /Restart Dev Server/, /Stop Dev Server/]) {
      assert.ok(
        serving.items.some((i) => label.test(i.label)),
        `a running session offers ${label}`,
      );
    }
    await vscode.env.clipboard.writeText("");
    serving.trigger!({ item: context });
    await waitFor(() => vscode.env.clipboard.readText(), (t) => t === context.url, "the URL on the clipboard", 10_000);

    choose(serving, /Restart Dev Server/);
    await waitFor(devPids, (l) => l.length === 2, "the menu to restart `bynk dev`", 20_000);
    await waitFor(() => alive(first), (a) => !a, "the first `bynk dev` to exit", 20_000);

    const again = await waitFor(
      async () => {
        const menu = await openMenu();
        return menu.items.some((i) => /Stop Dev Server/.test(i.label)) ? menu : undefined;
      },
      present,
      "the menu of the restarted session",
      20_000,
    );
    choose(again, /Stop Dev Server/);
    await allGone();
    assert.ok(devRuns().length >= 2);
    assert.ok(
      fake.read().filter((e) => e.signal === "SIGTERM").length >= 2,
      "each session was stopped with SIGTERM",
    );
  });
});
