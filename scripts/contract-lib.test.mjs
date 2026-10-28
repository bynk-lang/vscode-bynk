// node --test scripts/contract-lib.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  GOLDEN_FIXTURES,
  goldenMismatches,
  grammarPatterns,
  legendMismatches,
  parseSums,
  releaseTarget,
  missingKeywords,
  snippetSkeletons,
  stripSnippetPlaceholders,
  wholeWordPresent,
  wrapForParse,
} from "./contract-lib.mjs";

test("whole-word matching respects word boundaries", () => {
  assert.ok(wholeWordPresent('"match": "\\\\b(if|else)\\\\b"', "else"));
  assert.ok(!wholeWordPresent("elsewhere", "else"));
  assert.ok(!wholeWordPresent("my_else", "else"));
  assert.ok(wholeWordPresent("(a|else|b)", "else"));
});

test("a reserved keyword the grammar lacks is reported", () => {
  const contract = { reservedKeywords: ["if", "invariant"] };
  const grammar = (re) => ({ patterns: [{ name: "keyword.control", match: re }] });
  assert.deepEqual(missingKeywords(contract, grammar("\\b(if|else)\\b")), ["invariant"]);
  assert.deepEqual(missingKeywords(contract, grammar("\\b(if|invariant)\\b")), []);
});

test("only pattern regexes count, not keys or scope names", () => {
  const grammar = {
    repository: { x: { name: "keyword.control.invariant", patterns: [{ begin: "\\(", end: "\\)", match: "foo" }] } },
  };
  assert.equal(grammarPatterns(grammar), "\\(\n\\)\nfoo");
  assert.deepEqual(missingKeywords({ reservedKeywords: ["invariant", "match"] }, grammar), ["invariant", "match"]);
});

test("a regex word boundary is not part of the word", () => {
  const grammar = { match: "\\bself\\b" };
  assert.deepEqual(missingKeywords({ reservedKeywords: ["self"] }, grammar), []);
});

test("SHA256SUMS parses sha256sum output", () => {
  const h = "a".repeat(64);
  assert.deepEqual(parseSums(`${h}  bynkc-x86_64-unknown-linux-gnu\nnot a line\n${"b".repeat(64)}  SHA256SUMS\n`), {
    "bynkc-x86_64-unknown-linux-gnu": h,
    SHA256SUMS: "b".repeat(64),
  });
});

test("only published platform/arch pairs get a target", () => {
  assert.equal(releaseTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(releaseTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(releaseTarget("win32", "x64"), "x86_64-pc-windows-msvc.exe");
  assert.equal(releaseTarget("linux", "s390x"), undefined);
  assert.equal(releaseTarget("darwin", "ia32"), undefined);
});

const contract = {
  semanticTokens: { customTypes: ["agent", "actor"], customModifiers: ["refined"] },
};
const pkg = (types, mods) => ({
  contributes: {
    semanticTokenTypes: types.map((id) => ({ id })),
    semanticTokenModifiers: mods.map((id) => ({ id })),
  },
});

test("the legend check passes when package.json mirrors the server", () => {
  assert.deepEqual(legendMismatches(contract, pkg(["actor", "agent"], ["refined"])), []);
});

test("the legend check reports both directions", () => {
  const out = legendMismatches(contract, pkg(["agent", "stale"], ["refined"]));
  assert.equal(out.length, 2);
  assert.match(out.join("\n"), /emits `actor` but package\.json does not declare it/);
  assert.match(out.join("\n"), /declares `stale` but the server does not emit it/);
});

test("placeholders strip to a skeleton", () => {
  assert.equal(stripSnippetPlaceholders("context ${1:my.orders}\n\n$0"), "context my.orders\n\n");
  assert.equal(stripSnippetPlaceholders("x ${1|a,b,c|} y"), "x a y");
  // A bare tab stop closing an expression block becomes `()`; elsewhere, empty.
  assert.equal(stripSnippetPlaceholders("fn f() -> Unit {\n  $0\n}"), "fn f() -> Unit {\n  ()\n}");
  assert.equal(stripSnippetPlaceholders("fn f(${1}) {\n  $0\n}"), "fn f() {\n  \n}");
});

test("scaffolds are wrapped by kind", () => {
  assert.equal(wrapForParse("context", "context a"), "context a");
  assert.match(wrapForParse("type", "type T = Int"), /^context Scaffold\n\ntype T = Int\n$/);
  assert.match(wrapForParse("on http", "on http(x) {}"), /^context Scaffold\n\nservice Scaffold \{/);
  assert.match(wrapForParse("case", "x"), /^suite Scaffold \{\n/);
});

test("the real snippet catalogue yields a skeleton per snippet", () => {
  const snippets = JSON.parse(
    fs.readFileSync(new URL("../snippets/bynk.json", import.meta.url), "utf8"),
  );
  const skeletons = snippetSkeletons(snippets);
  assert.equal(skeletons.length, Object.keys(snippets).length);
  for (const [, source] of skeletons) assert.doesNotMatch(source, /\$\d|\$\{/);
});

test("golden fixtures: equal ones pass, whatever the key order", () => {
  const goldens = { doctor: { a: 1, b: [2] }, migrateStatus: { classes: [] } };
  const same = { doctor: { b: [2], a: 1 }, migrateStatus: { classes: [] } };
  assert.deepEqual(goldenMismatches({ goldens }, same), []);
});

test("golden fixtures: a differing copy names its file", () => {
  const goldens = { doctor: { a: 1 }, migrateStatus: { classes: [] } };
  const out = goldenMismatches({ goldens }, { doctor: { a: 2 }, migrateStatus: { classes: [] } });
  assert.equal(out.length, 1);
  assert.ok(out[0].includes(GOLDEN_FIXTURES.doctor));
});

test("golden fixtures: a missing key is reported, an older contract is skipped", () => {
  assert.match(goldenMismatches({ goldens: { doctor: {} } }, { doctor: {} }).join(), /no `goldens\.migrateStatus`/);
  assert.equal(goldenMismatches({}, {}), null);
});
