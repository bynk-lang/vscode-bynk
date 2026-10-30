// #44: the language server's start/restart/download paths, driven through their
// commands. The server is a shell wrapper that logs its pid and then `exec`s the
// real `bynkc-lsp` from PATH, so a test can count the server processes alive (the
// status bar text cannot be read back) and tell which copy the extension ran. The
// download is served by a stub `fetch`, so nothing leaves the machine. Needs a
// `bynkc-lsp` on PATH, which the harness provides; skipped without one.

import * as assert from "assert";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as vscode from "vscode";

import { serverAssetName, targetTriple } from "../../src/server";
import { alive } from "./fakeBynk";
import { present, truthy, waitFor } from "./util";

const EXT_ID = "bynk-lang.bynk-vscode";
const SHORT = 15_000;

interface Spawned {
  pid: number;
  /** `$0`: the path the extension launched. */
  path: string;
}

function findOnPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, bin);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

describe("Bynk server lifecycle (#44)", () => {
  const realFetch = globalThis.fetch;
  const window = vscode.window as unknown as { showErrorMessage: unknown };
  const realShowErrorMessage = window.showErrorMessage;
  let dir: string;
  let log: string;
  let wrapper: string;
  let wrapperBytes: Buffer;
  let doc: vscode.TextDocument;
  let pos: vscode.Position;
  let previous: string | undefined;
  let errors: string[];
  let cached: string[];
  /** The server the harness started at activation, before any wrapper. */
  let harness: number[];

  /** Every process the wrapper has started (the `--version` probe included). */
  const spawned = (): Spawned[] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [pid, ...rest] = l.split(" ");
            return { pid: Number(pid), path: rest.join(" ") };
          })
      : [];
  /** The servers running now. */
  const live = (): Spawned[] => spawned().filter((s) => alive(s.pid));

  const answers = async (): Promise<boolean> =>
    ((await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", doc.uri, pos)) ?? [])
      .length > 0;

  const setPath = (p: string | undefined) =>
    vscode.workspace.getConfiguration("bynk").update("executablePath", p, vscode.ConfigurationTarget.Global);

  /** Serve the release's checksum file and server asset from the wrapper. */
  const serveRelease = () => {
    const sums = `${createHash("sha256").update(wrapperBytes).digest("hex")}  ${serverAssetName(targetTriple()!)}\n`;
    (globalThis as { fetch: unknown }).fetch = async (url: string) =>
      new Response(url.endsWith("/SHA256SUMS") ? sums : new Uint8Array(wrapperBytes));
  };

  /** Wait for exactly one server, answering, and return it. */
  const settled = async (what: string): Promise<Spawned> => {
    const [only] = await waitFor(live, (l) => l.length === 1, `exactly one server ${what}`, SHORT);
    await waitFor(answers, truthy, `the server to answer ${what}`, SHORT);
    return only;
  };

  before(async function () {
    if (process.platform === "win32") this.skip();
    const real = findOnPath("bynkc-lsp");
    if (!real) this.skip();
    this.timeout(120_000);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-lsp-"));
    log = path.join(dir, "spawned.log");
    wrapperBytes = Buffer.from(`#!/bin/sh\necho "$$ $0" >> "${log}"\nexec "${real}" "$@"\n`);
    wrapper = path.join(dir, "bynkc-lsp");
    fs.writeFileSync(wrapper, wrapperBytes, { mode: 0o755 });

    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} is installed`);
    await ext.activate();
    const folder = vscode.workspace.workspaceFolders![0];
    doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "src/text.bynk"));
    await vscode.window.showTextDocument(doc);
    pos = doc.positionAt(doc.getText().indexOf("shout(name)") + 1);
    // The start-up server answers before the tests swap it.
    await waitFor(answers, truthy, "the initial server to answer", 60_000);
    harness = spawnSync("pgrep", ["-P", String(process.pid), "bynkc-lsp"], { encoding: "utf8" })
      .stdout.split("\n")
      .filter(Boolean)
      .map(Number);
    assert.ok(harness.length > 0, "the harness server is a child of the extension host");
    previous = vscode.workspace.getConfiguration("bynk").inspect<string>("executablePath")?.globalValue;
  });

  beforeEach(() => {
    errors = [];
    cached = [];
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
      return /no such executable/.test(message) ? "Download Server" : undefined;
    };
  });

  afterEach(async () => {
    window.showErrorMessage = realShowErrorMessage;
    (globalThis as { fetch: unknown }).fetch = realFetch;
    // The downloaded copy lives in the extension's global storage.
    for (const p of cached) {
      if (p.split(path.sep).includes("server")) fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  after(async function () {
    this.timeout(150_000);
    window.showErrorMessage = realShowErrorMessage;
    (globalThis as { fetch: unknown }).fetch = realFetch;
    if (!dir) return;
    // Back to the harness's server, which later tests rely on.
    await setPath(previous);
    await vscode.commands.executeCommand("bynk.restartServer");
    await waitFor(answers, truthy, "the harness server to answer again", 45_000);
    await waitFor(live, (l) => l.length === 0, "the wrapped servers to be gone", SHORT);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restartServer replaces the running server with exactly one", async function () {
    this.timeout(90_000);
    await setPath(wrapper);
    await vscode.commands.executeCommand("bynk.restartServer");
    const before = await settled("after the setting change");
    assert.strictEqual(before.path, wrapper);
    for (const pid of harness) {
      await waitFor(() => alive(pid), (a) => !a, "the harness server to exit once replaced", SHORT);
    }

    await vscode.commands.executeCommand("bynk.restartServer");
    const after = await settled("after a restart");
    assert.notStrictEqual(after.pid, before.pid, "the restart started a new server");
    await waitFor(() => alive(before.pid), (a) => !a, "the old server to exit", SHORT);
  });

  it("restarts issued together end with one server", async function () {
    this.timeout(90_000);
    await setPath(wrapper);
    await vscode.commands.executeCommand("bynk.restartServer");
    const before = await settled("before the restarts");
    await Promise.all([1, 2, 3].map(() => vscode.commands.executeCommand("bynk.restartServer")));
    const after = await settled("after three restarts");
    assert.notStrictEqual(after.pid, before.pid, "the restarts replaced the server");
  });

  it("a restart supersedes a download in flight", async function () {
    this.timeout(90_000);
    await setPath(wrapper);
    await vscode.commands.executeCommand("bynk.restartServer");
    const first = await settled("before the download");

    const fetched: string[] = [];
    let aborted = false;
    (globalThis as { fetch: unknown }).fetch = (url: string, init?: { signal?: AbortSignal }) => {
      fetched.push(url);
      return new Promise((_resolve, reject) => {
        const abort = () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort);
      });
    };
    const download = vscode.commands.executeCommand("bynk.downloadServer");
    await waitFor(() => fetched.length, truthy, "the download to start", SHORT);
    await vscode.commands.executeCommand("bynk.restartServer");
    await download;

    assert.ok(aborted, "the restart aborted the download");
    const after = await settled("after the restart");
    assert.strictEqual(after.path, wrapper, "the restart ran the configured server, not a download");
    assert.notStrictEqual(after.pid, first.pid);
    assert.deepStrictEqual(errors, [], "a superseded download is not reported as a failure");
  });

  it("downloadServer replaces the running server with the downloaded one", async function () {
    this.timeout(90_000);
    await setPath(wrapper);
    await vscode.commands.executeCommand("bynk.restartServer");
    await settled("before the download");

    serveRelease();
    await vscode.commands.executeCommand("bynk.downloadServer");
    const downloaded = await settled("after the download");
    cached.push(downloaded.path);
    assert.notStrictEqual(downloaded.path, wrapper);
    assert.ok(downloaded.path.split(path.sep).includes("server"), `ran the cached copy: ${downloaded.path}`);
    assert.deepStrictEqual(errors, []);
  });

  it("with the server missing, choosing Download Server ends with it running", async function () {
    this.timeout(90_000);
    serveRelease();
    // A setting that names nothing: the start offers "Download Server" and the
    // stub picks it.
    await setPath(path.join(dir, "missing", "bynkc-lsp"));
    const downloaded = await waitFor(
      () => live().find((s) => s.path !== wrapper),
      present,
      "the downloaded server to start",
      SHORT * 2,
    );
    cached.push(downloaded.path);
    await settled("after the download");
    assert.ok(errors.some((m) => /no such executable/.test(m)), `offered the download: ${errors.join("; ")}`);
    assert.ok(downloaded.path.split(path.sep).includes("server"), `ran the cached copy: ${downloaded.path}`);
  });
});
