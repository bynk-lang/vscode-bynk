// #79 (bynk#2837): a reserved word names a field where it is a label (followed
// by `:`) and a member after `.` on the same line. The language server sends
// property/method tokens there; these rules give the TextMate grammar the same
// colours before semantic highlighting loads, or where it is off. As with
// doc-markdown-grammar.unit.test.ts there is no tokenizer harness, so this pins
// the rules' regexes and their place ahead of #keywords.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// out/test/suite -> the extension root.
const ROOT = path.resolve(__dirname, "../../..");

interface Rule {
  match?: string;
  name?: string;
  include?: string;
  patterns?: Rule[];
  captures?: Record<string, { name?: string }>;
}

const grammar = JSON.parse(
  fs.readFileSync(path.join(ROOT, "syntaxes/bynk.tmLanguage.json"), "utf8"),
) as { patterns: Rule[]; repository: Record<string, Rule> };
const repo = grammar.repository;

const labels = repo["keyword-labels"];
const members = repo["keyword-members"];
const [methodRule, fieldRule] = members?.patterns ?? [];

/** The words a `\b(a|b|…)\b` or `\bword\b` match with no guard colours wherever they occur. */
function unguardedWords(rule: Rule): string[] {
  return (rule.patterns ?? [rule]).flatMap((r) => {
    const m = /^\\b\(?([a-z|]+)\)?\\b$/.exec(r.match ?? "");
    return m ? m[1].split("|") : [];
  });
}

/** The words a rule's own alternation lists. */
function listed(rule: Rule | undefined): string[] {
  const m = /\(([a-z|]+)\)/.exec(rule?.match ?? "");
  return m ? m[1].split("|") : [];
}

/** The word a member rule scopes in `line`, if it matches. */
function member(rule: Rule | undefined, line: string): string | undefined {
  return new RegExp(rule?.match ?? "(?!)").exec(line)?.[2];
}

describe("keyword-named fields and methods", () => {
  it("defines both rules with the server's property and method scopes", () => {
    assert.strictEqual(labels?.name, "variable.other.property.bynk");
    assert.strictEqual(methodRule?.captures?.["2"]?.name, "entity.name.function.member.bynk");
    assert.strictEqual(fieldRule?.captures?.["2"]?.name, "variable.other.property.bynk");
  });

  it("tries both before #keywords, which would otherwise win at the same position", () => {
    const order = grammar.patterns.map((p) => p.include);
    const kw = order.indexOf("#keywords");
    assert.ok(kw >= 0);
    assert.ok(order.indexOf("#keyword-labels") >= 0 && order.indexOf("#keyword-labels") < kw);
    assert.ok(order.indexOf("#keyword-members") >= 0 && order.indexOf("#keyword-members") < kw);
  });

  it("covers every word #keywords and #constants colour without a guard", () => {
    const words = [...unguardedWords(repo["keywords"]), ...unguardedWords(repo["constants"])].filter(
      (w) => /^[a-z]/.test(w),
    );
    for (const w of ["type", "from", "true", "self"]) assert.ok(words.includes(w), `reads ${w}`);
    for (const rule of [labels, methodRule, fieldRule]) {
      const have = listed(rule);
      const missing = words.filter((w) => !have.includes(w));
      assert.deepStrictEqual(missing, [], `${rule?.match?.slice(0, 20)}… is missing ${missing.join(", ")}`);
    }
  });

  describe("labels", () => {
    const re = () => new RegExp(labels?.match ?? "(?!)", "g");
    const hits = (line: string) => [...line.matchAll(re())].map((m) => m[1]);

    for (const [line, want] of [
      ["type Account = { login: String, type: String }", ["type"]],
      ['let a = Account { type: "x" }', ["type"]],
      ["Account { type: t, .. } => t", ["type"]],
      ["| Push(from: String, to: String)", ["from"]],
      ["type Event = { type: String, from: Int, self: Bool, do: Option[String] }", ["type", "from", "self", "do"]],
      ['Refusal { code: "x", message: "y" }', ["message"]],
      ["Account { type : t }", ["type"]],
    ] as [string, string[]][]) {
      it(`colours ${JSON.stringify(line)}`, () => assert.deepStrictEqual(hits(line), want));
    }

    for (const line of [
      "type Account = { login: String }",
      "fn f(key: String, trace: String, advance: Int) -> Int",
      "store products: Map[Sku, Product]",
      "let x := from",
      "if ready { true } else { false }",
    ]) {
      it(`leaves ${JSON.stringify(line)}`, () => assert.deepStrictEqual(hits(line), []));
    }
  });

  describe("members", () => {
    for (const [line, word] of [
      ["fn Sorted.from(items: List[String]) -> Sorted", "from"],
      ["Sorted.from(xs).length()", "from"],
      ["Json.from[Event](raw)", "from"],
      ["let r <- sweeper.schedule(\"*/5 * * * *\", 1)", "schedule"],
      ["expect span.trace(Cap.op) == 1", "trace"],
    ]) {
      it(`colours ${JSON.stringify(line)} as a method`, () => {
        assert.strictEqual(member(methodRule, line), word);
      });
    }

    for (const [line, word] of [
      ['a.type == "Organization"', "type"],
      ["fn selfFlag(e: Event) -> Bool { e.self }", "self"],
      ["\\(r.message) at", "message"],
      ["let f = a. type", "type"],
    ]) {
      it(`colours ${JSON.stringify(line)} as a field`, () => {
        assert.strictEqual(member(methodRule, line), undefined);
        assert.strictEqual(member(fieldRule, line), word);
      });
    }

    for (const line of ["let x = { ...self, a: 1 }", "Account { a: t, ..type }", "a.typed", "a.fromList(xs)", "foo."]) {
      it(`leaves ${JSON.stringify(line)}`, () => {
        assert.strictEqual(member(methodRule, line), undefined);
        assert.strictEqual(member(fieldRule, line), undefined);
      });
    }
  });
});
