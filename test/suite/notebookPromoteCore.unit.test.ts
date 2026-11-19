// #210: promote a notebook cell to a test case: the cell-to-case translation
// (stubs, preamble, expects, narrative to doc comment, output to offered
// assertions) and adding a case to a suite without disturbing it.

import * as assert from "assert";

import {
  caseNames,
  docComment,
  findSuite,
  insertCases,
  mergeConsumes,
  narrativeAbove,
  nearestHeading,
  newSuite,
  planCase,
  planSuite,
  renderCase,
  suggestName,
  suiteFileName,
  suiteHeading,
  uniqueName,
  unitsOf,
  type CasePlan,
  type CellOutput,
  type PromoteCell,
} from "../../src/notebookPromoteCore";

const md = (source: string): PromoteCell => ({ kind: "markdown", source, unit: undefined });
const code = (source: string, output?: CellOutput, unit: string | undefined = "shop.money"): PromoteCell => ({ kind: "code", source, unit, output });

function plan(cells: PromoteCell[], index: number, unit = "shop.money"): CasePlan {
  const p = planCase(cells, index, unit);
  assert.ok(p.ok, p.ok ? "" : p.reason);
  return p.plan;
}

const all = (p: CasePlan): Set<string> => new Set(p.offers.map((o) => o.id));

describe("promote: names and narrative (#210)", () => {
  const cells = [md("# Discounts\n\nHow a percentage comes off."), code("discount(2000, 25)"), md("## Edge cases"), md("A zero percentage changes nothing."), code("discount(2000, 0)")];
  it("takes the notebook's first heading as the suite's", () => {
    assert.strictEqual(suiteHeading(cells), "Discounts");
    assert.strictEqual(suiteHeading([code("1")]), undefined);
  });
  it("names a case for the nearest heading above it, else its first line", () => {
    assert.strictEqual(nearestHeading(cells, 4), "Edge cases");
    assert.strictEqual(suggestName(cells, 1), "Discounts");
    assert.strictEqual(suggestName([code("// @handler\n\nlet r <- api.GET(\"/x\") by Visitor")], 0), 'let r <- api.GET("/x") by Visitor');
    assert.strictEqual(suggestName([code("")], 0), "cell 1");
  });
  it("takes the Markdown cells directly above a cell, back to the previous code cell, as its narrative", () => {
    assert.strictEqual(narrativeAbove(cells, 1), "# Discounts\n\nHow a percentage comes off.");
    assert.strictEqual(narrativeAbove(cells, 4), "## Edge cases\n\nA zero percentage changes nothing.");
    assert.strictEqual(narrativeAbove(cells, 0), "");
  });
  it("writes a doc comment: `--- text` for one line, a block for more, and never a rule that would end it", () => {
    assert.deepStrictEqual(docComment("One line.", "\t"), ["\t--- One line."]);
    assert.deepStrictEqual(docComment("# Title\n\nBody\n---\nmore", ""), ["---", "# Title", "", "Body", "___", "more", "---"]);
    assert.deepStrictEqual(docComment("  \n", ""), []);
  });
  it("does not repeat the heading a case is named for in its doc comment", () => {
    const p = plan([md("## Edge cases"), code("1")], 1);
    assert.strictEqual(p.name, "Edge cases");
    assert.strictEqual(p.doc, "");
    assert.strictEqual(plan([md("## Edge cases\n\nZero changes nothing."), code("1")], 1).doc, "Zero changes nothing.");
  });
  it("leaves the notebook's title to the suite's doc comment, and the blank lines tidy", () => {
    const p = plan([md("# Money"), md("## Edge cases"), md("Zero changes nothing."), code("1")], 3);
    assert.strictEqual(p.doc, "Zero changes nothing.");
  });
  it("keeps case names unique within the suite", () => {
    assert.strictEqual(uniqueName("a", new Set(["a", "a (2)"])), "a (3)");
    assert.strictEqual(uniqueName("b", new Set(["a"])), "b");
  });
});

describe("promote: a cell as a case (#210)", () => {
  it("carries an expression's value as an offer, bound to `result` only when one is ticked", () => {
    const cells = [code("discount(2000, 25)", { kind: "value", value: 1500, type: "Int" })];
    const p = plan(cells, 0);
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect result == 1500"]);
    assert.strictEqual(renderCase(p, "discounts", new Set()), '\tcase "discounts" {\n\t\tdiscount(2000, 25)\n\t}');
    assert.strictEqual(renderCase(p, "discounts", all(p)), '\tcase "discounts" {\n\t\tlet result = discount(2000, 25)\n\t\texpect result == 1500\n\t}');
  });
  it("writes the earlier `let`s the cell uses, and not the others", () => {
    const cells = [code("let price = 2000\nlet unused = 7", { kind: "value", value: null, type: "()" }), code("let pct = 25", { kind: "value", value: null, type: "()" }), code("discount(price, pct)", { kind: "value", value: 1500, type: "Int" })];
    const p = plan(cells, 2);
    assert.deepStrictEqual(p.usedCells, [0, 1]);
    const text = renderCase(p, "c", all(p));
    assert.ok(text.includes("let price = 2000"), text);
    assert.ok(text.includes("let pct = 25"), text);
    assert.ok(!text.includes("unused"), text);
    assert.ok(text.indexOf("let price") < text.indexOf("let result = discount"), text);
  });
  it("follows a binding through a later `let` it feeds", () => {
    const cells = [code("let base = 10"), code("let double = base * 2"), code("double + 1", { kind: "value", value: 21, type: "Int" })];
    assert.deepStrictEqual(plan(cells, 2).usedCells, [0, 1]);
  });
  it("does not take another unit's `let`s", () => {
    const cells = [code("let x = 1", undefined, "other.unit"), code("x", { kind: "value", value: 1, type: "Int" })];
    assert.deepStrictEqual(plan(cells, 1).usedCells, []);
  });
  it("sends `stub`s to the case and `consumes` to the suite, each once, the last stub for a target winning", () => {
    const cells = [
      code("consumes bynk { Claim }\nstub Rates.lookup(_) returns 1.0\nlet rate = Rates.lookup(\"GBP\")"),
      code("consumes bynk { Claim }\nstub Rates.lookup(_) returns 2.0\nstub Kv.get(_) fails\nrate", { kind: "value", value: 2, type: "Float" }),
    ];
    const p = plan(cells, 1);
    assert.deepStrictEqual(p.consumes, ["consumes bynk { Claim }"]);
    assert.deepStrictEqual(p.stubs, ["stub Rates.lookup(_) returns 2.0", "stub Kv.get(_) fails"]);
    const text = renderCase(p, "c", new Set());
    assert.ok(text.indexOf("stub Rates") < text.indexOf("let rate"), text);
    assert.ok(!text.includes("consumes"), text);
  });
  it("keeps the cell's own `expect`s, and offers nothing from the output", () => {
    const cells = [code("let n = discount(2000, 25)\nexpect n == 1500", { kind: "value", value: null, type: "()" })];
    const p = plan(cells, 0);
    assert.strictEqual(p.hasExpect, true);
    assert.deepStrictEqual(p.offers, []);
    const text = renderCase(p, "c", new Set());
    assert.ok(text.includes("expect n == 1500"), text);
    assert.ok(text.includes("// Not carried: it has `expect` lines of its own"), text);
  });
  it("offers nothing for a cell that has not run, and says so", () => {
    const p = plan([code("discount(2000, 25)")], 0);
    assert.deepStrictEqual(p.offers, []);
    assert.ok(p.notCarried.some((n) => /has not run/.test(n)));
  });
  it("offers a record's fields once each, a variant's `is`, a list's equality, and not a named type's value", () => {
    const rec = plan([code("line()", { kind: "value", value: { name: "tea", qty: 2, tags: ["a"], price: { cents: 5 } }, type: "Line" })], 0);
    assert.deepStrictEqual(rec.offers.map((o) => o.line), ['expect result.name == "tea"', "expect result.price.cents == 5", "expect result.qty == 2"]);
    assert.ok(rec.notCarried.some((n) => /result\.tags/.test(n)));
    assert.deepStrictEqual(plan([code("f()", { kind: "value", value: { kind: "Ok", value: 3 }, type: "Result[Int, String]" })], 0).offers.map((o) => o.line), ["expect result is Ok(_)"]);
    assert.deepStrictEqual(plan([code("f()", { kind: "value", value: { kind: "None" }, type: "Option[Int]" })], 0).offers.map((o) => o.line), ["expect result is None"]);
    assert.deepStrictEqual(plan([code("f()", { kind: "value", value: [1, 2, 3], type: "List[Int]" })], 0).offers.map((o) => o.line), ["expect result == [1, 2, 3]"]);
    const named = plan([code("Percent.unsafe(5)", { kind: "value", value: 5, type: "Percent" })], 0);
    assert.deepStrictEqual(named.offers, []);
    assert.ok(named.notCarried.some((n) => /Percent/.test(n)));
  });
  it("writes a Float's whole number as a float literal", () => {
    assert.deepStrictEqual(plan([code("2.0", { kind: "value", value: 2, type: "Float" })], 0).offers.map((o) => o.line), ["expect result == 2.0"]);
  });
  it("never offers two equalities on one expression (bynk-lang/bynk#3775)", () => {
    const p = plan([code("line()", { kind: "value", value: { a: { b: 1 }, c: 2 }, type: "Line" })], 0);
    const targets = p.offers.map((o) => o.line.split(" == ")[0]);
    assert.strictEqual(new Set(targets).size, targets.length);
  });
  it("does not bind the value of a cell that ends in a `let`", () => {
    const p = plan([code("let x = 5", { kind: "value", value: 5, type: "Int" })], 0);
    assert.strictEqual(p.bind, undefined);
    assert.deepStrictEqual(p.offers, []);
  });
  it("refuses a cell with only headers, and a bad directive", () => {
    assert.strictEqual(planCase([code("stub A.b(_) returns 1")], 0, "shop.money").ok, false);
    assert.strictEqual(planCase([code("// @refined percent\n5")], 0, "shop.money").ok, false);
  });
});

describe("promote: a handler cell as a case (#210)", () => {
  const response = (variant: string, payload?: unknown): CellOutput => ({ kind: "response", response: { variant, status: variant === "Created" ? 201 : 204, hasPayload: payload !== undefined, payload } });
  it("binds a bare call, drops the directive, and offers the variant and the payload's fields", () => {
    const cells = [code('// @handler\nstub Mailer.send(_) returns true\napi.POST("/todos", Todo { title: "buy milk", done: false }) by Visitor', response("Created", { title: "buy milk", done: false }))];
    const p = plan(cells, 0);
    assert.deepStrictEqual(p.stubs, ["stub Mailer.send(_) returns true"]);
    assert.strictEqual(p.names.response, "response");
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect response is Created(_)", "expect payload.done == false", "expect payload.title == \"buy milk\""]);
    const text = renderCase(p, "creating", all(p));
    assert.strictEqual(
      text,
      [
        '\tcase "creating" {',
        "\t\tstub Mailer.send(_) returns true",
        '\t\tlet response <- api.POST("/todos", Todo { title: "buy milk", done: false }) by Visitor',
        "\t\texpect response is Created(_)",
        "\t\tmatch response {",
        "\t\t\tCreated(payload) => {",
        "\t\t\t\texpect payload.done == false",
        '\t\t\t\texpect payload.title == "buy milk"',
        "\t\t\t},",
        "\t\t\t_ => expect false,",
        "\t\t}",
        "\t}",
      ].join("\n"),
    );
    assert.ok(!text.includes("@handler"));
  });
  it("asserts only what was ticked: an unticked cell is the bound call alone", () => {
    const cells = [code('// @handler\nlet r <- api.DELETE("/items/:id", "a") by Visitor', response("NoContent"))];
    const p = plan(cells, 0);
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect r is NoContent"]);
    assert.strictEqual(renderCase(p, "c", new Set()), '\tcase "c" {\n\t\tlet r <- api.DELETE("/items/:id", "a") by Visitor\n\t}');
  });
  it("picks a name for the response that the cell has not bound", () => {
    const p = plan([code('// @handler\nlet response = 1\napi.GET("/x") by Visitor', response("Ok", "hi"))], 0);
    assert.strictEqual(p.names.response, "response2");
  });
  it("keeps the `expect`s after the call", () => {
    const p = plan([code('// @handler\nlet r <- api.GET("/x") by Visitor\nexpect r is Ok(_)', response("Ok", "hi"))], 0);
    assert.deepStrictEqual(p.offers, []);
    assert.ok(renderCase(p, "c", new Set()).includes("expect r is Ok(_)"));
  });
  it("offers a message's text as the payload", () => {
    const p = plan([code('// @handler\nlet r <- api.PUT("/items/:id", "a") by Visitor', response("Conflict", "exists"))], 0);
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect r is Conflict(_)", 'expect payload == "exists"']);
  });
  it("says a raw body has nothing to assert", () => {
    const p = plan([code('// @handler\nlet r <- api.GET("/x") by Visitor', { kind: "response", response: { variant: null, hasPayload: false } })], 0);
    assert.deepStrictEqual(p.offers, []);
    assert.ok(p.notCarried.some((n) => /raw or streamed/.test(n)));
  });
  it("treats a handler cell that ends in its own `match` as a value", () => {
    const p = plan([code('// @handler\nlet r <- api.GET("/x") by Visitor\nmatch r {\n  Ok(s) => s,\n  _ => "no",\n}', { kind: "value", value: "hi", type: "String" })], 0);
    assert.strictEqual(p.names.response, undefined);
    assert.deepStrictEqual(p.offers.map((o) => o.line), ['expect result == "hi"']);
  });
});

describe("promote: a refined-type cell as a case (#210)", () => {
  const rows: CellOutput = {
    kind: "refined",
    type: "Percent",
    rows: [
      { candidate: { text: "50", line: 1 }, outcome: "accepted", value: "50" },
      { candidate: { text: "150", line: 2 }, outcome: "refused", message: "must be at most 100" },
      { candidate: { text: '"x"', line: 3 }, outcome: "invalid", message: "expected Int" },
    ],
  };
  it("offers each candidate's outcome, and lists a candidate that did not check", () => {
    const p = plan([code("// @refined Percent\n50\n150 // too big\n\"x\"", rows)], 0);
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect Percent.of(50) is Ok(_)", "expect Percent.of(150) is Err(_)"]);
    assert.ok(p.notCarried.some((n) => /"x"/.test(n)));
    const text = renderCase(p, "percent", new Set(["o1"]));
    assert.ok(text.includes("expect Percent.of(150) is Err(_)") && !text.includes("Percent.of(50)"), text);
    assert.ok(!text.includes("@refined"), text);
  });
});

describe("promote: a notebook as a suite (#210)", () => {
  const cells = [
    md("# Money\n\nThe pricing rules."),
    code("let base = 2000", { kind: "value", value: null, type: "()" }),
    md("## Discount\n\nA quarter off."),
    code("discount(base, 25)", { kind: "value", value: 1500, type: "Int" }),
    code("elsewhere()", { kind: "value", value: 1, type: "Int" }, "other.unit"),
    code("discount(base, 0)"),
    code("// @refined percent\n5"),
    code(""),
  ];
  it("makes a case per code cell of the unit, in order, and reports what it left out", () => {
    const s = planSuite(cells, "shop.money");
    assert.deepStrictEqual(s.cases.map((c) => c.cell), [1, 3, 5]);
    assert.deepStrictEqual(s.otherUnits, [{ cell: 4, unit: "other.unit" }]);
    assert.deepStrictEqual(s.neverRan, [5]);
    assert.deepStrictEqual(s.skipped.map((x) => x.cell), [6]);
    assert.deepStrictEqual(unitsOf(cells), ["shop.money", "other.unit"]);
  });
  it("gives each unit's cells to that unit's own suite, and skips a cell that runs in none", () => {
    const mixed = [code("a()", undefined, "u.one"), code("b()", undefined, "u.two"), { ...code("c()"), unit: undefined }, code("d()", undefined, "u.one")];
    assert.deepStrictEqual(planSuite(mixed, "u.one").cases.map((c) => c.cell), [0, 3]);
    assert.deepStrictEqual(planSuite(mixed, "u.two").cases.map((c) => c.cell), [1]);
    assert.deepStrictEqual(planSuite(mixed, "u.two").skipped.map((x) => x.cell), [2]);
    assert.deepStrictEqual(unitsOf(mixed), ["u.one", "u.two"]);
  });
  it("writes a suite with the first heading as its doc comment and the narrative as each case's", () => {
    const s = planSuite(cells, "shop.money");
    const text = newSuite("shop.money", suiteHeading(cells), "money.bynknb", [], s.cases.slice(1, 2).map((c) => renderCase(c, "Discount", all(c))));
    assert.ok(text.includes("\n--- Money\nsuite shop.money {\n"), text);
    assert.ok(text.includes('\t--- A quarter off.\n\tcase "Discount" {\n\t\tlet base = 2000\n\t\tlet result = discount(base, 25)\n\t\texpect result == 1500\n\t}'), text);
  });
});

describe("promote: adding to a suite (#210)", () => {
  const suite = ["// header", "--- The suite { has braces } and a \"quote\".", "suite shop.money {", "\tconsumes bynk { Claim }", "", "\t--- Existing.", '\tcase "a" {', "\t\texpect 1 == 1", "\t}", "}", ""].join("\n");
  const newCase = '\t--- New.\n\tcase "b" {\n\t\texpect 2 == 2\n\t}';

  it("finds the unit-tier suite for a unit, and not a longer name, a comment or another tier", () => {
    assert.ok(findSuite(suite, "shop.money")?.close);
    assert.strictEqual(findSuite(suite, "shop"), undefined);
    assert.strictEqual(findSuite("// suite shop.money {\n", "shop.money"), undefined);
    assert.strictEqual(findSuite("suite a.b as system {\n}\n", "a.b")?.tier, "system");
    assert.deepStrictEqual([...caseNames(suite)], ["a"]);
  });
  it("inserts a case before the closing brace and changes nothing else", () => {
    const r = insertCases(suite, "shop.money", [], [newCase]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(r.text.startsWith(suite.slice(0, suite.lastIndexOf("}"))), "everything before the brace is untouched");
    assert.strictEqual(r.text, suite.replace("\t}\n}\n", `\t}\n\n${newCase}\n}\n`));
    assert.deepStrictEqual([...caseNames(r.text)], ["a", "b"]);
  });
  it("adds only the `consumes` the suite lacks", () => {
    const r = insertCases(suite, "shop.money", ["consumes bynk { Claim }", "consumes bynk.cloudflare { D1 }"], [newCase]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.strictEqual((r.text.match(/consumes bynk \{ Claim \}/g) ?? []).length, 1);
    assert.ok(r.text.includes("\tconsumes bynk.cloudflare { D1 }\n\tconsumes bynk { Claim }"), r.text);
  });
  it("recognises each `consumes` it already has: two in a row, one before a case, a list over several lines", () => {
    const two = 'suite a.b {\n\tconsumes bynk { Claim }\n\tconsumes bynk.cloudflare { D1 }\n\tcase "x" {\n\t\texpect true\n\t}\n}\n';
    const r = insertCases(two, "a.b", ["consumes bynk { Claim }", "consumes bynk.cloudflare { D1 }"], ['\tcase "y" {\n\t\texpect true\n\t}']);
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual((r.text.match(/consumes/g) ?? []).length, 2, r.text);
    const direct = 'suite a.b {\n\tconsumes bynk { Claim }\n\tcase "x" {\n\t\texpect true\n\t}\n}\n';
    const d = insertCases(direct, "a.b", ["consumes bynk { Claim }"], ['\tcase "y" {\n\t\texpect true\n\t}']);
    assert.ok(d.ok);
    if (d.ok) assert.strictEqual((d.text.match(/consumes/g) ?? []).length, 1, d.text);
    const wide = 'suite a.b {\n\tconsumes bynk {\n\t\tClaim,\n\t\tOther\n\t}\n\tcase "x" {\n\t\texpect true\n\t}\n}\n';
    const w = insertCases(wide, "a.b", ["consumes bynk { Claim, Other }", "consumes bynk.cloudflare { D1 }"], ['\tcase "y" {\n\t\texpect true\n\t}']);
    assert.ok(w.ok);
    if (w.ok) assert.strictEqual((w.text.match(/consumes bynk \{/g) ?? []).length, 1, w.text);
  });
  it("merges the plans' `consumes` once each, and names a new suite's file", () => {
    const p = (c: string[]): { consumes: string[] } => ({ consumes: c });
    assert.deepStrictEqual(mergeConsumes([p(["consumes a { X }"]), p(["consumes  a  { X }", "consumes b"])]), ["consumes a { X }", "consumes b"]);
    assert.deepStrictEqual([0, 1, 2, 3].map((n) => suiteFileName("shop.money", n)), ["shop.money.bynk", "shop.money.unit.bynk", "shop.money.unit2.bynk", "shop.money.unit3.bynk"]);
  });
  it("keeps the suite's own indentation", () => {
    const spaced = "suite a.b {\n  case \"x\" {\n    expect true\n  }\n}\n";
    const r = insertCases(spaced, "a.b", [], ['\tcase "y" {\n\t\texpect true\n\t}']);
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.text.includes('  case "y" {\n    expect true\n  }\n}'), r.text);
  });
  it("appends to a fragment-form suite", () => {
    const r = insertCases('suite a.b\n\ncase "x" {\n\texpect true\n}\n', "a.b", ["consumes bynk { Claim }"], ['\tcase "y" {\n\t\texpect true\n\t}']);
    assert.ok(r.ok);
    if (r.ok) assert.strictEqual(r.text, 'suite a.b\nconsumes bynk { Claim }\n\ncase "x" {\n\texpect true\n}\n\ncase "y" {\n\texpect true\n}\n');
  });
  it("sees a brace in a doc comment or a string as nothing", () => {
    const tricky = 'suite a.b {\n\t---\n\tA block with a } in it\n\t---\n\tcase "}" {\n\t\texpect "}" == "}"\n\t}\n}\n';
    assert.strictEqual(findSuite(tricky, "a.b")?.close, tricky.lastIndexOf("}"));
  });
  it("refuses a suite it cannot edit safely", () => {
    assert.strictEqual(insertCases("suite a.b { case \"x\" { expect true } }\n", "a.b", [], [newCase]).ok, false);
    assert.strictEqual(insertCases("suite a.b as system {\n}\n", "a.b", [], [newCase]).ok, false);
    assert.strictEqual(insertCases("suite c.d {\n}\n", "a.b", [], [newCase]).ok, false);
  });
});
