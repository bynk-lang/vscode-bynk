// #191: Bynk notebooks, handler cells, the pure part: telling the cell apart,
// observing the response of its call, reading it back, and writing a typed call
// with placeholder arguments for the route that was picked.

import * as assert from "assert";

import { cellKindOf, evalArgs } from "../../src/notebookCore";
import { decodeResponse, handlerSource, noUnitSuite, observe, renderResponse, responseJson, suiteNote, withCall } from "../../src/notebookHandlerCore";
import { actorClause, writeCall, type PromoteRoute } from "../../src/scenarioPromoteCore";
import type { WcRef, WcType } from "../../src/webview/wireContractTypes";

const str: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
const int: WcRef = { kind: "Base", base: "Int", json: "Number", guards: [], expected: { kind: "Integer" } };

describe("handler cells: the directive (#191)", () => {
  it("is a handler cell for `// @handler` before any code", () => {
    assert.deepStrictEqual(cellKindOf("// @handler\nlet r <- api.GET(\"/x\") by Visitor"), { kind: "handler" });
    assert.deepStrictEqual(cellKindOf("// @unit shop\n\n// @handler\nstub A.b(_) returns 1"), { kind: "handler" });
  });
  it("is not one when the directive comes after code, or merely starts with the word", () => {
    assert.deepStrictEqual(cellKindOf("1\n// @handler"), { kind: "expression" });
    assert.deepStrictEqual(cellKindOf("// @handlers"), { kind: "expression" });
  });
  it("refuses a directive with something after it, rather than run it as an expression", () => {
    const k = cellKindOf("// @handler api.POST");
    assert.strictEqual(k.kind, "bad-directive");
  });
  it("passes `--suite` to bynk eval only when asked", () => {
    assert.deepStrictEqual(evalArgs({ root: "/p", unit: "a", suite: "a", snippet: "1", sourcesStdin: true }), ["eval", "/p", "--unit", "a", "--expr=1", "--suite", "a", "--sources-stdin"]);
    assert.ok(!evalArgs({ root: "/p", unit: "a", snippet: "1", sourcesStdin: false }).includes("--suite"));
  });
});

describe("handler cells: observing the response (#191)", () => {
  const stubs = "// @handler\nstub Mailer.send(_) returns true\n";

  it("adds a match over a bound call and leaves the cell's lines where they were", () => {
    const src = `${stubs}let r <- api.POST("/todos", Todo { title: "a", done: false }) by User("bob")`;
    const { text, cell } = handlerSource(src);
    assert.strictEqual(cell.response, "r");
    assert.strictEqual(cell.rewritten, undefined);
    assert.ok(text.startsWith(src + "\nmatch r {\n"));
    assert.match(text, /Created\(p\) => "\{\\"variant\\":\\"Created\\",\\"payload\\":\\\(Json\.encode\(p\)\)\}",/);
    assert.match(text, /NoContent => "\{\\"variant\\":\\"NoContent\\"\}",/);
    assert.ok(text.endsWith('  _ => "{\\"variant\\":null}",\n}'));
  });

  it("says where the appended match starts, past the last line of the user's call", () => {
    const src = '// @handler\nlet r <- api.GET("/x") by Visitor\n\n// trailing';
    assert.strictEqual(handlerSource(src).cell.appendedFrom, 2);
    assert.strictEqual(handlerSource("// @handler\nstub A.b(_) returns 1").cell.appendedFrom, undefined);
  });

  it("binds a bare call on its own line, so no later line moves", () => {
    const src = `${stubs}api.GET("/me") by User("bob")`;
    const { text, cell } = handlerSource(src);
    assert.strictEqual(cell.response, "response__");
    assert.strictEqual(cell.rewritten, 2);
    assert.strictEqual(text.split("\n")[2], 'let response__ <- api.GET("/me") by User("bob")');
    assert.ok(text.includes("\nmatch response__ {\n"));
  });

  it("follows a call that goes over several lines, and drops what comes after it", () => {
    const src = '// @handler\nlet r: HttpResult[Todo] <- api.POST("/todos",\n  Todo { title: "a", done: false })\n  by Visitor\n// done';
    const { text, cell } = handlerSource(src);
    assert.strictEqual(cell.response, "r");
    assert.ok(text.includes('  by Visitor\nmatch r {'));
    assert.ok(!text.includes("// done"));
  });

  it("runs the cell as written when its last statement is not a call to a handler's address", () => {
    for (const src of [
      '// @handler\nlet r <- api.GET("/x") by Visitor\nmatch r { Ok(s) => s, _ => "" }',
      '// @handler\nlet r <- sched.run("nightly")',
      '// @handler\nlet Created(t) <- api.POST("/todos", 1) else { expect false }',
      "// @handler\nstub A.b(_) returns 1",
    ]) {
      const { text, cell } = handlerSource(src);
      assert.strictEqual(text, src);
      assert.deepStrictEqual(cell, {});
    }
  });

  it("lists no tuple-payload variant, whose body a case cannot name", () => {
    const m = observe("r");
    for (const v of ["Raw", "Streaming", "RawCreated"]) assert.ok(!m.includes(`${v}(`) && !m.includes(`${v} =>`), v);
    for (const v of ["Ok", "Found", "Conflict", "NotFound", "ServerError"]) assert.ok(m.includes(`${v}`), v);
  });
});

describe("handler cells: reading the response (#191)", () => {
  it("decodes a variant with a payload", () => {
    const r = decodeResponse('{"variant":"Created","payload":{"title":"a","done":false}}');
    assert.deepStrictEqual(r, { variant: "Created", status: 201, hasPayload: true, payload: { title: "a", done: false } });
    assert.strictEqual(renderResponse(r!), 'Created({ done: false, title: "a" })\n: HttpResult · 201');
    assert.deepStrictEqual(responseJson(r!), { variant: "Created", status: 201, payload: { title: "a", done: false } });
  });
  it("decodes a variant with none, and a message", () => {
    const nc = decodeResponse('{"variant":"NoContent"}')!;
    assert.strictEqual(renderResponse(nc), "NoContent\n: HttpResult · 204");
    assert.deepStrictEqual(responseJson(nc), { variant: "NoContent", status: 204 });
    assert.strictEqual(renderResponse(decodeResponse('{"variant":"Conflict","payload":"exists"}')!), 'Conflict("exists")\n: HttpResult · 409');
  });
  it("writes a unit payload as `()`", () => {
    assert.strictEqual(renderResponse(decodeResponse('{"variant":"Ok","payload":null}')!), "Ok(())\n: HttpResult · 200");
  });
  it("says so for a variant it cannot show, and for anything that is not a response", () => {
    assert.deepStrictEqual(decodeResponse('{"variant":null}'), { variant: null, hasPayload: false });
    for (const v of ["nope", 3, null, '["a"]', '{"x":1}', "{"]) assert.strictEqual(decodeResponse(v), undefined, String(v));
  });
});

describe("handler cells: the suite (#191)", () => {
  it("knows the two ways `bynk eval --suite` says the unit has no unit-tier suite", () => {
    assert.ok(noUnitSuite("`todos` has no unit suite for a snippet to be built into: its suites are of another tier, and a snippet is evaluated at the unit tier"));
    assert.ok(noUnitSuite("there is no suite for `todos` to build the snippet into"));
    assert.ok(!noUnitSuite("`--suite nope` is not the unit being evaluated (`todos`)"));
    assert.ok(!noUnitSuite("TypeError: Cannot read properties of undefined"));
  });
  it("says which it ran in, and warns about stubs only when both could stub", () => {
    assert.match(suiteNote("todos", true, false), /unit-tier suite of `todos`/);
    assert.ok(!/same operation/.test(suiteNote("todos", true, false)));
    assert.match(suiteNote("todos", true, true), /the suite's stub is the one that answers/);
    assert.match(suiteNote("todos", false, true), /Ran without a suite/);
  });
});

describe("handler cells: inserting a call (#191)", () => {
  it("makes an empty cell a handler cell", () => {
    const t = withCall("", 'api.GET("/x") by Visitor', "expression");
    assert.ok(t.startsWith("// @handler\n"));
    assert.ok(t.includes('let response <- api.GET("/x") by Visitor\n'));
    assert.strictEqual(cellKindOf(t).kind, "handler");
  });
  it("puts the directive ahead of what a plain cell has, and the call after it", () => {
    const t = withCall("stub A.b(_) returns 1\n\n", "svc.GET() by Visitor", "expression");
    assert.strictEqual(t, "// @handler\nstub A.b(_) returns 1\nlet response <- svc.GET() by Visitor\n");
  });
  it("names each inserted response afresh, so two calls in a cell do not bind one name twice", () => {
    const one = withCall("", "svc.GET() by Visitor", "expression");
    const two = withCall(one, "svc.POST() by Visitor", "handler");
    const three = withCall(two, "svc.PUT() by Visitor", "handler");
    assert.ok(two.endsWith("let response2 <- svc.POST() by Visitor\n"));
    assert.ok(three.endsWith("let response3 <- svc.PUT() by Visitor\n"));
    assert.strictEqual([...three.matchAll(/let (response\d*) </g)].map((m) => m[1]).join(), "response,response2,response3");
  });
  it("adds only the call to a handler cell", () => {
    assert.strictEqual(withCall("// @handler\nstub A.b(_) returns 1", "svc.GET() by Visitor", "handler"), "// @handler\nstub A.b(_) returns 1\nlet response <- svc.GET() by Visitor\n");
  });
});

describe("handler cells: the typed call for a route (#191)", () => {
  const TODO: WcType = {
    name: "Todo",
    codecSuffix: "Todo",
    provenance: { kind: "Owned" },
    loc: null,
    body: {
      kind: "Record",
      fields: [
        { name: "title", shape: { kind: "Named", name: "Title" }, pathSegment: "title", default: null },
        { name: "done", shape: { kind: "Base", base: "Bool", json: "Boolean", guards: [], expected: { kind: "Json", json: "Boolean" } }, pathSegment: "done", default: null },
        { name: "note", shape: str, pathSegment: "note", default: '""' },
      ],
    },
  };
  const TITLE: WcType = { name: "Title", codecSuffix: "Title", provenance: { kind: "Owned" }, loc: null, body: { kind: "Scalar", base: "String", json: "String", opaque: false, predicates: ["NonEmpty"], baseGuards: [], revalidation: "ViaConstructor" } };
  const ID: WcType = { name: "TodoId", codecSuffix: "TodoId", provenance: { kind: "Owned" }, loc: null, body: { kind: "Scalar", base: "String", json: "String", opaque: true, predicates: [], baseGuards: [], revalidation: "ViaConstructor" } };
  const route = (over: Partial<PromoteRoute>): PromoteRoute => ({
    unit: "todos",
    service: "api",
    method: "POST",
    path: "/todos",
    model: { envelope: { kind: "Empty" }, types: [TODO, TITLE, ID], instantiations: [], success: null },
    ...over,
  });

  it("writes a body as a record of sample values, leaving defaulted fields out", () => {
    const r = route({ model: { envelope: { kind: "Bare", param: "body", shape: { kind: "Named", name: "Todo" } }, types: [TODO, TITLE, ID], instantiations: [], success: null } });
    assert.deepStrictEqual(writeCall(r, "Visitor"), { text: 'api.POST("/todos", Todo { title: "sample", done: true }) by Visitor', holes: [] });
  });
  it("writes path parameters and a body in the order the handler takes them", () => {
    const r = route({
      method: "PUT",
      path: "/todos/:id",
      model: { envelope: { kind: "Keyed", params: [{ name: "id", shape: { kind: "Named", name: "TodoId" } }, { name: "body", shape: { kind: "Named", name: "Todo" } }] }, types: [TODO, TITLE, ID], instantiations: [], success: null },
    });
    assert.strictEqual(writeCall(r, undefined)?.text, 'api.PUT("/todos/:id", TodoId.unsafe("sample"), Todo { title: "sample", done: true })');
  });
  it("writes a call with no arguments, and one with `headers`", () => {
    assert.strictEqual(writeCall(route({ method: "GET", path: "/me" }), 'User("sample")')?.text, 'api.GET("/me") by User("sample")');
    const withHeaders = route({ model: { envelope: { kind: "Keyed", params: [{ name: "headers", shape: { kind: "Unit" } }] }, types: [], instantiations: [], success: null } });
    assert.strictEqual(writeCall(withHeaders, undefined)?.text, 'api.POST("/todos", RequestHeaders.of([]))');
  });
  it("samples a list and an integer", () => {
    const r = route({
      model: { envelope: { kind: "Keyed", params: [{ name: "n", shape: int }, { name: "tags", shape: { kind: "Inst", key: "L" } }] }, types: [], instantiations: [{ kind: "ListInst", key: "L", elem: str }], success: null },
    });
    assert.strictEqual(writeCall(r, undefined)?.text, 'api.POST("/todos", 1, ["sample"])');
  });
  it("leaves a hole, with the reason, for what has no literal", () => {
    const r = route({ model: { envelope: { kind: "Bare", param: "body", shape: { kind: "Inst", key: "M" } }, types: [], instantiations: [{ kind: "MapInst", key: "M", mapKey: str, val: str }], success: null } });
    const c = writeCall(r, "Visitor")!;
    assert.match(c.text, /^api\.POST\("\/todos", _ \/\* body: a map, a result or a generic type has no literal here \*\/\) by Visitor$/);
    assert.strictEqual(c.holes.length, 1);
  });
  it("cannot write a raw body, or a call to a route with no service", () => {
    assert.strictEqual(writeCall(route({ model: { envelope: { kind: "Raw", param: "b", contentType: "text/plain" }, types: [], instantiations: [], success: null } }), undefined), undefined);
    assert.strictEqual(writeCall(route({ service: undefined }), undefined), undefined);
  });
  it("writes the actor clause by the identity's type", () => {
    assert.strictEqual(actorClause("Visitor", undefined), "Visitor");
    assert.strictEqual(actorClause("User", undefined), 'User("sample")');
    assert.strictEqual(actorClause("User", "String"), 'User("sample")');
    assert.strictEqual(actorClause("User", "Int"), "User(1)");
    assert.strictEqual(actorClause("User", "UserId"), 'User(UserId.unsafe("sample"))');
  });
});
