// bynk v0.606.0 removed the `~>` send arrow (parse error
// `bynk.parse.removed_send_arrow`; `e.detach()` replaces it). As with the
// other grammar unit tests there is no tokenizer harness, so this pins the
// operator rule's regex.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// out/test/suite -> the extension root.
const ROOT = path.resolve(__dirname, "../../..");

interface Rule {
  match?: string;
  name?: string;
}

const grammar = JSON.parse(
  fs.readFileSync(path.join(ROOT, "syntaxes/bynk.tmLanguage.json"), "utf8"),
) as { repository: Record<string, { patterns?: Rule[] }> };

const operatorRule = (grammar.repository["operators"].patterns ?? []).find(
  (r) => r.name === "keyword.operator.bynk",
);
const opRe = () => new RegExp(operatorRule?.match ?? "(?!)", "g");

describe("removed `~>` send arrow", () => {
  it("is not listed in the operator rule", () => {
    assert.ok(operatorRule, "operator rule present");
    assert.ok(!(operatorRule.match ?? "").includes("~"), operatorRule.match ?? "");
  });

  it("does not match `~>` as one operator", () => {
    const tokens = [..."a ~> b".matchAll(opRe())].map((m) => m[0]);
    assert.ok(!tokens.includes("~>"), tokens.join(" "));
  });

  it("still matches the surviving arrows", () => {
    const tokens = [..."x -> y <- z => w".matchAll(opRe())].map((m) => m[0]);
    assert.deepStrictEqual(tokens, ["->", "<-", "=>"]);
  });
});
