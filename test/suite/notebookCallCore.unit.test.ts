// #213: Insert Handler Call… for every handler kind: the picker's grouping, the
// call written for each kind, the cell run so a call's value comes back, a value
// that has none to show, and the checks offered when the cell is promoted.

import * as assert from "assert";

import { actorsFor, callChoices, websocketNote } from "../../src/notebookCallCore";
import { analyseCell, renderValue } from "../../src/notebookCore";
import { caseSource, handlerSource, noWireShape, renderNoValue, withCall } from "../../src/notebookHandlerCore";
import { planCase, renderCase, type CellOutput, type PromoteCell } from "../../src/notebookPromoteCore";
import type { HandlerInfo, RouteInfo } from "../../src/scenarioCore";
import { actorClause, writeHandlerCall } from "../../src/scenarioPromoteCore";
import type { WcRef, WcType } from "../../src/webview/wireContractTypes";

const str: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
const int: WcRef = { kind: "Base", base: "Int", json: "Number", guards: [], expected: { kind: "Integer" } };
const named = (name: string): WcRef => ({ kind: "Named", name });
const record = (name: string, fields: [string, WcRef][]): WcType => ({
  name,
  codecSuffix: name,
  provenance: { kind: "Owned" },
  body: { kind: "Record", fields: fields.map(([n, shape]) => ({ name: n, shape, pathSegment: n, default: null })) },
  loc: null,
});
const EMAIL = record("EmailJob", [["to", str], ["subject", str]]);
const PINGED = record("Pinged", [["id", str]]);

function handler(kind: HandlerInfo["kind"], envelope: HandlerInfo["model"]["envelope"], extra: Partial<HandlerInfo> = {}): HandlerInfo {
  return { unit: "jobs", service: "svc", kind, model: { envelope, types: [EMAIL, PINGED], instantiations: [] }, actors: [], identities: {}, ...extra };
}

describe("Insert Handler Call: the call written for each kind (#213)", () => {
  it("writes `svc.call(args)` with a sample for each parameter", () => {
    const h = handler("call", { kind: "Keyed", params: [{ name: "a", shape: int }, { name: "b", shape: str }] }, { service: "helper" });
    assert.deepStrictEqual(writeHandlerCall(h, undefined), { text: 'helper.call(1, "sample")', holes: [] });
    assert.strictEqual(writeHandlerCall(handler("call", { kind: "Empty" }), undefined)?.text, "svc.call()");
  });
  it("writes a cron call with the exact schedule expression, and the scheduled time when the handler takes it", () => {
    assert.strictEqual(writeHandlerCall(handler("cron", { kind: "Empty" }, { service: "sweeper", expr: "*/5 * * * *" }), undefined)?.text, 'sweeper.schedule("*/5 * * * *")');
    assert.strictEqual(writeHandlerCall(handler("cron", { kind: "Bare", param: "at", shape: int }, { service: "sweeper", expr: "0 * * * *" }), undefined)?.text, 'sweeper.schedule("0 * * * *", 1)');
    assert.strictEqual(writeHandlerCall(handler("cron", { kind: "Empty" }), undefined), undefined, "a cron handler with no schedule has nothing to call");
  });
  it("writes `svc.message(msg)` for a queue handler, the message built from its type", () => {
    const h = handler("queue", { kind: "Bare", param: "message", shape: named("EmailJob") }, { service: "outbox" });
    assert.strictEqual(writeHandlerCall(h, undefined)?.text, 'outbox.message(EmailJob { to: "sample", subject: "sample" })');
  });
  it("writes `svc.event(e)` for an event handler, leaving its envelope parameter to the default", () => {
    const bare = handler("event", { kind: "Bare", param: "e", shape: named("Pinged") }, { service: "OnPing" });
    assert.strictEqual(writeHandlerCall(bare, undefined)?.text, 'OnPing.event(Pinged { id: "sample" })');
    const withEnv = handler("event", { kind: "Keyed", params: [{ name: "e", shape: named("Pinged") }, { name: "env", shape: named("EventEnvelope") }] }, { service: "OnPing" });
    assert.strictEqual(writeHandlerCall(withEnv, undefined)?.text, 'OnPing.event(Pinged { id: "sample" })');
  });
  it("adds the `by` clause it is given, and says what it could not sample", () => {
    const h = handler("queue", { kind: "Bare", param: "message", shape: { kind: "Inst", key: "Map_x" } }, { service: "q" });
    const w = writeHandlerCall(h, actorClause("Clock", "ClockId"));
    assert.strictEqual(w?.text, 'q.message(_ /* message: a map, a result or a generic type has no literal here */) by Clock(ClockId.unsafe("sample"))');
    assert.strictEqual(w?.holes.length, 1);
  });
  it("does not write a WebSocket handler or a raw body", () => {
    assert.strictEqual(writeHandlerCall(handler("websocket", { kind: "Empty" }), undefined), undefined);
    assert.strictEqual(writeHandlerCall(handler("queue", { kind: "Raw", param: "body", contentType: "text/plain" }), undefined), undefined);
  });
});

describe("Insert Handler Call: the picker (#213)", () => {
  const route = (method: "GET" | "POST", path: string, unit = "jobs"): RouteInfo => ({ unit, method, path, service: "api", model: { envelope: { kind: "Empty" }, types: [], instantiations: [], success: null } });
  const handlers = [
    handler("queue", { kind: "Bare", param: "message", shape: named("EmailJob") }, { service: "outbox" }),
    handler("cron", { kind: "Empty" }, { service: "sweeper", expr: "*/5 * * * *" }),
    handler("event", { kind: "Bare", param: "e", shape: named("Pinged") }, { service: "OnPing" }),
    handler("call", { kind: "Keyed", params: [{ name: "a", shape: int }] }, { service: "helper" }),
    handler("websocket", { kind: "Empty" }, { service: "ChatGateway" }),
    handler("websocket", { kind: "Empty" }, { service: "ChatGateway" }),
    handler("cron", { kind: "Empty" }, { service: "elsewhere", expr: "0 0 * * *", unit: "other" }),
  ];
  const { choices, websocket } = callChoices([route("GET", "/a"), route("POST", "/b"), route("GET", "/z", "other")], handlers, (u) => u === "jobs");

  it("lists every handler of the unit, grouped by kind, HTTP first", () => {
    assert.deepStrictEqual(choices.map((c) => `${c.group}: ${c.label}`), [
      "HTTP: GET /a",
      "HTTP: POST /b",
      "on call: helper.call(…)",
      "Cron: sweeper.schedule(\"*/5 * * * *\")",
      "Queue: outbox.message(…)",
      "Events: OnPing.event(…)",
    ]);
    assert.strictEqual(choices.find((c) => c.group === "Queue")?.description, "message: EmailJob");
  });
  it("names the WebSocket services it leaves out, once each, and says why", () => {
    assert.deepStrictEqual(websocket, ["ChatGateway"]);
    assert.match(websocketNote(websocket), /ChatGateway.*not offered yet.*svc\.open\(tc/);
  });
  it("runs a non-HTTP call as an actor only when the actor carries an identity", () => {
    const plain = handler("call", { kind: "Empty" }, { actors: ["Backend"], identities: {} });
    const keyed = handler("cron", { kind: "Empty" }, { actors: ["Clock", "Backend"], identities: { Clock: "ClockId" } });
    assert.deepStrictEqual(actorsFor({ handler: plain }), []);
    assert.deepStrictEqual(actorsFor({ handler: keyed }), ["Clock"]);
    assert.deepStrictEqual(actorsFor({ route: { ...route("GET", "/a"), actors: ["Visitor"] } }), ["Visitor"]);
  });
});

describe("handler cells of other kinds: running the call (#213)", () => {
  const head = "// @handler\n";

  it("returns the call's value by ending the cell in its binding, and appends no match", () => {
    const { text, cell } = handlerSource(`${head}let r <- sweeper.schedule("*/5 * * * *")`);
    assert.strictEqual(text, `${head}let r <- sweeper.schedule("*/5 * * * *")\nr`);
    assert.deepStrictEqual(cell, { value: "r", rewritten: undefined, appendedFrom: 2 });
    assert.ok(!text.includes("match"));
  });
  it("binds a bare call on its own line, so the lines stay where they were", () => {
    const { text, cell } = handlerSource(`${head}outbox.message(EmailJob { to: "a", subject: "b" })`);
    assert.strictEqual(text, `${head}let response__ <- outbox.message(EmailJob { to: "a", subject: "b" })\nresponse__`);
    assert.strictEqual(cell.value, "response__");
    assert.strictEqual(cell.rewritten, 1);
  });
  it("covers `call`, `message` and `event`, and keeps an HTTP call's match for HTTP only", () => {
    for (const call of ['helper.call(1, "x")', 'outbox.message(m)', 'OnPing.event(e)']) assert.strictEqual(handlerSource(`${head}let r <- ${call}`).cell.value, "r", call);
    const http = handlerSource(`${head}let r <- api.GET("/x") by Visitor`);
    assert.strictEqual(http.cell.response, "r");
    assert.strictEqual(http.cell.value, undefined);
    assert.ok(http.text.includes("match r {"));
  });
  it("keeps `expect` lines ahead of the appended value, and leaves a cell ending in something else as written", () => {
    const withExpect = `${head}let r <- sweeper.schedule("x")\nexpect r is Ok(_)`;
    assert.strictEqual(handlerSource(withExpect).text, `${withExpect}\nr`);
    const own = `${head}let r <- helper.call(1, "x")\nr.n`;
    assert.deepStrictEqual(handlerSource(own), { text: own, cell: {} });
  });
  it("binds a bare call to a fresh name for a case, and says what it bound", () => {
    assert.deepStrictEqual(caseSource(`${head}let r <- helper.call(1, "x")`), { text: `${head}let r <- helper.call(1, "x")`, value: "r" });
    assert.deepStrictEqual(caseSource(`${head}let response <- x.y()\nOnPing.event(e)`), { text: `${head}let response <- x.y()\nlet response2 <- OnPing.event(e)`, value: "response2" });
    assert.strictEqual(caseSource(`${head}let r <- api.GET("/x")`).response, "r");
  });
  it("inserts a call of any kind into a cell the way an HTTP one is", () => {
    assert.strictEqual(withCall("", 'sweeper.schedule("*/5 * * * *")', "expression"), '// @handler\n// Add a `stub Cap.op(_) returns …` line above the call for each capability the handler uses.\nlet response <- sweeper.schedule("*/5 * * * *")\n');
    assert.strictEqual(analyseCell(withCall("", "svc.call()", "expression")).body.length, 1);
  });
});

describe("handler cells of other kinds: a value that cannot be shown (#213)", () => {
  it("reads bynk eval's refusal (v0.639.1) for the type it names, and nothing else", () => {
    assert.strictEqual(noWireShape("the snippet ran, but its value, of type `QueueResult`, has no wire shape to report"), "QueueResult");
    assert.strictEqual(noWireShape("the snippet ran, but its value, of type `HttpResult[Item]`, has no wire shape to report (see …)"), "HttpResult[Item]");
    assert.strictEqual(noWireShape("expect r is Ack failed"), undefined);
  });
  it("says plainly that there is no value to show", () => {
    assert.match(renderNoValue("QueueResult"), /The call ran\. Its value, of type `QueueResult`, has no wire shape.*no value to show/);
  });
});

describe("promote a handler cell of another kind (#213)", () => {
  const code = (source: string, output?: CellOutput): PromoteCell => ({ kind: "code", source, unit: "jobs", output });
  const plan = (cell: PromoteCell) => {
    const p = planCase([cell], 0, "jobs");
    assert.ok(p.ok, p.ok ? "" : p.reason);
    return p.plan;
  };
  const caseOf = (cell: PromoteCell): string => {
    const p = plan(cell);
    return renderCase(p, "c", new Set(p.offers.map((o) => o.id)));
  };

  it("offers `is Ok(_)` for a schedule, on the call's own binding", () => {
    const p = plan(code('// @handler\nlet r <- sweeper.schedule("*/5 * * * *")', { kind: "value", value: { kind: "Ok", value: null }, type: "Result[(), String]" }));
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect r is Ok(_)"]);
    const text = caseOf(code('// @handler\nlet r <- sweeper.schedule("*/5 * * * *")', { kind: "value", value: { kind: "Ok", value: null }, type: "Result[(), String]" }));
    assert.ok(text.includes('let r <- sweeper.schedule("*/5 * * * *")\n\t\texpect r is Ok(_)'), text);
    assert.ok(!text.includes("let result"), "the call is bound once");
  });
  it("offers `is Err(_)` when the schedule answered an error", () => {
    const p = plan(code('// @handler\nlet r <- sweeper.schedule("0 * * * *", 1)', { kind: "value", value: { kind: "Err", error: "bad hour" }, type: "Result[(), String]" }));
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect r is Err(_)"]);
  });
  it("binds a bare call and offers the value of an `on call` handler, one check per field", () => {
    const p = plan(code('// @handler\nhelper.call(1, "x")', { kind: "value", value: { id: "x", n: 1 }, type: "Ticket" }));
    assert.deepStrictEqual(p.offers.map((o) => o.line), ['expect response.id == "x"', "expect response.n == 1"]);
    const text = renderCase(p, "c", new Set(p.offers.map((o) => o.id)));
    assert.ok(text.includes('let response <- helper.call(1, "x")'), text);
  });
  it("offers one equality for a scalar value, never two for the same expression (bynk#3775)", () => {
    const p = plan(code("// @handler\nlet r <- helper.call(2)", { kind: "value", value: 7, type: "Int" }));
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect r == 7"]);
  });
  it("offers nothing for an event, which answers `()`", () => {
    const p = plan(code("// @handler\nlet r <- OnPing.event(Pinged { id: \"a\" })", { kind: "value", value: null, type: "()" }));
    assert.deepStrictEqual(p.offers, []);
  });
  it("offers each `QueueResult` variant for a message, since its verdict is not shown", () => {
    const cell = code('// @handler\nlet r <- outbox.message(EmailJob { to: "a", subject: "b" })', { kind: "none", type: "QueueResult" });
    const p = plan(cell);
    assert.deepStrictEqual(p.offers.map((o) => o.line), ["expect r is Ack", "expect r is Retry(_)"]);
    // Nothing is ticked for the user: the case writes only what is chosen.
    const picked = renderCase(p, "c", new Set([p.offers[0].id]));
    assert.ok(picked.includes("expect r is Ack") && !picked.includes("Retry"), picked);
  });
  it("offers nothing, and says why, for another type with no value to show", () => {
    const p = plan(code("// @handler\nlet r <- x.call()", { kind: "none", type: "HttpResult[Item]" }));
    assert.deepStrictEqual(p.offers, []);
    assert.ok(p.notCarried.some((n) => /HttpResult\[Item\].*cannot report/.test(n)), p.notCarried.join("|"));
  });
});

describe("handler cells of other kinds: showing and carrying (#213)", () => {
  it("shows a unit payload as `()`, as an `HttpResult`'s is", () => {
    assert.strictEqual(renderValue({ kind: "Ok", value: null }), "Ok(())");
    assert.strictEqual(renderValue({ kind: "Err", error: "bad hour" }), 'Err("bad hour")');
  });
  it("does not carry an earlier cell's call because both bind the same name", () => {
    const cells: PromoteCell[] = [
      { kind: "code", source: '// @handler\nlet response <- sweeper.schedule("*/5 * * * *")', unit: "jobs", output: { kind: "value", value: { kind: "Ok", value: null }, type: "Result[(), String]" } },
      { kind: "code", source: '// @handler\nlet response <- outbox.message(EmailJob { to: "a", subject: "b" })', unit: "jobs", output: { kind: "none", type: "QueueResult" } },
    ];
    const p = planCase(cells, 1, "jobs");
    assert.ok(p.ok);
    assert.deepStrictEqual(p.plan.usedCells, []);
    assert.ok(!p.plan.body.join("\n").includes("sweeper"));
  });
  it("still carries a chain: a name a carried `let` reads is needed even if the promoted cell rebinds it", () => {
    const cells: PromoteCell[] = [
      { kind: "code", source: "let response = 1", unit: "jobs" },
      { kind: "code", source: "let token = response + 1", unit: "jobs" },
      { kind: "code", source: "// @handler\nlet response <- helper.call(token)", unit: "jobs" },
    ];
    const p = planCase(cells, 2, "jobs");
    assert.ok(p.ok);
    assert.deepStrictEqual(p.plan.usedCells, [0, 1]);
  });
});
