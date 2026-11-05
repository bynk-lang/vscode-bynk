// #90 (bynk#2958): a multi-line string may carry a language tag (`"""sql`).
// A known tag embeds that language's grammar in the body; `\(…)` stays Bynk
// in the non-raw form; an unknown tag is a plain string. As with
// keyword-names-grammar.unit.test.ts there is no tokenizer harness, so this
// pins the rules' regexes, scopes, order and the package.json mapping.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// out/test/suite -> the extension root.
const ROOT = path.resolve(__dirname, "../../..");

interface Rule {
  begin?: string;
  comment?: string;
  name?: string;
  include?: string;
  contentName?: string;
  patterns?: Rule[];
  beginCaptures?: Record<string, { name?: string }>;
}

const grammar = JSON.parse(
  fs.readFileSync(path.join(ROOT, "syntaxes/bynk.tmLanguage.json"), "utf8"),
) as { repository: Record<string, Rule> };
const strings = grammar.repository["strings"]?.patterns ?? [];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  contributes: { grammars: { scopeName: string; embeddedLanguages?: Record<string, string> }[] };
};

const TAGS: Record<string, { grammar: string; language: string }> = {
  sql: { grammar: "source.sql", language: "sql" },
  json: { grammar: "source.json", language: "json" },
  html: { grammar: "text.html.basic", language: "html" },
  css: { grammar: "source.css", language: "css" },
  js: { grammar: "source.js", language: "javascript" },
};
const TAG_SCOPE = "entity.other.attribute-name.language-tag.bynk";

function tagged(tag: string, raw: boolean): Rule | undefined {
  return strings.find(
    (r) => r.contentName === `meta.embedded.block.${tag}` && (r.begin ?? "").startsWith("\\br") === raw,
  );
}

const untaggedRaw = strings.findIndex((r) => r.name === "string.quoted.triple.raw.bynk");
const untagged = strings.findIndex((r) => r.name === "string.quoted.triple.bynk");

describe("tagged multi-line strings", () => {
  for (const [tag, { grammar: embedded }] of Object.entries(TAGS)) {
    for (const raw of [true, false]) {
      const form = raw ? `r"""${tag}` : `"""${tag}`;
      it(`embeds ${embedded} in a ${form} body`, () => {
        const rule = tagged(tag, raw);
        assert.ok(rule, `${form} has a rule`);
        const begin = new RegExp(rule.begin!);
        assert.ok(begin.test(`let q = ${form}`), `${form} opens it`);
        assert.ok(begin.test(`${form}  \t`), "trailing blanks are allowed");
        assert.ok(!begin.test(`${form}x`), "a longer tag does not");
        assert.strictEqual(rule.beginCaptures?.["2"]?.name, TAG_SCOPE);
        const includes = (rule.patterns ?? []).map((p) => p.include);
        assert.deepStrictEqual(
          includes,
          raw ? [embedded] : ["#string-escape", "#interpolation", embedded],
          "the non-raw form keeps escapes and \\(…) as Bynk, ahead of the embedded grammar",
        );
        assert.ok(strings.indexOf(rule) < Math.min(untaggedRaw, untagged), "tried before the untagged rules");
      });
    }
  }

  it("scopes an unknown tag as a tag on a plain string", () => {
    for (const i of [untaggedRaw, untagged]) {
      const rule = strings[i];
      const m = new RegExp(rule.begin!).exec(`${i === untaggedRaw ? "r" : ""}"""graphql`);
      assert.strictEqual(m?.[1], "graphql");
      assert.strictEqual(rule.beginCaptures?.["1"]?.name, TAG_SCOPE);
      assert.ok(!rule.contentName, "the body stays a plain string");
    }
    assert.ok(untaggedRaw < untagged, 'r""" is tried before """');
  });

  it("maps each embedded scope to its language in package.json", () => {
    const bynk = pkg.contributes.grammars.find((g) => g.scopeName === "source.bynk");
    assert.deepStrictEqual(
      bynk?.embeddedLanguages,
      Object.fromEntries(Object.entries(TAGS).map(([t, { language }]) => [`meta.embedded.block.${t}`, language])),
    );
  });

  it("says the site grammar is a copy that changes with this one", () => {
    assert.match(String(grammar.repository["strings"]?.comment), /change both together/);
  });
});
