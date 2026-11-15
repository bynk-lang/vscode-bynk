// #133: the `suite consumes` snippets, and `consumes` inside a suite. Pure
// checks only; the `bynk fmt` round trip is the integration test
// suite-consumes.test.ts, where the pinned toolchain is staged.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const snippets = JSON.parse(
  fs.readFileSync(path.join(ROOT, "snippets/bynk.json"), "utf8"),
) as Record<string, { body: string[] }>;

interface Rule {
  match?: string;
  name?: string;
}
const grammar = JSON.parse(
  fs.readFileSync(path.join(ROOT, "syntaxes/bynk.tmLanguage.json"), "utf8"),
) as { repository: Record<string, { patterns?: Rule[] }> };
const keywords = grammar.repository["keywords"].patterns ?? [];

/** Expand a snippet body to its default text: `${n:x}` → x, `${n|a,b|}` → a, `$0` → "". */
const expand = (body: string[]): string =>
  body
    .join("\n")
    .replace(/\$\{\d+\|([^,|}]+)[^}]*\|\}/g, "$1")
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$0/g, "") + "\n";

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

      it("defaults to a real standard-library name", () => {
        assert.match(text, /^consumes bynk \{ Claim \}$/m);
      });
    });
  }
});

describe("`consumes` in a suite is highlighted (#133)", () => {
  const rule = keywords.find((r) => r.match?.includes("|consumes|"));
  const hits = (line: string): string[] =>
    [...line.matchAll(new RegExp(rule?.match ?? "(?!)", "g"))].map((m) => m[0]);

  it("scopes `consumes` as a declaration keyword", () => {
    assert.strictEqual(rule?.name, "keyword.declaration.bynk");
  });

  for (const line of [
    "consumes bynk.cloudflare { D1 }",
    "consumes bynk { Claim }",
  ]) {
    it(`matches \`consumes\` in \`${line}\``, () => {
      assert.deepStrictEqual(hits(line), ["consumes"]);
    });
  }

  it("does not match a name that merely contains it", () => {
    assert.deepStrictEqual(hits("let consumesAll = 1"), []);
  });
});
