// next-server-pin.sh moves the server pin and carries the extension's version
// with it.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./next-server-pin.sh", import.meta.url).pathname;

function run(version, pin, tag) {
  const file = join(mkdtempSync(join(tmpdir(), "pin-")), "package.json");
  writeFileSync(file, `{\n  "version": "${version}",\n  "bynkServerVersion": "${pin}"\n}\n`);
  const out = execFileSync("bash", [script, tag, file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  return { out: out.trim(), version: pkg.version, pin: pkg.bynkServerVersion };
}

test("a newer compiler release sets the extension to its version", () => {
  assert.deepStrictEqual(run("0.434.1", "v0.434.0", "v0.436.0"), { out: "move=true", version: "0.436.0", pin: "v0.436.0" });
});

test("an extension already at the release's version takes its next patch", () => {
  assert.deepStrictEqual(run("0.436.2", "v0.435.0", "v0.436.0"), { out: "move=true", version: "0.436.3", pin: "v0.436.0" });
});

test("a pin already at the release moves nothing", () => {
  assert.deepStrictEqual(run("0.436.1", "v0.436.0", "v0.436.0"), { out: "move=false", version: "0.436.1", pin: "v0.436.0" });
});

test("a pre-release moves nothing", () => {
  assert.strictEqual(run("0.436.0", "v0.436.0", "v0.437.0-rc1").out, "move=false");
});

test("the lockfile's root version follows", () => {
  const dir = mkdtempSync(join(tmpdir(), "pin-"));
  writeFileSync(join(dir, "package.json"), '{\n  "version": "0.434.1",\n  "bynkServerVersion": "v0.434.0"\n}\n');
  // The root's two versions sit in the first lines; a dependency's is further down.
  const lock = JSON.stringify(
    { name: "x", version: "0.434.1", lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: "0.434.1", license: "MIT", dependencies: {} }, "node_modules/y": { version: "0.434.1" } } },
    null,
    2,
  );
  writeFileSync(join(dir, "package-lock.json"), lock);
  execFileSync("bash", [script, "v0.436.0", join(dir, "package.json")], { stdio: "ignore" });
  const out = readFileSync(join(dir, "package-lock.json"), "utf8");
  assert.strictEqual(out.match(/0\.436\.0/g).length, 2);
  assert.match(out, /node_modules\/y": \{\n      "version": "0.434.1"/);
});
