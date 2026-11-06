// Unit coverage for the managed toolchain's cache (src/server.ts): the toolchain
// is the `bynk` driver alone (it compiles in-process, so there is no `bynkc`),
// and a failed verification must leave nothing behind.

import * as assert from "assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import type * as vscode from "vscode";

import {
  cachedToolPath,
  cachedToolchain,
  DownloadCancelled,
  downloadServer,
  downloadToolchain,
  targetTriple,
  toolAssetName,
} from "../../src/server";

const VERSION = "v0.0.1";

function fakeContext(storage: string): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: storage },
    extension: { packageJSON: { bynkServerVersion: VERSION, repository: { url: "https://github.com/bynk-lang/bynk" } } },
  } as unknown as vscode.ExtensionContext;
}

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

describe("managed toolchain cache", function () {
  const target = targetTriple();
  let dir: string;
  const realFetch = globalThis.fetch;

  beforeEach(function () {
    if (!target) this.skip();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-toolchain-"));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Serve `files` (asset name → bytes) plus a SHA256SUMS listing `sums`. */
  function serve(files: Record<string, string>, sums: Record<string, string>): void {
    globalThis.fetch = (async (url: string) => {
      const name = String(url).split("/").pop()!;
      const body =
        name === "SHA256SUMS"
          ? Object.entries(sums).map(([n, h]) => `${h}  ${n}`).join("\n")
          : files[name];
      return body === undefined
        ? new Response("", { status: 404, statusText: "Not Found" })
        : new Response(body);
    }) as typeof fetch;
  }

  const output = { appendLine() {} } as unknown as vscode.OutputChannel;

  it("needs only bynk cached", () => {
    const ctx = fakeContext(dir);
    assert.strictEqual(cachedToolchain(ctx), undefined);
    const bynk = cachedToolPath(ctx, VERSION, target!, "bynk");
    fs.mkdirSync(path.dirname(bynk), { recursive: true });
    fs.writeFileSync(bynk, "x");
    assert.strictEqual(cachedToolchain(ctx)?.bynk, bynk);
    assert.strictEqual(cachedToolchain(ctx)?.dir, path.dirname(bynk));
  });

  it("downloads bynk alone, never bynkc", async () => {
    const ctx = fakeContext(dir);
    const driver = toolAssetName("bynk", target!);
    const requested: string[] = [];
    serve({ [driver]: "driver" }, { [driver]: sha("driver") });
    const served = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requested.push(path.basename(String(url)));
      return served(url, init);
    }) as typeof fetch;
    const bynk = await downloadToolchain(ctx, output);
    assert.strictEqual(fs.readFileSync(bynk, "utf8"), "driver");
    assert.ok(cachedToolchain(ctx));
    assert.deepStrictEqual(requested.filter((n) => n !== "SHA256SUMS"), [driver]);
  });

  it("caches nothing when bynk fails verification", async () => {
    const ctx = fakeContext(dir);
    const driver = toolAssetName("bynk", target!);
    serve({ [driver]: "tampered" }, { [driver]: sha("driver") });
    await assert.rejects(downloadToolchain(ctx, output), /checksum mismatch/);
    assert.strictEqual(fs.existsSync(cachedToolPath(ctx, VERSION, target!, "bynk")), false);
    assert.strictEqual(cachedToolchain(ctx), undefined);
  });

  it("fails on a release that predates the toolchain assets", async () => {
    const ctx = fakeContext(dir);
    serve({}, {});
    await assert.rejects(downloadToolchain(ctx, output), /no entry for/);
  });

  it("does not fetch when the download is already cancelled", async () => {
    const ctx = fakeContext(dir);
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("");
    }) as typeof fetch;
    const cancel = new AbortController();
    cancel.abort();
    await assert.rejects(downloadServer(ctx, output, cancel.signal), DownloadCancelled);
    assert.strictEqual(fetched, 0);
  });
});
