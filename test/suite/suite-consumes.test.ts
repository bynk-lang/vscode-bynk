// #133 integration test: the expanded `suite consumes` snippets are canonical
// under `bynk fmt`. Runs in the extension host, where runTest.ts has put the
// pinned toolchain (`npm run fetch:toolchain` → .bynk-test-bin) on PATH. It
// fails, rather than skips, if `bynk` is not there, so CI cannot pass unchecked.

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const snippets = JSON.parse(
  fs.readFileSync(path.join(ROOT, "snippets/bynk.json"), "utf8"),
) as Record<string, { body: string[] }>;

const expand = (body: string[]): string =>
  body
    .join("\n")
    .replace(/\$\{\d+\|([^,|}]+)[^}]*\|\}/g, "$1")
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$0/g, "") + "\n";

function findBynk(): string | undefined {
  const exe = process.platform === "win32" ? "bynk.exe" : "bynk";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

describe("`suite consumes` snippets under `bynk fmt` (#133)", () => {
  for (const name of ["suite consumes", "suite as consumes"]) {
    it(`${name} expands to canonically formatted source`, () => {
      const bynk = findBynk();
      assert.ok(bynk, "`bynk` is not on PATH (npm run fetch:toolchain)");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-snip-"));
      try {
        const file = path.join(dir, "s.bynk");
        fs.writeFileSync(file, expand(snippets[name].body));
        const r = spawnSync(bynk, ["fmt", "--check", file], { encoding: "utf8" });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
