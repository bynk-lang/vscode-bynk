// Unit coverage for the version-comparison helpers in src/server.ts (#484:
// warn actionably when a stale `bynk-lsp` resolved from PATH is older than
// the extension's pinned target).

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import {
  classifyServerVersion,
  compareVersions,
  expectedServerVersion,
  isBelowMinVersion,
  parseVersion,
  serverAssetName,
  staleServerPrompt,
  tooOldServerPrompt,
  toolAssetName,
} from "../../src/server";

describe("parseVersion", () => {
  it("extracts MAJOR.MINOR.PATCH from a `--version` line", () => {
    assert.deepStrictEqual(parseVersion("bynk-lsp 0.510.2"), [0, 510, 2]);
    assert.deepStrictEqual(parseVersion("bynkc-lsp 0.129.0"), [0, 129, 0]);
  });

  it("extracts from a bare or `v`-prefixed version string", () => {
    assert.deepStrictEqual(parseVersion("v0.132.1"), [0, 132, 1]);
    assert.deepStrictEqual(parseVersion("0.132.1"), [0, 132, 1]);
  });

  it("returns undefined when no version pattern is present", () => {
    assert.strictEqual(parseVersion("not a version"), undefined);
    assert.strictEqual(parseVersion(""), undefined);
  });

  it("extracts the first match and ignores trailing text", () => {
    assert.deepStrictEqual(parseVersion("0.129.0-dev+adversarial"), [0, 129, 0]);
  });

  it("stays fast on a long dot-free digit run (no unbounded regex backtracking)", () => {
    const adversarial = "9".repeat(50_000);
    const start = Date.now();
    assert.strictEqual(parseVersion(adversarial), undefined);
    assert.ok(Date.now() - start < 500, "parseVersion must run in linear time");
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    assert.strictEqual(compareVersions([0, 129, 0], [0, 132, 1]), -1);
    assert.strictEqual(compareVersions([0, 132, 1], [0, 129, 0]), 1);
    assert.strictEqual(compareVersions([1, 0, 0], [0, 999, 999]), 1);
    assert.strictEqual(compareVersions([0, 132, 0], [0, 132, 1]), -1);
  });

  it("returns 0 for equal versions", () => {
    assert.strictEqual(compareVersions([0, 132, 1], [0, 132, 1]), 0);
  });
});

describe("expectedServerVersion", () => {
  it("holds every server to the pin, the bynk release the extension was built against", () => {
    assert.strictEqual(expectedServerVersion("v0.639.1"), "0.639.1");
    assert.strictEqual(expectedServerVersion("0.639.1"), "0.639.1");
  });

  it("does not depend on the extension's own version, which runs ahead of the pin", () => {
    // Extension 0.639.3 is built against bynk v0.639.1: a bynk-lsp 0.639.1 matches.
    assert.strictEqual(classifyServerVersion("bynk-lsp 0.639.1", expectedServerVersion("v0.639.1")), "match");
  });
});

describe("classifyServerVersion", () => {
  it("matches the same version, whatever the binary's name", () => {
    assert.strictEqual(classifyServerVersion("bynk-lsp 0.639.1", "0.639.1"), "match");
    assert.strictEqual(classifyServerVersion("bynkc-lsp 0.639.1", "0.639.1"), "match");
  });

  it("compares parsed versions, so 0.639.10 is not 0.639.1", () => {
    assert.strictEqual(classifyServerVersion("bynk-lsp 0.639.10", "0.639.1"), "newer");
  });

  it("tells an older server from a newer one", () => {
    assert.strictEqual(classifyServerVersion("bynk-lsp 0.639.0", "0.639.1"), "older");
    assert.strictEqual(classifyServerVersion("bynk-lsp 0.614.0", "0.639.1"), "older");
    assert.strictEqual(classifyServerVersion("bynk-lsp 0.640.0", "0.639.1"), "newer");
  });

  it("is unknown for an unreadable version, unless the expected text is there", () => {
    assert.strictEqual(classifyServerVersion("bynk-lsp dev", "0.639.1"), "unknown");
    assert.strictEqual(classifyServerVersion("", "0.639.1"), "unknown");
    assert.strictEqual(classifyServerVersion("bynk-lsp dev build", "dev"), "match");
  });
});

describe("staleServerPrompt", () => {
  it("points a setting at the setting", () => {
    const p = staleServerPrompt("setting", "/opt/bynk-lsp", "bynk-lsp 0.639.0", "0.639.1");
    assert.strictEqual(p.action, "Open Settings");
    assert.ok(p.message.includes("bynk.executablePath"), p.message);
  });

  it("names a PATH binary instead of offering a download it would override", () => {
    const p = staleServerPrompt("path", "/usr/local/bin/bynk-lsp", "bynk-lsp 0.639.0", "0.639.1");
    assert.strictEqual(p.action, undefined);
    assert.ok(p.message.includes("/usr/local/bin/bynk-lsp"), p.message);
    assert.ok(p.message.includes("takes precedence"), p.message);
  });

  it("offers the download for a cached or downloaded server", () => {
    assert.strictEqual(staleServerPrompt("cached", "/c/bynk-lsp", "bynk-lsp 0.639.0", "0.639.1").action, "Download Matching Server");
    assert.strictEqual(staleServerPrompt("downloaded", "/c/bynk-lsp", "bynk-lsp 0.639.0", "0.639.1").action, "Download Matching Server");
  });
});

describe("toolAssetName", () => {
  it("names the raw per-platform binary assets release.yml publishes", () => {
    assert.strictEqual(toolAssetName("bynk", "x86_64-unknown-linux-gnu"), "bynk-x86_64-unknown-linux-gnu");
    assert.strictEqual(toolAssetName("bynk-lsp", "aarch64-apple-darwin"), "bynk-lsp-aarch64-apple-darwin");
    assert.strictEqual(toolAssetName("bynk", "x86_64-pc-windows-msvc"), "bynk-x86_64-pc-windows-msvc.exe");
  });

  it("keeps the server's asset name unchanged", () => {
    assert.strictEqual(serverAssetName("x86_64-unknown-linux-gnu"), "bynk-lsp-x86_64-unknown-linux-gnu");
    assert.strictEqual(serverAssetName("x86_64-pc-windows-msvc"), "bynk-lsp-x86_64-pc-windows-msvc.exe");
  });
});

describe("isBelowMinVersion", () => {
  it("is true only for a server older than the minimum", () => {
    assert.strictEqual(isBelowMinVersion("bynkc-lsp 0.433.9", "v0.434.0"), true);
    assert.strictEqual(isBelowMinVersion("bynkc-lsp 0.434.0", "v0.434.0"), false);
    assert.strictEqual(isBelowMinVersion("bynkc-lsp 0.500.1", "v0.434.0"), false);
    assert.strictEqual(isBelowMinVersion("bynkc-lsp 0.99.0", "v0.434.0"), true);
  });

  it("does not flag a version it cannot read", () => {
    assert.strictEqual(isBelowMinVersion("", "v0.434.0"), false);
    assert.strictEqual(isBelowMinVersion("bynkc-lsp dev", "v0.434.0"), false);
    assert.strictEqual(isBelowMinVersion("bynkc-lsp 0.1.0", "not a version"), false);
  });
});

describe("the manifest's server versions", () => {
  // bynkServerMinVersion is moved by hand; the pin by the release workflow. The
  // pin is what a download fetches, so it must never fall below the minimum, or
  // "Download Matching Server" would offer a server the extension rejects.
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"),
  );

  it("declares both, as release tags", () => {
    assert.match(pkg.bynkServerVersion, /^v\d+\.\d+\.\d+$/);
    assert.match(pkg.bynkServerMinVersion, /^v\d+\.\d+\.\d+$/);
  });

  it("keeps the minimum at or below the pin", () => {
    assert.strictEqual(
      isBelowMinVersion(pkg.bynkServerVersion, pkg.bynkServerMinVersion),
      false,
    );
  });
});

describe("tooOldServerPrompt", () => {
  const prompt = (source: Parameters<typeof tooOldServerPrompt>[0]) =>
    tooOldServerPrompt(source, "/usr/bin/bynkc-lsp", "bynkc-lsp 0.1.0", "v0.434.0");

  it("sends a setting-pinned server to the setting", () => {
    assert.strictEqual(prompt("setting").action, "Open Settings");
  });

  it("names a PATH server, which a download would not displace", () => {
    const p = prompt("path");
    assert.strictEqual(p.action, undefined);
    assert.ok(p.message.includes("/usr/bin/bynkc-lsp"));
    // An old server keeps its old name, so the message names the binary it found.
    assert.ok(p.message.includes("that `bynkc-lsp`"), p.message);
  });

  it("offers a download for a provisioned server", () => {
    assert.strictEqual(prompt("downloaded").action, "Download Matching Server");
    assert.strictEqual(prompt("cached").action, "Download Matching Server");
  });

  it("states the version it needs", () => {
    assert.ok(prompt("path").message.includes("v0.434.0"));
  });
});
