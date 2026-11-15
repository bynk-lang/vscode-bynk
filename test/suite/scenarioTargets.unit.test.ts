// #159: running a scenario against a `[test.targets]` target, the pure part:
// reading the manifest's targets, mapping a context to a URL, the confirmation
// and the production guard for writes, and keeping credentials out of results.

import * as assert from "assert";

import { parseScenario, runSteps, type RunHost, type Sent } from "../../src/scenarioCore";
import {
  confirmationFor,
  isLocalUrl,
  isNonIdempotent,
  isProductionLike,
  literalCredential,
  parseTargets,
  targetBase,
  workerName,
  writeSteps,
  type TestTarget,
} from "../../src/scenarioTargetsCore";

const TOML = `[project]
name = "shop"

[test.targets.preview]   # a preview deployment
url.shop-orders = "https://shop-orders-preview.example.workers.dev/"
url."shop-payments" = 'https://shop-payments-preview.example.workers.dev'
secrets = ["AUTH_JWT_SECRET", "OTHER"]
vars = { PAYMENTS_PROCESSOR = "fake" }

[test.targets.live]
url = { shop-orders = "https://shop-orders.example.com" }
production = true

[test.targets.staging.url]
shop-orders = "https://staging.example.com"

[test.targets.multi]
secrets = [
  "A", # first
  "B",
]
url.x = "http://127.0.0.1:9"

[other]
production = true
`;

function target(over: Partial<TestTarget> = {}): TestTarget {
  return { name: "preview", urls: { "shop-orders": "https://o.example" }, secrets: [], production: false, ...over };
}

describe("Scenario targets (#159)", () => {
  describe("parseTargets", () => {
    const targets = parseTargets(TOML);
    const by = (n: string): TestTarget => targets.find((t) => t.name === n)!;

    it("reads each table, in file order", () => {
      assert.deepStrictEqual(targets.map((t) => t.name), ["preview", "live", "staging", "multi"]);
    });
    it("reads the dotted, quoted, inline and sub-table forms of url", () => {
      assert.deepStrictEqual(by("preview").urls, {
        "shop-orders": "https://shop-orders-preview.example.workers.dev/",
        "shop-payments": "https://shop-payments-preview.example.workers.dev",
      });
      assert.deepStrictEqual(by("live").urls, { "shop-orders": "https://shop-orders.example.com" });
      assert.deepStrictEqual(by("staging").urls, { "shop-orders": "https://staging.example.com" });
    });
    it("reads the secret names, including a multi-line array, and the production flag", () => {
      assert.deepStrictEqual(by("preview").secrets, ["AUTH_JWT_SECRET", "OTHER"]);
      assert.deepStrictEqual(by("multi").secrets, ["A", "B"]);
      assert.strictEqual(by("live").production, true);
      assert.strictEqual(by("preview").production, false);
    });
    it("ignores keys of other tables", () => {
      assert.ok(!targets.some((t) => t.name === "other"));
    });
  });

  describe("targetBase", () => {
    it("maps a unit to its worker's URL, without a trailing slash", () => {
      assert.strictEqual(workerName("shop.orders"), "shop-orders");
      assert.deepStrictEqual(targetBase(target({ urls: { "shop-orders": "https://o.example/" } }), "shop.orders"), { base: "https://o.example" });
    });
    it("reports a context the target does not serve, naming what it serves", () => {
      const r = targetBase(target(), "shop.payments");
      assert.ok("error" in r);
      assert.match(r.error, /no URL for `shop-payments`/);
      assert.match(r.error, /serves `shop-orders`/);
    });
    it("refuses a URL with credentials, or a scheme that is not http(s)", () => {
      const withUser = targetBase(target({ urls: { shop: "https://u:p@o.example" } }), "shop");
      assert.ok("error" in withUser && /carries credentials/.test(withUser.error));
      assert.ok(!JSON.stringify(withUser).includes("u:p"));
      const ftp = targetBase(target({ urls: { shop: "ftp://o.example" } }), "shop");
      assert.ok("error" in ftp && /http or https/.test(ftp.error));
      assert.ok("error" in targetBase(target({ urls: { shop: "not a url" } }), "shop"));
    });
  });

  describe("the production guard", () => {
    const steps = parseScenario(`@context shop

### list
GET /items

### add
POST /items

### drop
DELETE /items/1
`).steps;

    it("classes the methods", () => {
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) assert.ok(isNonIdempotent(m), m);
      for (const m of ["GET", "HEAD"]) assert.ok(!isNonIdempotent(m), m);
    });
    it("finds the writes in a run, or in the steps run", () => {
      assert.deepStrictEqual(writeSteps(steps).map((s) => s.name), ["add", "drop"]);
      assert.deepStrictEqual(writeSteps(steps, new Set(["list", "add"])).map((s) => s.name), ["add"]);
    });
    it("reads production by the flag or the name", () => {
      assert.ok(isProductionLike(target({ production: true })));
      for (const name of ["prod", "production", "live", "Prod"]) assert.ok(isProductionLike(target({ name })), name);
      assert.ok(!isProductionLike(target({ name: "preview" })));
    });
    it("asks to type the target's name when a production-like target would be written to", () => {
      const live = target({ name: "live", production: true });
      const ask = confirmationFor(live, steps, writeSteps(steps), ["https://o.example"]);
      assert.strictEqual(ask?.kind, "typed");
      assert.strictEqual(ask?.phrase, "live");
      assert.match(ask?.message ?? "", /POST \/items, DELETE \/items\/1/);
    });
    it("only confirms a read-only run of a production-like target, and a run of any other target", () => {
      const live = target({ name: "live", production: true });
      assert.strictEqual(confirmationFor(live, [steps[0]], [], ["https://o.example"])?.kind, "confirm");
      assert.match(confirmationFor(live, [steps[0]], [], ["https://o.example"])?.message ?? "", /reads as production/);
      const preview = confirmationFor(target(), steps, writeSteps(steps), ["https://o.example"]);
      assert.strictEqual(preview?.kind, "confirm");
      assert.ok(!/production/.test(preview?.message ?? ""));
    });
    it("asks nothing when no step has a URL to send to", () => {
      assert.strictEqual(confirmationFor(target({ production: true }), steps, writeSteps(steps), []), undefined);
    });
    it("asks nothing of a target that is the local machine", () => {
      assert.ok(isLocalUrl("http://127.0.0.1:9"));
      assert.ok(isLocalUrl("http://localhost:8787"));
      assert.ok(!isLocalUrl("https://o.example"));
      assert.strictEqual(confirmationFor(target(), steps, writeSteps(steps), ["http://127.0.0.1:9"]), undefined);
      // Unless it is marked production, wherever it is.
      assert.strictEqual(confirmationFor(target({ production: true }), steps, writeSteps(steps), ["http://127.0.0.1:9"])?.kind, "typed");
    });
  });

  describe("credentials", () => {
    it("finds a literal credential header and passes one that reads the environment", () => {
      const [bad, good, plain] = parseScenario(`@context shop

### a
GET /x
Authorization: Bearer abc

### b
GET /x
Authorization: {{env.TOKEN}}

### c
GET /x
Accept: application/json
`).steps;
      assert.strictEqual(literalCredential(bad), "Authorization");
      assert.strictEqual(literalCredential(good), undefined);
      assert.strictEqual(literalCredential(plain), undefined);
    });
  });

  describe("running against a target", () => {
    it("hides the target's declared secrets even when no step mentions them", async () => {
      const { steps } = parseScenario(`@context shop

### one
GET /x

? status == 200
`);
      const sent: Sent = {
        method: "GET",
        url: "https://o.example/x",
        status: 200,
        statusText: "OK",
        ms: 1,
        headers: [],
        body: '{"echo":"jwt-signing-secret"}',
      };
      const host: RunHost = {
        env: { AUTH_JWT_SECRET: "jwt-signing-secret" },
        redactEnv: ["AUTH_JWT_SECRET", "UNSET"],
        cancelled: () => false,
        prepare: () => ({ base: "https://o.example", contentType: "application/json" }),
        send: async () => sent,
      };
      const [r] = await runSteps(steps, host);
      assert.strictEqual(r.state, "passed");
      assert.ok(!JSON.stringify(r).includes("jwt-signing-secret"), JSON.stringify(r));
      assert.ok(r.body?.includes("{{env.AUTH_JWT_SECRET}}"));
    });

    it("reports a step's target error without sending, and carries on", async () => {
      const { steps } = parseScenario(`@context shop

### one
GET /x

### two
GET /y
`);
      const requests: string[] = [];
      const host: RunHost = {
        env: {},
        cancelled: () => false,
        prepare: (s) => (s.name === "one" ? { error: "no URL" } : { base: "https://o.example", contentType: "application/json" }),
        send: async (req) => {
          requests.push(req.url);
          return { method: "GET", url: req.url, status: 200, statusText: "OK", ms: 1, headers: [], body: "{}" };
        },
      };
      const results = await runSteps(steps, host);
      assert.deepStrictEqual(results.map((r) => [r.step, r.state, r.message]), [["one", "error", "no URL"], ["two", "passed", undefined]]);
      assert.deepStrictEqual(requests, ["https://o.example/y"]);
    });
  });
});
