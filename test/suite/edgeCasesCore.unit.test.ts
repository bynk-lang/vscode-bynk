// #229: Generate Edge Cases…, the pure part: boundary candidates from a refined
// type's predicates, the refined fields of a route's request, and the notebook
// written from what the real constructor answered.

import * as assert from "assert";

import { buildNotebook, candidatesFor, notebookFileName, refinedFields, successLine, validSample, type BuildInput, type TypeVerdicts, type Verdict } from "../../src/edgeCasesCore";
import { actorClause, writeCall, type PromoteRoute } from "../../src/scenarioPromoteCore";
import type { Predicate, RefinedClause } from "../../src/webview/refinedTypes";
import type { WcEnvelope, WcInst, WcRef, WcType } from "../../src/webview/wireContractTypes";

const clause = (source: string, predicate?: Predicate): RefinedClause => ({ source, description: source, message: source, predicate });
const model = (base: "Int" | "Float" | "String", clauses: RefinedClause[], examples: string[] = []) => ({ base, clauses, examples });
const texts = (m: ReturnType<typeof model>): string[] => candidatesFor(m).candidates.map((c) => c.text);

describe("edge cases: candidates from predicates (#229)", () => {
  it("tries both sides of each end of a range", () => {
    assert.deepStrictEqual(texts(model("Int", [clause("InRange(0, 100)", { kind: "range", min: 0, max: 100 })])), ["-1", "0", "100", "101"]);
  });
  it("tries zero and one for Positive, and just below zero for NonNegative", () => {
    assert.deepStrictEqual(texts(model("Int", [clause("Positive", { kind: "positive" })])), ["0", "1"]);
    assert.deepStrictEqual(texts(model("Int", [clause("NonNegative", { kind: "nonNegative" })])), ["-1", "0"]);
  });
  it("tries empty and one character for NonEmpty", () => {
    assert.deepStrictEqual(texts(model("String", [clause("NonEmpty", { kind: "nonEmpty" })])), ['""', '"a"']);
  });
  it("tries the length at and just past a MaxLength, and just short of and at a MinLength", () => {
    assert.deepStrictEqual(texts(model("String", [clause("MaxLength(3)", { kind: "maxLength", length: 3 })])), ['"aaa"', '"aaaa"']);
    assert.deepStrictEqual(texts(model("String", [clause("MinLength(2)", { kind: "minLength", length: 2 })])), ['"a"', '"aa"']);
    assert.deepStrictEqual(texts(model("String", [clause("Length(2)", { kind: "length", length: 2 })])), ['"a"', '"aa"', '"aaa"']);
  });
  it("joins the clauses of one type and says what a shared value probes", () => {
    const c = candidatesFor(model("String", [clause("NonEmpty", { kind: "nonEmpty" }), clause("MaxLength(1)", { kind: "maxLength", length: 1 })]));
    assert.deepStrictEqual(c.candidates.map((x) => x.text), ['""', '"a"', '"aa"']);
    assert.strictEqual(c.candidates[1].why, "one character; the maximum length");
  });
  it("takes the explorer's examples for a pattern, and no more than three", () => {
    const m = model("String", [clause("Matches(…)", { kind: "matches", pattern: "[a-z]+" })], ["a", "b", "c", "d"]);
    assert.deepStrictEqual(texts(m), ['"a"', '"b"', '"c"']);
  });
  it("leaves out what it cannot read, and says why", () => {
    const f = candidatesFor(model("Float", [clause("InRange(0.0, 1.0)", { kind: "range", min: 0, max: 1 })]));
    assert.deepStrictEqual(f.candidates, []);
    assert.match(f.leftOut[0], /Float/);
    assert.match(candidatesFor(model("Int", [clause("Odd")])).leftOut[0], /no structured predicate/);
    assert.match(candidatesFor(model("Int", [clause("X", { kind: "range", min: 0, max: 2 ** 60 })])).leftOut[0], /too large/);
    assert.match(candidatesFor(model("String", [clause("MaxLength(9999)", { kind: "maxLength", length: 9999 })])).leftOut[0], /not probed/);
    assert.match(candidatesFor({ base: "String", clauses: [clause("Z", { kind: "future" } as unknown as Predicate)], examples: [] }).leftOut[0], /does not derive/);
    assert.match(candidatesFor(model("Int", [clause("NonEmpty", { kind: "nonEmpty" })])).leftOut[0], /does not apply/);
  });
  it("leaves out a pattern example with a control character", () => {
    const c = candidatesFor(model("String", [clause("Matches", { kind: "matches", pattern: "." })], ["a\u0001b", "ok"]));
    assert.deepStrictEqual(c.candidates.map((x) => x.text), ['"ok"']);
    assert.strictEqual(c.leftOut.length, 1);
  });
  it("shortens a long value in its heading", () => {
    const c = candidatesFor(model("String", [clause("MaxLength(20)", { kind: "maxLength", length: 20 })])).candidates;
    assert.strictEqual(c[1].shown, '"aaaaaaaa"… (21 characters)');
    assert.strictEqual(c[1].text.length, 23);
  });
});

const str: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
const scalar = (name: string, predicates: string[], opaque = false): WcType => ({ name, codecSuffix: name, provenance: { kind: "Owned" }, loc: null, body: { kind: "Scalar", base: "Int", json: "Number", opaque, predicates, baseGuards: [], revalidation: "ViaConstructor" } });
const NAME: WcType = { ...scalar("Name", ["NonEmpty"]), body: { kind: "Scalar", base: "String", json: "String", opaque: false, predicates: ["NonEmpty", "MaxLength(5)"], baseGuards: [], revalidation: "ViaConstructor" } };
const PERCENT = scalar("Percent", ["InRange(0, 100)"]);
const DISCOUNT: WcType = {
  name: "Discount",
  codecSuffix: "Discount",
  provenance: { kind: "Owned" },
  loc: null,
  body: {
    kind: "Record",
    fields: [
      { name: "name", shape: { kind: "Named", name: "Name" }, pathSegment: "name", default: null },
      { name: "pct", shape: { kind: "Named", name: "Percent" }, pathSegment: "pct", default: null },
      { name: "note", shape: str, pathSegment: "note", default: null },
    ],
  },
};
const route = (over: Partial<PromoteRoute> = {}): PromoteRoute => ({
  unit: "shop",
  service: "api",
  method: "POST",
  path: "/discounts",
  model: { envelope: { kind: "Bare", param: "body", shape: { kind: "Named", name: "Discount" } }, types: [DISCOUNT, NAME, PERCENT], instantiations: [], success: { kind: "Named", name: "Discount" } },
  responses: [{ status: 200, variant: "Ok", origin: { kind: "DeclaredSuccess" } }, { status: 201, variant: "Created", origin: { kind: "Constructed", range: { start: { line: 8, character: 4 }, end: { line: 8, character: 17 } } } }],
  ...over,
});

describe("edge cases: the refined fields of a request (#229)", () => {
  it("finds the refined fields of a body record, with where they are", () => {
    const { fields, leftOut } = refinedFields(route().model);
    assert.deepStrictEqual(fields.map((f) => [f.label, f.param, f.path, f.type]), [
      ["body.name", "body", ["name"], "Name"],
      ["body.pct", "body", ["pct"], "Percent"],
    ]);
    assert.deepStrictEqual(leftOut, []);
  });
  it("finds a refined path parameter itself", () => {
    const { fields } = refinedFields({ envelope: { kind: "Keyed", params: [{ name: "pct", shape: { kind: "Named", name: "Percent" } }] }, types: [PERCENT], instantiations: [] });
    assert.deepStrictEqual(fields.map((f) => [f.label, f.path]), [["pct", []]]);
  });
  it("says what it did not look into: an opaque type, a list of refined values", () => {
    const envelope: WcEnvelope = { kind: "Keyed", params: [{ name: "id", shape: { kind: "Named", name: "Id" } }, { name: "pcts", shape: { kind: "Inst", key: "L" } }] };
    const instantiations: WcInst[] = [{ kind: "ListInst", key: "L", elem: { kind: "Named", name: "Percent" } }];
    const m = { envelope, types: [scalar("Id", ["NonEmpty"], true), PERCENT], instantiations };
    const { fields, leftOut } = refinedFields(m);
    assert.deepStrictEqual(fields, []);
    assert.strictEqual(leftOut.length, 2);
    assert.match(leftOut[0], /opaque/);
    assert.match(leftOut[1], /inside a list or an option/);
  });
  it("finds nothing in a route with no refined value", () => {
    assert.deepStrictEqual(refinedFields({ envelope: { kind: "Empty" }, types: [], instantiations: [] }), { fields: [], leftOut: [] });
  });
});

describe("edge cases: the route's success (#229)", () => {
  const resp = (status: number, variant: string, origin: "DeclaredSuccess" | "Constructed" | "BoundaryImplicit") => ({ status, variant, origin: origin === "Constructed" ? { kind: origin, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } : origin === "BoundaryImplicit" ? { kind: origin, why: "" } : { kind: origin } });
  it("names the one declared success variant", () => {
    assert.deepStrictEqual(successLine(route(), "response"), { variant: "Created", line: "expect response is Created(_)" });
    assert.strictEqual((successLine({ responses: [resp(204, "NoContent", "DeclaredSuccess")] }, "r") as { line: string }).line, "expect r is NoContent");
  });
  it("prefers what the handler constructs to the declared `Ok` (bynk v0.639.1 lists both), and ignores the boundary's 400", () => {
    const r = successLine({ responses: [resp(200, "Ok", "DeclaredSuccess"), resp(201, "Created", "Constructed"), resp(400, "StructuralMismatch", "BoundaryImplicit")] }, "r");
    assert.deepStrictEqual(r, { variant: "Created", line: "expect r is Created(_)" });
  });
  it("does not guess between several, or with none", () => {
    assert.match((successLine({ responses: [resp(200, "Ok", "Constructed"), resp(201, "Created", "Constructed")] }, "r") as { why: string }).why, /Ok or Created/);
    assert.match((successLine({ responses: [resp(400, "BadRequest", "Constructed")] }, "r") as { why: string }).why, /no success/);
    assert.match((successLine({}, "r") as { why: string }).why, /did not give/);
  });
});

describe("edge cases: a call that varies one field (#229)", () => {
  const valid = new Map<string, string | number>([["Name", "ab"], ["Percent", 50]]);
  it("holds the other fields at a valid sample and sets the one under test", () => {
    assert.strictEqual(writeCall(route(), "Visitor", { valid, set: { param: "body", path: ["pct"], value: 101 } })?.text, 'api.POST("/discounts", Discount { name: "ab", pct: 101, note: "sample" }) by Visitor');
    assert.strictEqual(writeCall(route(), "Visitor", { valid, set: { param: "body", path: ["name"], value: "" } })?.text, 'api.POST("/discounts", Discount { name: "", pct: 50, note: "sample" }) by Visitor');
  });
  it("sets a whole parameter when the path is empty", () => {
    const r = route({ path: "/p/:pct", model: { envelope: { kind: "Keyed", params: [{ name: "pct", shape: { kind: "Named", name: "Percent" } }] }, types: [PERCENT], instantiations: [], success: null } });
    assert.strictEqual(writeCall(r, undefined, { valid, set: { param: "pct", path: [], value: -1 } })?.text, 'api.POST("/p/:pct", -1)');
  });
  it("is the plain call when nothing varies", () => {
    assert.strictEqual(writeCall(route(), undefined)?.text, 'api.POST("/discounts", Discount { name: "sample", pct: 1, note: "sample" })');
  });
  it("writes an actor's identity as the handler cell does", () => {
    assert.strictEqual(actorClause("User", "UserId"), 'User(UserId.unsafe("sample"))');
  });
});

const v = (text: string, outcome: Verdict["outcome"], why = "w", message?: string): Verdict => ({ candidate: { text, why, shown: text }, outcome, message });
const verdicts = (type: string, vs: Verdict[]): ReadonlyMap<string, TypeVerdicts> => new Map([[type, { type, verdicts: vs }]]);

describe("edge cases: the notebook (#229)", () => {
  const input = (over: Partial<BuildInput> = {}): BuildInput => ({
    unit: "shop",
    route: "POST /discounts",
    fields: [{ param: "body", path: ["pct"], type: "Percent", label: "body.pct" }],
    byType: verdicts("Percent", [v("-1", "refused", "just below the minimum", "must be in range [0, 100]"), v("0", "accepted", "the minimum")]),
    success: { line: (b) => `expect ${b} is Created(_)` },
    call: (f, text) => `api.POST("/discounts", Discount { pct: ${text} }) by Visitor`,
    leftOut: [],
    ...over,
  });

  it("writes a handler cell for an accepted value and a constructor check for a refused one", () => {
    const { notebook, cases, accepted, refused } = buildNotebook(input());
    assert.deepStrictEqual([cases, accepted, refused], [2, 1, 1]);
    assert.strictEqual(notebook.unit, "shop");
    const code = notebook.cells.filter((c) => c.kind === "code").map((c) => c.source);
    assert.deepStrictEqual(code, [
      "expect Percent.of(-1) is Err(_)\nPercent.of(-1)",
      '// @handler\nlet response <- api.POST("/discounts", Discount { pct: 0 }) by Visitor\nexpect response is Created(_)',
    ]);
  });
  it("puts a heading above each cell, for the case's name, and says what the compiler said", () => {
    const md = buildNotebook(input()).notebook.cells.filter((c) => c.kind === "markdown").map((c) => c.source);
    assert.match(md[0], /^# Edge cases: POST \/discounts/);
    assert.match(md[1], /^## POST \/discounts: body\.pct = -1 \(refused\)/);
    assert.match(md[1], /refuses it \(must be in range \[0, 100\]\)/);
    assert.match(md[2], /^## POST \/discounts: body\.pct = 0 \(accepted\)/);
  });
  it("asserts no answer when the route's success is not one variant, and says so", () => {
    const { notebook } = buildNotebook(input({ success: { why: "the route's success is Ok or Created; naming one would be a guess" } }));
    assert.strictEqual(notebook.cells.at(-1)?.source, '// @handler\nlet response <- api.POST("/discounts", Discount { pct: 0 }) by Visitor');
    assert.match(notebook.cells[0].source, /answer is not asserted: the route's success is Ok or Created/);
  });
  it("lists what was left out in the introduction", () => {
    assert.match(buildNotebook(input({ leftOut: ["Percent: X"] })).notebook.cells[0].source, /Left out:\n- Percent: X/);
  });
  it("skips an accepted value whose call cannot be written", () => {
    const { notebook } = buildNotebook(input({ call: () => undefined }));
    assert.strictEqual(notebook.cells.filter((c) => c.kind === "code").length, 1);
  });
  it("covers each field with its own type's values", () => {
    const fields = [
      { param: "body", path: ["name"], type: "Name", label: "body.name" },
      { param: "body", path: ["pct"], type: "Percent", label: "body.pct" },
    ];
    const byType = new Map<string, TypeVerdicts>([...verdicts("Name", [v('""', "refused")]), ...verdicts("Percent", [v("0", "accepted")])]);
    assert.strictEqual(buildNotebook(input({ fields, byType })).cases, 2);
  });
});

describe("edge cases: samples and file names (#229)", () => {
  it("takes the first accepted value as the valid sample, in its own type", () => {
    assert.strictEqual(validSample([v("-1", "refused"), v("0", "accepted")]), 0);
    assert.strictEqual(validSample([v('"ab"', "accepted")]), "ab");
    assert.strictEqual(validSample([v("-1", "refused")]), undefined);
  });
  it("names the notebook after the route", () => {
    assert.strictEqual(notebookFileName("POST", "/discounts"), "edge-cases-POST-discounts.bynknb");
    assert.strictEqual(notebookFileName("GET", "/items/:id/tags"), "edge-cases-GET-items-by-id-tags.bynknb");
    assert.strictEqual(notebookFileName("GET", "/"), "edge-cases-GET.bynknb");
  });
});
