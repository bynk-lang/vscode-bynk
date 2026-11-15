// #149: request scenarios, the pure part: parsing a `.bynk-http` file, captures,
// expectations, running (with a fake host), contract validation, and writing.

import * as assert from "assert";

import {
  appendStep,
  checkExpectations,
  formatStep,
  parseExpectation,
  parseScenario,
  pathMatches,
  redact,
  resolveRoute,
  runSteps,
  stepsNeededFor,
  substitute,
  validateStep,
  validateValue,
  type Outcome,
  type RouteInfo,
  type RunHost,
  type Sent,
  type Step,
} from "../../src/scenarioCore";
import type { WcRef, WcType } from "../../src/webview/wireContractTypes";

const SCENARIO = `# Create an item, read it, change it.
@context shop

### create
POST /items
Content-Type: application/json

{ "name": "widget", "qty": 2 }

? status == 201
? body.id exists

### fetch
GET /items/{{create.body.id}}
? status == 200
? body.name == "widget"

### update
@context other
PUT /items/{{create.body.id}}
Authorization: Bearer {{env.TOKEN}}
Content-Type: application/json

{ "name": "widget",
  "qty": 3 }

? header content-type contains "json"
`;

describe("parseScenario (#149)", () => {
  const s = parseScenario(SCENARIO);

  it("reads the steps, their requests, bodies and expectations", () => {
    assert.deepStrictEqual(s.problems, []);
    assert.strictEqual(s.context, "shop");
    assert.deepStrictEqual(
      s.steps.map((x) => [x.name, x.method, x.path, x.context, x.expects.length]),
      [
        ["create", "POST", "/items", "shop", 2],
        ["fetch", "GET", "/items/{{create.body.id}}", "shop", 2],
        ["update", "PUT", "/items/{{create.body.id}}", "other", 1],
      ],
    );
    assert.strictEqual(s.steps[0].body?.text, '{ "name": "widget", "qty": 2 }');
    assert.strictEqual(s.steps[2].body?.text, '{ "name": "widget",\n  "qty": 3 }');
    assert.deepStrictEqual(s.steps[2].headers.map((h) => h.name), ["Authorization", "Content-Type"]);
    assert.strictEqual(s.steps[1].body, undefined);
  });

  it("keeps line numbers for diagnostics and lenses", () => {
    assert.deepStrictEqual(s.steps.map((x) => x.line), [3, 12, 17]);
    assert.strictEqual(s.steps[0].requestLine, 4);
    assert.strictEqual(s.steps[0].body?.line, 7);
    assert.strictEqual(s.steps[0].expects[0].line, 9);
    assert.strictEqual(s.steps[0].endLine, 10);
  });

  it("reports what it can't read, and carries on", () => {
    const bad = parseScenario(
      ["stray", "### one", "FETCH /x", "### one", "GET /y", "? status === 200", "? body.id exists 3", "? status == \"x\"", "### ", ""].join("\n"),
    );
    const msgs = bad.problems.map((p) => `${p.line}: ${p.message}`);
    assert.ok(msgs.some((m) => m.startsWith("0: Expected `### name`")), msgs.join("\n"));
    assert.ok(msgs.some((m) => m.startsWith("2: Expected a request line")));
    assert.ok(msgs.some((m) => m.startsWith("3: There is already a step named `one`")));
    assert.ok(msgs.some((m) => m.startsWith("5: Expected `? status == 200`")));
    assert.ok(msgs.some((m) => m.startsWith("6: `exists` takes no value")));
    assert.ok(msgs.some((m) => m.startsWith("7: A status is compared as a number")));
    assert.ok(msgs.some((m) => m.startsWith("8: A step needs a name")));
  });

  it("a step without a request line is a problem", () => {
    const p = parseScenario("### a\n# nothing here\n").problems;
    assert.ok(p.some((x) => x.message.includes("no request line")));
  });

  it("copes with CRLF and a file with no steps", () => {
    assert.deepStrictEqual(parseScenario("@context a\r\n\r\n### x\r\nGET /\r\n? status == 200\r\n").steps[0].expects.length, 1);
    assert.deepStrictEqual(parseScenario("").steps, []);
  });
});

describe("expectations (#149)", () => {
  const outcome: Outcome = {
    status: 201,
    headers: { "content-type": "application/json; charset=utf-8", location: "/items/7" },
    body: JSON.stringify({ id: 7, name: "widget", tags: ["a", "b"], nested: { ok: true } }),
  };
  const check = (src: string) => {
    const p = parseExpectation(src, 0);
    assert.ok("expectation" in p, JSON.stringify(p));
    return checkExpectations([p.expectation], outcome)[0];
  };

  it("compares status, body paths and headers", () => {
    assert.ok(check("status == 201").ok);
    assert.ok(!check("status == 200").ok);
    assert.ok(check("status != 404").ok);
    assert.ok(check("body.id == 7").ok);
    assert.ok(check("body.nested.ok == true").ok);
    assert.ok(check("body.tags[1] == \"b\"").ok);
    assert.ok(check("body.tags contains \"a\"").ok);
    assert.ok(check("body.name contains \"idg\"").ok);
    assert.ok(check("body.nested contains \"ok\"").ok);
    assert.ok(check("body.missing absent").ok);
    assert.ok(check("body.id exists").ok);
    assert.ok(check("header content-type contains \"json\"").ok);
    assert.ok(check("header Location == \"/items/7\"").ok);
    assert.ok(check("header x-nope absent").ok);
  });

  it("says what was found when it fails", () => {
    assert.strictEqual(check("status == 200").message, "status == 200, but found 201");
    assert.strictEqual(check("body.name == \"gadget\"").message, 'body.name == "gadget", but found "widget"');
    assert.strictEqual(check("body.nope exists").message, "body.nope exists, but there is nothing there");
    assert.ok(!check("body.nope == 1").ok, "a missing path is not equal to anything");
    assert.ok(!check("body.nope != 1").ok, "nor different: it is not there");
  });

  it("compares the whole body when the path is empty", () => {
    const text: Outcome = { status: 200, headers: {}, body: "pong" };
    const p = parseExpectation('body == "pong"', 0);
    assert.ok("expectation" in p);
    assert.ok(checkExpectations([p.expectation], text)[0].ok);
  });

  it("insists values are JSON", () => {
    assert.ok("error" in parseExpectation("body.name == widget", 0));
    assert.ok("error" in parseExpectation("header content-type contains json", 0));
    assert.ok("error" in parseExpectation("status == \"201\"", 0));
    assert.ok("error" in parseExpectation("status exists", 0));
    assert.ok("error" in parseExpectation("body.a[ == 1", 0));
  });
});

describe("captures (#149)", () => {
  const outcomes = new Map<string, Outcome>([
    ["create", { status: 201, headers: { location: "/items/7" }, body: '{"id":7,"name":"a b","list":[{"k":"v"}]}' }],
  ]);
  const sub = (t: string, env: Record<string, string> = {}) => {
    const secrets = new Map<string, string>();
    return { r: substitute(t, outcomes, env, secrets), secrets };
  };

  it("substitutes body paths, status, headers and the environment", () => {
    assert.deepStrictEqual(sub("/items/{{create.body.id}}").r, { text: "/items/7" });
    assert.deepStrictEqual(sub('{"n":"{{ create.body.name }}"}').r, { text: '{"n":"a b"}' });
    assert.deepStrictEqual(sub("{{create.body.list[0].k}}").r, { text: "v" });
    assert.deepStrictEqual(sub("{{create.status}}").r, { text: "201" });
    assert.deepStrictEqual(sub("{{create.header.Location}}").r, { text: "/items/7" });
    assert.deepStrictEqual(sub("Bearer {{env.T}}", { T: "s3cret" }).r, { text: "Bearer s3cret" });
  });

  it("returns the first reference it can't resolve", () => {
    assert.deepStrictEqual(sub("{{create.body.nope}}").r, { unresolved: "create.body.nope" });
    assert.deepStrictEqual(sub("{{other.body.id}}").r, { unresolved: "other.body.id" });
    assert.deepStrictEqual(sub("{{env.UNSET}}").r, { unresolved: "env.UNSET" });
    assert.deepStrictEqual(sub("{{what}}").r, { unresolved: "what" });
  });

  it("remembers environment values so they can be hidden", () => {
    const { secrets } = sub("{{env.T}}-{{env.U}}", { T: "abc123", U: "abc123xyz" });
    assert.strictEqual(redact("tok abc123xyz and abc123", secrets), "tok {{env.U}} and {{env.T}}");
  });

  it("finds the steps a step needs", () => {
    const s = parseScenario("### a\nGET /a\n### b\nGET /b/{{a.body.id}}\n### c\nGET /c\n### d\nGET /d/{{b.status}}\n").steps;
    assert.deepStrictEqual([...stepsNeededFor(s, "d")].sort(), ["a", "b", "d"]);
    assert.deepStrictEqual([...stepsNeededFor(s, "c")], ["c"]);
  });
});

describe("runSteps (#149)", () => {
  function host(
    answer: (req: { method: string; url: string; headers: [string, string][]; body?: string }) => Partial<Sent> | { error: string },
    env: Record<string, string> = {},
  ): { host: RunHost; sent: { method: string; url: string; headers: [string, string][]; body?: string }[] } {
    const sent: { method: string; url: string; headers: [string, string][]; body?: string }[] = [];
    return {
      sent,
      host: {
        env,
        cancelled: () => false,
        prepare: () => ({ base: "http://localhost:1234/", contentType: "application/json" }),
        send: async (req) => {
          sent.push(req);
          const a = answer(req);
          if ("error" in a) return a;
          return { method: req.method, url: req.url, status: 200, statusText: "OK", ms: 1, headers: [], body: "", ...a };
        },
      },
    };
  }
  const steps = (src: string): Step[] => parseScenario(src).steps;

  it("threads a captured value into later requests", async () => {
    const h = host((req) =>
      req.method === "POST"
        ? { status: 201, body: '{"id":"a/b"}', headers: [["Content-Type", "application/json"]] }
        : { body: '{"name":"widget"}' },
    );
    const r = await runSteps(steps(SCENARIO.replace("@context other\n", "")), h.host);
    assert.deepStrictEqual(r.map((x) => [x.step, x.state]), [["create", "passed"], ["fetch", "passed"], ["update", "skipped"]]);
    assert.strictEqual(h.sent[1].url, "http://localhost:1234/items/a/b");
    assert.strictEqual(h.sent[0].headers.filter(([k]) => k === "Content-Type").length, 1, "an explicit Content-Type isn't doubled");
  });

  it("skips what reads a failed step or a missing path, and carries on", async () => {
    const h = host(() => ({ status: 500, body: "{}" }));
    const src = "### a\nGET /a\n? status == 200\n### b\nGET /b/{{a.body.id}}\n### c\nGET /c\n### d\nGET /d/{{c.body.id}}\n";
    const r = await runSteps(steps(src), h.host);
    assert.deepStrictEqual(r.map((x) => x.state), ["failed", "skipped", "passed", "skipped"]);
    assert.strictEqual(r[1].message, "skipped: unresolved capture `a.body.id`");
    assert.strictEqual(r[3].message, "skipped: unresolved capture `c.body.id`");
    assert.strictEqual(h.sent.length, 2, "skipped steps are not sent");
    assert.strictEqual(r[0].message, "status == 200, but found 500");
  });

  it("runs only what a single step needs", async () => {
    const h = host(() => ({ body: '{"id":1}' }));
    const s = steps("### a\nGET /a\n### x\nGET /x\n### b\nGET /b/{{a.body.id}}\n");
    const r = await runSteps(s, h.host, stepsNeededFor(s, "b"));
    assert.deepStrictEqual(r.map((x) => x.step), ["a", "b"]);
  });

  it("sends the Content-Type for a body, and the base URL without a doubled slash", async () => {
    const h = host(() => ({}));
    await runSteps(steps("### a\nPOST /a\n\n{}\n"), h.host);
    assert.strictEqual(h.sent[0].url, "http://localhost:1234/a");
    assert.deepStrictEqual(h.sent[0].headers, [["Content-Type", "application/json"]]);
  });

  it("never shows an environment value", async () => {
    const h = host(
      (req) => ({ status: 401, body: `{"echo":"${req.headers.find(([k]) => k === "Authorization")?.[1]}"}` }),
      { TOKEN: "hunter2hunter2" },
    );
    const src = "### a\nGET /a/{{env.TOKEN}}\nAuthorization: Bearer {{env.TOKEN}}\n? status == 200\n? body.echo == \"nope\"\n";
    const [r] = await runSteps(steps(src), h.host);
    assert.strictEqual(r.state, "failed");
    const all = JSON.stringify(r);
    assert.ok(!all.includes("hunter2"), all);
    assert.ok(all.includes("{{env.TOKEN}}"));
    assert.strictEqual(h.sent[0].headers[0][1], "Bearer hunter2hunter2", "but it is what is sent");
  });

  it("does not leak an unset variable's neighbours either", async () => {
    const h = host(() => ({}), { A: "secretvalue" });
    const [r] = await runSteps(steps("### a\nGET /{{env.A}}/{{env.B}}\n"), h.host);
    assert.strictEqual(r.state, "skipped");
    assert.ok(!JSON.stringify(r).includes("secretvalue"));
    assert.strictEqual(r.message, "skipped: unresolved capture `env.B`");
  });

  it("reports a transport error and a step that can't be prepared", async () => {
    const a = host(() => ({ error: "Could not reach http://x: ECONNREFUSED" }));
    assert.strictEqual((await runSteps(steps("### a\nGET /a\n"), a.host))[0].state, "error");
    const b = host(() => ({}));
    b.host.prepare = () => ({ error: "The dev server isn't running." });
    const [r] = await runSteps(steps("### a\nGET /a\n"), b.host);
    assert.deepStrictEqual([r.state, r.message], ["error", "The dev server isn't running."]);
    assert.strictEqual(b.sent.length, 0);
  });

  it("stops sending once cancelled", async () => {
    const h = host(() => ({}));
    let n = 0;
    h.host.cancelled = () => n++ > 0;
    const r = await runSteps(steps("### a\nGET /a\n### b\nGET /b\n"), h.host);
    assert.deepStrictEqual(r.map((x) => x.state), ["passed", "skipped"]);
  });
});

// A trimmed `bynk/wireContract` model for `PUT /items/:id (id: String, body: Item)`.
const str: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
const int: WcRef = { kind: "Base", base: "Int", json: "Number", guards: ["Integral"], expected: { kind: "Json", json: "Number" } };
const field = (name: string, shape: WcRef, def: string | null = null) => ({ name, shape, pathSegment: name, default: def });
const ITEM: WcType = {
  name: "Item",
  codecSuffix: "Item",
  provenance: { kind: "Owned" },
  body: { kind: "Record", fields: [field("name", str), field("qty", int), field("note", str, '""')] },
  loc: null,
};
const SHAPE: WcType = {
  name: "Shape",
  codecSuffix: "Shape",
  provenance: { kind: "Owned" },
  body: {
    kind: "Sum",
    wireDiscriminant: "kind",
    memoryDiscriminant: "tag",
    variants: [
      { name: "Circle", payload: [field("r", int)] },
      { name: "Dot", payload: [] },
    ],
  },
  loc: null,
};

function route(unit: string, method: RouteInfo["method"], path: string, body?: WcRef): RouteInfo {
  return {
    unit,
    method,
    path,
    model: {
      envelope: body
        ? { kind: "Keyed", params: [{ name: "id", shape: str }, { name: "body", shape: body }] }
        : { kind: "Empty" },
      types: [ITEM, SHAPE],
      instantiations: [
        { kind: "ListInst", key: "List<Int>", elem: int },
        { kind: "OptionInst", key: "Option<Int>", inner: int },
      ],
    },
  };
}

describe("pathMatches / resolveRoute (#149)", () => {
  it("matches a path against a route, capturing segments", () => {
    assert.ok(pathMatches("/items/:id", "/items/7"));
    assert.ok(pathMatches("/items/:id", "/items/{{create.body.id}}"));
    assert.ok(pathMatches("/items", "/items/"));
    assert.ok(!pathMatches("/items/:id", "/items"));
    assert.ok(!pathMatches("/items/:id", "/items//"));
    assert.ok(!pathMatches("/things/:id", "/items/7"));
    assert.ok(pathMatches("/ping", "/ping?x=1"));
  });

  const routes = [
    route("shop", "POST", "/items"),
    route("other", "POST", "/items"),
    route("shop", "GET", "/items/:id"),
    route("shop", "GET", "/items/new"),
  ];

  it("never guesses between contexts", () => {
    const r = resolveRoute(routes, { method: "POST", path: "/items", context: undefined });
    assert.ok("error" in r);
    assert.ok(r.error.includes("shop, other") && r.error.includes("@context"), r.error);
  });

  it("a named context decides, in dotted or worker form", () => {
    const r = resolveRoute([route("a.b", "GET", "/x")], { method: "GET", path: "/x", context: "a-b" });
    assert.ok("route" in r);
    const miss = resolveRoute(routes, { method: "POST", path: "/items", context: "third" });
    assert.ok("error" in miss && miss.error.includes("shop, other"));
  });

  it("prefers the literal route, and reports an unknown route", () => {
    const r = resolveRoute(routes, { method: "GET", path: "/items/new", context: "shop" });
    assert.ok("route" in r && r.route.path === "/items/new");
    const none = resolveRoute(routes, { method: "DELETE", path: "/items/1", context: undefined });
    assert.ok("error" in none && none.error.includes("No handler serves"));
  });
});

describe("validateValue (#149)", () => {
  const env = { types: [ITEM, SHAPE], instantiations: route("a", "GET", "/").model.instantiations };
  const item: WcRef = { kind: "Named", name: "Item" };
  const v = (value: unknown, ref: WcRef = item) => validateValue(value, ref, env, "body");

  it("accepts a conforming record, with a defaulted field omitted", () => {
    assert.deepStrictEqual(v({ name: "a", qty: 1 }), []);
    assert.deepStrictEqual(v({ name: "a", qty: 1, note: "x" }), []);
  });

  it("reports missing and extra fields and wrong kinds", () => {
    assert.deepStrictEqual(v({ name: "a" }), ['body: missing "qty".']);
    assert.deepStrictEqual(v({ name: "a", qty: 1, extra: 1 }), ['body: "extra" isn\'t a field of Item.']);
    assert.deepStrictEqual(v({ name: 1, qty: "x" }), ["body.name: expected string, found a number.", "body.qty: expected number, found a string."]);
    assert.deepStrictEqual(v({ name: "a", qty: 1.5 }), ["body.qty: expected an integer, found 1.5."]);
    assert.deepStrictEqual(v([]), ["body: expected a Item object, found an array."]);
  });

  it("checks a sum by its discriminant", () => {
    const shape: WcRef = { kind: "Named", name: "Shape" };
    assert.deepStrictEqual(v({ kind: "Circle", r: 2 }, shape), []);
    assert.deepStrictEqual(v({ kind: "Dot" }, shape), []);
    assert.ok(v({ kind: "Square" }, shape)[0].includes('must be "Circle", "Dot"'));
    assert.deepStrictEqual(v({ kind: "Circle" }, shape), ['body: missing "r".']);
  });

  it("checks lists, options and maps", () => {
    assert.deepStrictEqual(v([1, 2], { kind: "Inst", key: "List<Int>" }), []);
    assert.deepStrictEqual(v([1, "x"], { kind: "Inst", key: "List<Int>" }), ["body[1]: expected number, found a string."]);
    assert.deepStrictEqual(v({ kind: "None" }, { kind: "Inst", key: "Option<Int>" }), []);
    assert.deepStrictEqual(v({ kind: "Some", value: 1 }, { kind: "Inst", key: "Option<Int>" }), []);
    assert.deepStrictEqual(v({ kind: "Some" }, { kind: "Inst", key: "Option<Int>" }), ['body: Some needs "value".']);
    assert.ok(v({ kind: "Maybe" }, { kind: "Inst", key: "Option<Int>" })[0].includes("kind must be"));
  });
});

describe("validateStep (#149)", () => {
  const body: WcRef = { kind: "Named", name: "Item" };
  const put = route("shop", "PUT", "/items/:id", body);
  const validate = (src: string, r: RouteInfo | null = put, before: string[] = ["create"], all: string[] = ["create", "this", "later"]) => {
    const s = parseScenario(`### this\n${src}`);
    const step = s.steps[0];
    const resolved = r ? resolveRoute([r], step) : undefined;
    return validateStep(step, resolved, new Set(before), new Set(all)).map((p) => p.message);
  };

  it("passes a body that matches the contract, capture and all", () => {
    assert.deepStrictEqual(validate('PUT /items/{{create.body.id}}\n\n{ "name": "w", "qty": {{create.body.qty}} }\n'), []);
    assert.deepStrictEqual(validate('PUT /items/1\n\n{ "name": "{{create.body.name}}", "qty": 1 }\n'), []);
  });

  it("reports a body that doesn't match, a missing body and a body where none is taken", () => {
    assert.deepStrictEqual(validate('PUT /items/1\n\n{ "name": "w" }\n'), ['body: missing "qty".']);
    assert.deepStrictEqual(validate("PUT /items/1\n"), ["`PUT /items/:id` takes a JSON body."]);
    const get = route("shop", "GET", "/items/:id");
    assert.deepStrictEqual(validate("GET /items/1\n\n{}\n", get), ["`GET /items/:id` takes no body."]);
    assert.ok(validate("PUT /items/1\n\n{ nope }\n")[0].startsWith("The body isn't valid JSON"));
  });

  it("a quoted capture is a string, not a wildcard", () => {
    assert.deepStrictEqual(validate('PUT /items/1\n\n{ "name": "w", "qty": "{{create.body.qty}}" }\n'), ["body.qty: expected number, found a string."]);
  });

  it("checks captures name earlier steps", () => {
    assert.deepStrictEqual(validate("GET /items/{{later.body.id}}\n", null), ["`later` runs after this step, so `{{later.body.id}}` has nothing yet."]);
    assert.deepStrictEqual(validate("GET /items/{{nope.body.id}}\n", null), ["There is no earlier step named `nope`."]);
    assert.ok(validate("GET /items/{{create.bogus}}\n", null)[0].includes("isn't"));
    assert.deepStrictEqual(validate("GET /items/{{env.X}}\n", null), []);
  });

  it("flags an unfilled path parameter and a route that isn't there", () => {
    assert.deepStrictEqual(validate("GET /items/:id\n", null), ["Fill in the path parameter `:id`."]);
    const s = parseScenario("### a\nGET /nope\n").steps[0];
    const msgs = validateStep(s, resolveRoute([put], s), new Set(), new Set(["a"])).map((p) => p.message);
    assert.deepStrictEqual(msgs, ["No handler serves `GET /nope`."]);
  });

  it("a raw route needs a body but isn't parsed as JSON", () => {
    const raw: RouteInfo = { unit: "shop", method: "POST", path: "/up", model: { envelope: { kind: "Raw", param: "body", contentType: "text/csv" }, types: [], instantiations: [] } };
    assert.deepStrictEqual(validate("POST /up\n\na,b\n1,2\n", raw), []);
    assert.deepStrictEqual(validate("POST /up\n", raw), ["`POST /up` takes a text/csv body."]);
  });
});

describe("saving a step (#149)", () => {
  const spec = { unit: "shop", method: "PUT" as const, path: "/items/7", headers: "# note\nAccept: */*\nAuthorization: Bearer abc\nX-Api-Key: k", body: '{\n  "name": "w"\n}', status: 200 };

  it("writes a step that parses back to what was saved, keeping credentials out", () => {
    const { text, env } = formatStep(spec, "put_items_7", undefined);
    assert.ok(!text.includes("abc") && !text.includes("X-Api-Key: k"), text);
    assert.deepStrictEqual(env, ["AUTHORIZATION", "X_API_KEY"]);
    const s = parseScenario(text);
    assert.deepStrictEqual(s.problems, []);
    const step = s.steps[0];
    assert.strictEqual(step.context, "shop");
    assert.deepStrictEqual(step.headers.map((h) => `${h.name}: ${h.value}`), ["Accept: */*", "Authorization: {{env.AUTHORIZATION}}", "X-Api-Key: {{env.X_API_KEY}}"]);
    assert.strictEqual(step.body?.text, '{\n  "name": "w"\n}');
    assert.deepStrictEqual(step.expects.map((e) => [e.subject.kind, e.value]), [["status", 200]]);
  });

  it("starts a file with its context, and appends with a blank line and a fresh name", () => {
    const first = appendStep("", { ...spec, headers: "", body: undefined, status: undefined, method: "GET", path: "/items" });
    assert.ok(first.text.startsWith("@context shop\n\n### get_items\nGET /items\n"));
    assert.strictEqual(first.text.split("\n")[first.line], "### get_items");
    const second = appendStep(first.text, { ...spec, headers: "", body: undefined, status: undefined, method: "GET", path: "/items" });
    assert.strictEqual(second.name, "get_items_2");
    assert.strictEqual(second.text.split("\n")[second.line], "### get_items_2");
    assert.strictEqual(second.text.split("\n").filter((l) => l.startsWith("@context")).length, 1, "the file's context is not repeated");
    const other = appendStep(second.text, { ...spec, unit: "other", headers: "", body: undefined, status: undefined, method: "POST", path: "/x" });
    assert.ok(other.text.includes("### post_x\n@context other\nPOST /x"));
    assert.deepStrictEqual(parseScenario(other.text).problems, []);
  });
});
