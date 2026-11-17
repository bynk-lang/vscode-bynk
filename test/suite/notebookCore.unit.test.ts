// #151: Bynk notebooks, the pure part: the file, taking a cell apart, the
// snippet sent for a cell, reading `bynk eval`'s result, and showing a value.

import * as assert from "assert";

import {
  analyseCell,
  buildSnippet,
  decodeEval,
  evalArgs,
  parseNotebook,
  placeDiagnostics,
  renderValue,
  serializeNotebook,
  splitStatements,
  unitFor,
  unitNames,
  type CellInput,
} from "../../src/notebookCore";

describe("the notebook file (#151)", () => {
  it("round-trips, with each cell's source as lines and no outputs", () => {
    const text = serializeNotebook({ unit: "shop.money", cells: [{ kind: "markdown", source: "# Hi" }, { kind: "code", source: "let a = 1\na + 1" }, { kind: "code", source: "" }] });
    assert.ok(text.includes('"source": [\n        "let a = 1",\n        "a + 1"\n      ]'), text);
    assert.deepStrictEqual(parseNotebook(text), { notebook: { unit: "shop.money", cells: [{ kind: "markdown", source: "# Hi" }, { kind: "code", source: "let a = 1\na + 1" }, { kind: "code", source: "" }] } });
  });

  it("reads an empty file as an empty notebook and a string source as it is", () => {
    assert.deepStrictEqual(parseNotebook(""), { notebook: { cells: [] } });
    assert.deepStrictEqual(parseNotebook('{ "cells": [ { "kind": "code", "source": "1" } ] }'), { notebook: { unit: undefined, cells: [{ kind: "code", source: "1" }] } });
  });

  it("says what is wrong with a file that is not a notebook", () => {
    const err = (t: string): string => ("error" in parseNotebook(t) ? (parseNotebook(t) as { error: string }).error : "ok");
    assert.match(err("{ nope"), /^Not a Bynk notebook/);
    assert.match(err("[]"), /expected a JSON object/);
    assert.match(err("{}"), /no "cells"/);
    assert.match(err('{ "cells": [ 3 ] }'), /Cell 1 is not an object/);
    assert.match(err('{ "cells": [ { "kind": "sql", "source": "" } ] }'), /Cell 1 has kind "sql"/);
    assert.match(err('{ "cells": [ { "kind": "code", "source": 4 } ] }'), /source must be/);
    assert.match(err('{ "version": 9, "cells": [] }'), /version 9/);
  });

  it("drops a unit that is not a dotted name", () => {
    assert.strictEqual((parseNotebook('{ "unit": "a b", "cells": [] }') as { notebook: { unit?: string } }).notebook.unit, undefined);
  });
});

describe("splitStatements (#151)", () => {
  it("keeps a multi-line statement whole and leaves comments and blanks out", () => {
    const s = splitStatements('// a note\nlet r = Rec {\n  a: 1,\n  b: "}",\n}\n\nlet x = r\n  .a\nx');
    assert.deepStrictEqual(s.map((x) => [x.start, x.end]), [[1, 4], [6, 7], [8, 8]]);
    assert.strictEqual(s[0].text, 'let r = Rec {\n  a: 1,\n  b: "}",\n}');
  });

  it("is not fooled by a bracket in a string or a comment", () => {
    const s = splitStatements('let a = "("\nlet b = 1 // (\nb');
    assert.deepStrictEqual(s.map((x) => x.text), ['let a = "("', "let b = 1 // (", "b"]);
  });

  it("treats a line that closes a bracket or starts a chain as a continuation", () => {
    const s = splitStatements("let a = foo(\n1\n)\nlet b = a\n.bar()");
    assert.deepStrictEqual(s.map((x) => [x.start, x.end]), [[0, 2], [3, 4]]);
  });
});

describe("analyseCell (#151)", () => {
  it("separates the leading consumes and stub lines from the case", () => {
    const c = analyseCell("// @unit shop.orders\nconsumes shop.catalog { Sku }\nstub Fetch.send(_) returns Ok(1)\n\nlet a = 1\na");
    assert.strictEqual(c.unit, "shop.orders");
    assert.deepStrictEqual(c.header.map((h) => h.text), ["consumes shop.catalog { Sku }", "stub Fetch.send(_) returns Ok(1)"]);
    assert.deepStrictEqual(c.body.map((h) => h.text), ["let a = 1", "a"]);
  });

  it("reads @unit only before the case starts", () => {
    assert.strictEqual(analyseCell("1\n// @unit a.b").unit, undefined);
    assert.strictEqual(analyseCell("// @unit not a unit").unit, undefined);
  });

  it("picks the cell's unit before the notebook's", () => {
    assert.strictEqual(unitFor({ unit: "a" }, "b"), "a");
    assert.strictEqual(unitFor({ unit: undefined }, "b"), "b");
    assert.strictEqual(unitFor({ unit: undefined }, undefined), undefined);
  });
});

describe("buildSnippet (#151)", () => {
  const cell = (source: string, ran = true, unit?: string): CellInput => ({ source, ran, unit });

  it("sends a cell with nothing before it as it is", () => {
    const s = buildSnippet([cell("discount(2000, 25)", false)], 0, "shop.money");
    assert.strictEqual(s.text, "discount(2000, 25)");
    assert.deepStrictEqual(s.used, []);
  });

  it("sends earlier cells' lets ahead of the cell, never their last expression", () => {
    const cells = [cell("let base = 2000\nbase"), cell("// note\nlet off = Percent.of(25)\nexpect off.isOk()\nbase + 1"), cell("discount(base, 25)", false)];
    const s = buildSnippet(cells, 2, "shop.money");
    assert.strictEqual(s.text, "let base = 2000\nlet off = Percent.of(25)\ndiscount(base, 25)");
    assert.deepStrictEqual(s.used, [0, 1]);
  });

  it("hoists consumes and stub lines to the top, once each", () => {
    const cells = [
      cell("consumes shop.catalog { Sku }\nlet s = Sku.of(\"a\")\ns"),
      cell("consumes  shop.catalog { Sku }\nstub Fetch.send(_) returns Ok(1)\n1"),
      cell("consumes bynk { Fetch }\nlet n = 2\nn", false),
    ];
    const s = buildSnippet(cells, 2, "shop.orders");
    assert.strictEqual(s.text, 'consumes shop.catalog { Sku }\nstub Fetch.send(_) returns Ok(1)\nconsumes bynk { Fetch }\nlet s = Sku.of("a")\nlet n = 2\nn');
    assert.deepStrictEqual(s.used, [0]);
  });

  it("skips cells that have not run, or run in another unit", () => {
    const cells = [cell("let a = 1\na", false), cell("let b = 2\nb", true, "other.unit"), cell("let c = 3\nc", true, "shop.money"), cell("c", false)];
    const s = buildSnippet(cells, 3, "shop.money");
    assert.strictEqual(s.text, "let c = 3\nc");
    assert.deepStrictEqual(s.used, [2]);
  });

  it("keeps the cell's own comments and blank lines, and maps each line back", () => {
    const cells = [cell("let a = 1\na"), cell("// the total\n\nlet t = a + 1\n\nt")];
    const s = buildSnippet(cells, 1, "u.v");
    assert.strictEqual(s.text, "let a = 1\nlet t = a + 1\n\nt");
    assert.deepStrictEqual(s.origins, [
      { cell: 0, line: 0 },
      { cell: 1, line: 2 },
      { cell: 1, line: 3 },
      { cell: 1, line: 4 },
    ]);
  });

  it("places a diagnostic in the cell that wrote the line", () => {
    const cells = [cell("let a = 1\na"), cell("a + \"x\"", false)];
    const s = buildSnippet(cells, 1, "u.v");
    const placed = placeDiagnostics(
      [
        { line: 1, col: 5, severity: "error", code: "c", message: "in the preamble" },
        { line: 2, col: 1, severity: "error", code: "c", message: "in the cell" },
        { line: 1, col: 1, severity: "error", code: "c", message: "elsewhere", file: "src/x.bynk" },
      ],
      s.origins,
    );
    assert.deepStrictEqual(placed.map((p) => [p.cell, p.at]), [[0, 0], [1, 0], [undefined, undefined]]);
  });
});

describe("bynk eval arguments and results (#151)", () => {
  it("passes the snippet as --expr, and --sources-stdin and --timeout only when asked", () => {
    assert.deepStrictEqual(evalArgs({ root: "/p", unit: "a.b", snippet: "1", sourcesStdin: false }), ["eval", "/p", "--unit", "a.b", "--expr", "1"]);
    assert.deepStrictEqual(evalArgs({ root: "/p", unit: "a.b", snippet: "1", sourcesStdin: true, timeoutSeconds: 5.7 }), ["eval", "/p", "--unit", "a.b", "--expr", "1", "--sources-stdin", "--timeout", "5"]);
    assert.deepStrictEqual(evalArgs({ root: "/p", unit: "a", snippet: "1", sourcesStdin: false, timeoutSeconds: 0 }).slice(-2), ["--timeout", "1"]);
  });

  it("reads a value, a refused construction (still a value), diagnostics and each error kind", () => {
    assert.deepStrictEqual(decodeEval('{"value":1500,"type":"Int","diagnostics":[]}', "", 0), { kind: "value", value: 1500, type: "Int", diagnostics: [] });
    const err = decodeEval('{"value":{"error":{"message":"m"},"kind":"Err"},"type":"Result[Percent, ValidationError]","diagnostics":[]}', "", 0);
    assert.strictEqual(err.kind, "value");
    const d = decodeEval('{"value":null,"type":null,"diagnostics":[{"line":2,"col":14,"severity":"error","code":"bynk.types.x","message":"no"},{"file":"src/a.bynk","line":1,"col":1,"severity":"warning","code":"w","message":"hm"}]}', "", 1);
    assert.deepStrictEqual(d.kind === "diagnostics" && d.diagnostics.map((x) => [x.line, x.col, x.severity, x.file]), [[2, 14, "error", undefined], [1, 1, "warning", "src/a.bynk"]]);
    for (const kind of ["runtime", "timeout", "setup"] as const) {
      const e = decodeEval(`{"diagnostics":[],"error":{"kind":"${kind}","message":"why"}}`, "", 1);
      assert.deepStrictEqual(e, { kind: "error", errorKind: kind, message: "why", diagnostics: [] });
    }
  });

  it("reads the unit value, and says what the process said when it printed no result", () => {
    assert.deepStrictEqual(decodeEval('{"value":null,"type":"Unit","diagnostics":[]}', "", 0), { kind: "value", value: null, type: "Unit", diagnostics: [] });
    const bad = decodeEval("", "error: tsc not found\nmore", 2);
    assert.deepStrictEqual(bad, { kind: "error", errorKind: "unreadable", message: "bynk eval: error: tsc not found", diagnostics: [] });
    assert.match((decodeEval("", "", null) as { message: string }).message, /signal/);
    assert.strictEqual((decodeEval("[1]", "", 0) as { kind: string }).kind, "diagnostics");
  });
});

describe("renderValue (#151)", () => {
  it("writes values the way Bynk does", () => {
    assert.strictEqual(renderValue(1500), "1500");
    assert.strictEqual(renderValue("a\"b"), '"a\\"b"');
    assert.strictEqual(renderValue([1, 2, 3]), "[1, 2, 3]");
    assert.strictEqual(renderValue({ kind: "Ok", value: 25 }), "Ok(25)");
    assert.strictEqual(renderValue({ kind: "Some", value: 3 }), "Some(3)");
    assert.strictEqual(renderValue({ kind: "None" }), "None");
    assert.strictEqual(renderValue({ kind: "Err", error: { field: "Percent", message: "must be in range [0, 100]", value: 150 } }), 'Err({ field: "Percent", message: "must be in range [0, 100]", value: 150 })');
    assert.strictEqual(renderValue({ kind: "Circle", r: 2 }), "Circle { r: 2 }");
    assert.strictEqual(renderValue({ id: "a", cents: 3 }), '{ cents: 3, id: "a" }');
    assert.strictEqual(renderValue({}), "{}");
    assert.strictEqual(renderValue(null), "null");
  });

  it("leaves a record whose kind is not a variant name alone", () => {
    assert.strictEqual(renderValue({ kind: "lower", n: 1 }), '{ kind: "lower", n: 1 }');
  });

  it("wraps a long value over lines, indented", () => {
    const v = { kind: "Ok", value: { items: Array.from({ length: 6 }, (_, i) => ({ sku: `item-number-${i}`, qty: i })), total: 15 } };
    const text = renderValue(v);
    assert.ok(text.split("\n").length > 3, text);
    assert.ok(text.startsWith("Ok({\n  items: ["), text);
    assert.ok(text.endsWith("\n})"), text);
  });
});

describe("unitNames (#151)", () => {
  it("lists the commons and contexts a source declares", () => {
    assert.deepStrictEqual(unitNames("commons shop.money\n\ntype A = Int\n"), ["shop.money"]);
    assert.deepStrictEqual(unitNames("context shop.orders\nuses shop.money\n"), ["shop.orders"]);
    assert.deepStrictEqual(unitNames("// context x\ntype A = Int"), []);
  });
});
