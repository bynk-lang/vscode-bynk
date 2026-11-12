// bynk#3240: `by` is a CONTEXTUAL keyword — a clause word only in its clause
// positions, an ordinary name elsewhere. As with keyword-names-grammar.unit.test.ts
// there is no tokenizer harness, so this pins the rules' regexes.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// out/test/suite -> the extension root.
const ROOT = path.resolve(__dirname, "../../..");

interface Rule {
  match?: string;
  name?: string;
  patterns?: Rule[];
  captures?: Record<string, { name?: string }>;
}

const grammar = JSON.parse(
  fs.readFileSync(path.join(ROOT, "syntaxes/bynk.tmLanguage.json"), "utf8"),
) as { repository: Record<string, Rule> };
const keywords = grammar.repository["keywords"].patterns ?? [];

const byRule = keywords.find((r) => r.match?.startsWith("\\bby\\b"));
const advanceRule = keywords.find((r) => r.match?.includes("(advance)"));

const byRe = () => new RegExp(byRule?.match ?? "(?!)", "g");
const byHits = (line: string) => [...line.matchAll(byRe())].length;

/** Every regex in the grammar, to prove `by` is no longer listed unconditionally. */
const allMatches: string[] = [];
(function walk(v: unknown): void {
  if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "match" && typeof x === "string") allMatches.push(x);
      else walk(x);
    }
  }
})(grammar);

describe("`by` as a contextual keyword", () => {
  it("is no longer in any unconditional word list", () => {
    const listed = allMatches.filter((m) => m !== advanceRule?.match && /[(|]by[|)]/.test(m));
    assert.deepStrictEqual(listed, []);
  });

  it("scopes the contextual rule as a keyword", () => {
    assert.strictEqual(byRule?.name, "keyword.control.bynk");
  });

  describe("is not a keyword as a name", () => {
    for (const line of [
      "fn bump(by: Int) -> Int",
      "let by = 2",
      "let r = { by: 2 }",
      "x.by",
      "x.by + 1",
      "(by) -> by + 1",
    ]) {
      it(line, () => assert.strictEqual(byHits(line), 0));
    }
  });

  describe("is a keyword in its clause positions", () => {
    for (const line of [
      "on call add(n: Int) by Admin",
      "on call add(n: Int) by u: User",
      "let r = f() by Admin(1)",
    ]) {
      it(line, () => assert.strictEqual(byHits(line), 1));
    }
  });

  describe("advance Clock by", () => {
    const re = () => new RegExp(advanceRule?.match ?? "(?!)");
    it("colours advance, the capability and by", () => {
      const m = re().exec("advance Clock by 5.minutes");
      assert.ok(m, "matches");
      assert.deepStrictEqual(
        [1, 2, 3].map((i) => advanceRule?.captures?.[String(i)]?.name),
        ["keyword.control.bynk", "entity.name.type.bynk", "keyword.control.bynk"],
      );
      assert.deepStrictEqual([m[1], m[2], m[3]], ["advance", "Clock", "by"]);
    });
    it("leaves an ordinary `advance` alone", () => {
      assert.strictEqual(re().test("advance(by: 2)"), false);
    });
    it("comes before the contextual `by` rule", () => {
      assert.ok(keywords.indexOf(advanceRule as Rule) < keywords.indexOf(byRule as Rule));
    });
  });

  it("lists DecodeError, and still JsonError, as built-in types", () => {
    const rule = JSON.stringify(grammar);
    assert.ok(/\|ValidationError\|DecodeError\|JsonError\|/.test(rule));
  });
});
