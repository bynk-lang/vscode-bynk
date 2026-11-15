// #133: the `suite consumes` snippets, and `consumes` inside a suite.
// Expands each snippet with its placeholder defaults, then (when the pinned
// toolchain is staged in .bynk-test-bin) checks `bynk fmt --check` accepts it.

import * as assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const snippets = JSON.parse(
  fs.readFileSync(path.join(ROOT, "snippets/bynk.json"), "utf8"),
) as Record<string, { body: string[] }>;
const grammar = fs.readFileSync(
  path.join(ROOT, "syntaxes/bynk.tmLanguage.json"),
  "utf8",
);

/** Expand a snippet body to its default text: `${n:x}` → x, `${n|a,b|}` → a, `$0` → "". */
const expand = (body: string[]): string =>
  body
    .join("\n")
    .replace(/\$\{\d+\|([^,|}]+)[^}]*\|\}/g, "$1")
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$0/g, "") + "\n";

const exe = process.platform === "win32" ? ".exe" : "";
const bynk = path.join(ROOT, ".bynk-test-bin", `bynk${exe}`);

describe("`suite consumes` snippets (#133)", () => {
  for (const name of ["suite consumes", "suite as consumes"]) {
    describe(name, () => {
      const text = expand(snippets[name]?.body ?? []);

      it("puts `consumes` after the header and before the first case", () => {
        const lines = text.split("\n");
        const c = lines.findIndex((l) => l.startsWith("consumes "));
        const k = lines.findIndex((l) => l.startsWith("case "));
        assert.ok(c > 0 && k > c, text);
      });

      it("is unchanged by `bynk fmt`", function () {
        if (!fs.existsSync(bynk)) return this.skip();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-snip-"));
        const file = path.join(dir, "s.bynk");
        fs.writeFileSync(file, text);
        const r = spawnSync(bynk, ["fmt", "--check", file], {
          encoding: "utf8",
        });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      });
    });
  }

  it("the grammar's keyword list covers `consumes` (highlighted in a suite)", () => {
    assert.match(grammar, /\|uses\|consumes\|/);
  });
});
