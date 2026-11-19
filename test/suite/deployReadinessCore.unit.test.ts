// Unit coverage for the deploy readiness core (#221): each check over recorded
// plan, contract-diff and migrate-status fixtures, the gate Deploy uses, the
// cache, and the panel's markup. The refusal text is recorded from bynk v0.639.1.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import { parseDeployPlan, planOutcome } from "../../src/deployPlan";
import {
  cacheKey,
  evaluateReadiness,
  gateFor,
  isAgentMoveRefusal,
  parseAgentMoves,
  ReadinessCache,
  renderReadinessHtml,
  verdictLine,
  type ReadinessCheck,
  type ReadinessInput,
} from "../../src/deployReadinessCore";
import { parseMigrateStatus } from "../../src/migrationsCore";
import type { CdModel, CdService } from "../../src/webview/contractDiffTypes";

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, "../../../test/fixtures", name), "utf8");
const PLAN = parseDeployPlan(fixture("deploy-plan.json"));
const REFUSAL = fixture("deploy-plan-agent-move.stderr.txt");
const LOCK = fixture("deploy.lock");
const CLASSES = parseMigrateStatus(fixture("migrate-status.json"));

const service = (over: Partial<CdService>): CdService => ({
  environment: "staging",
  context: "shop.payment",
  service: "authorise",
  status: "changed",
  live: "aaaaaaaaaaaaaaaa",
  current: "dddddddddddddddd",
  compat: { verdict: "compatible", reasons: [] },
  loc: null,
  ...over,
});
const model = (over: Partial<CdModel> = {}): CdModel => ({ lock: "read", ledger: "read", changes: [], services: [], ...over });

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  environment: "staging",
  target: { environment: "staging" },
  contracts: model(),
  plan: { kind: "plan", plan: { ...PLAN, orphans: { kv: [], workers: [], queues: [] }, contexts: PLAN.contexts.map((c) => ({ ...c, secrets: c.secrets.filter((s) => s.origin !== "declared"), secretsComplete: true })) }, warnings: "" },
  migrations: { kind: "status", classes: [] },
  lock: undefined,
  groups: [],
  tests: { kind: "ran", passed: 12, failed: 0, skipped: 0, stale: false },
  ...over,
});
const check = (report: { checks: ReadinessCheck[] }, id: string): ReadinessCheck => {
  const c = report.checks.find((x) => x.id === id);
  assert.ok(c, `a ${id} check`);
  return c;
};

describe("deploy readiness core (#221)", () => {
  it("is ready when every available check passes, and says the size check is unavailable", () => {
    const r = evaluateReadiness(input());
    assert.strictEqual(r.verdict, "ready");
    assert.deepStrictEqual(r.checks.map((c) => c.status), ["pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "unavailable"]);
    const size = check(r, "workerSize");
    assert.strictEqual(size.status, "unavailable");
    assert.match(size.summary, /not available with this bynk/);
    assert.strictEqual(verdictLine(r), "Ready to deploy to staging");
    assert.deepStrictEqual(gateFor(r), { kind: "allow" });
  });

  describe("contracts", () => {
    it("warns for a breaking service change in this environment only", () => {
      const rows = [
        service({ compat: { verdict: "breaking", reasons: ["breaking response.at: the caller requires a field"] } }),
        service({ environment: "default", context: "shop.orders", compat: { verdict: "breaking", reasons: [] } }),
      ];
      const c = check(evaluateReadiness(input({ contracts: model({ services: rows }) })), "contracts");
      assert.strictEqual(c.status, "warn");
      assert.deepStrictEqual(c.details, [
        "shop.payment.authorise: BREAKING for callers of what is live",
        "  breaking response.at: the caller requires a field",
      ]);
      assert.strictEqual(c.prominent, true);
      assert.strictEqual(c.fix?.target, "contractDiff");
    });
    it("passes a compatible change, and warns on a changed hash with no verdict or a removed service", () => {
      const ok = check(evaluateReadiness(input({ contracts: model({ services: [service({})] }) })), "contracts");
      assert.strictEqual(ok.status, "pass");
      assert.match(ok.summary, /compatible/);
      const unknown = check(evaluateReadiness(input({ contracts: model({ services: [service({ compat: null })] }) })), "contracts");
      assert.strictEqual(unknown.status, "warn");
      const gone = check(evaluateReadiness(input({ contracts: model({ services: [service({ status: "removed", current: null })] }) })), "contracts");
      assert.strictEqual(gone.status, "warn");
    });
    it("limits the rows to the deploy's scope", () => {
      const rows = [service({ compat: { verdict: "breaking", reasons: [] } })];
      const other = evaluateReadiness(input({ target: { environment: "staging", context: "shop.orders" }, contracts: model({ services: rows }) }));
      assert.strictEqual(check(other, "contracts").status, "pass");
      const worker = evaluateReadiness(
        input({ target: { environment: "staging", worker: "core" }, groups: [{ key: "core", contexts: ["shop.payment", "shop.orders"] }], contracts: model({ services: rows }) }),
      );
      assert.strictEqual(check(worker, "contracts").status, "warn");
    });
    it("is not checked without a ledger, a lock or a server, never passed", () => {
      const noLedger = evaluateReadiness(input({ contracts: model({ ledger: "absent", lock: "absent" }) }));
      assert.strictEqual(check(noLedger, "contracts").status, "unavailable");
      assert.strictEqual(check(noLedger, "schema").status, "unavailable");
      const noServer = evaluateReadiness(input({ contracts: { unavailable: "the language server is not running" } }));
      assert.strictEqual(check(noServer, "contracts").status, "unavailable");
      assert.match(check(noServer, "schema").summary, /language server/);
    });
  });

  describe("schema", () => {
    it("fails a breaking change, which bynk refuses to build, and blocks Deploy", () => {
      const changes: CdModel["changes"] = [
        { kind: "agent", unit: "shop.orders", name: "Cart", class: "breaking", lockedVersion: 2, detail: "field `total` changed type", loc: null },
        { kind: "event", unit: "shop.orders", name: "Placed", class: "compatible", lockedVersion: 1, detail: "added a field", loc: null },
      ];
      const r = evaluateReadiness(input({ contracts: model({ changes }) }));
      const c = check(r, "schema");
      assert.strictEqual(c.status, "fail");
      assert.deepStrictEqual(c.details, ["shop.orders.Cart (agent): field `total` changed type"]);
      assert.strictEqual(r.verdict, "blocked");
      assert.strictEqual(gateFor(r).kind, "block");
    });
    it("passes compatible changes and says how many", () => {
      const changes: CdModel["changes"] = [{ kind: "event", unit: "u", name: "E", class: "compatible", lockedVersion: 1, detail: "", loc: null }];
      const c = check(evaluateReadiness(input({ contracts: model({ changes }) })), "schema");
      assert.strictEqual(c.status, "pass");
      assert.match(c.summary, /1 compatible change/);
    });
  });

  describe("migrations", () => {
    it("warns for classes deployed to the environment whose records may be old", () => {
      const r = evaluateReadiness(input({ environment: "staging", target: { environment: "staging" }, migrations: { kind: "status", classes: CLASSES } }));
      const c = check(r, "migrations");
      assert.strictEqual(c.status, "warn");
      assert.ok(c.details.some((d) => d.startsWith("shop.Cart:")));
      assert.ok(!c.details.some((d) => d.startsWith("shop.Order:")), "Order is deployed nowhere");
      assert.strictEqual(c.fix?.target, "migrations");
    });
    it("passes when nothing deployed here lags, and is unavailable without a report", () => {
      const r = evaluateReadiness(input({ environment: "prod", target: { environment: "prod" }, migrations: { kind: "status", classes: CLASSES } }));
      assert.strictEqual(check(r, "migrations").status, "pass");
      const none = evaluateReadiness(input({ migrations: { kind: "unavailable", detail: "bynk is not installed" } }));
      assert.strictEqual(check(none, "migrations").status, "unavailable");
    });
    it("reads a group member's class as deployed where the ledger says", () => {
      const classes = parseMigrateStatus(
        JSON.stringify({ classes: [{ class: "shop.orders.Cart", version: 3, floor: 1, oldest_readable: 1, steps: [], without_path: [], deployed_to: [] }] }),
      );
      const lock = `version = 1\n\n[environments.staging.workers.core]\ndeployed = true\ncontexts = ["shop.orders"]\n`;
      const r = evaluateReadiness(
        input({ migrations: { kind: "status", classes }, lock, groups: [{ key: "core", contexts: ["shop.orders"] }] }),
      );
      assert.strictEqual(check(r, "migrations").status, "warn");
      const without = evaluateReadiness(input({ migrations: { kind: "status", classes }, lock: undefined, groups: [] }));
      assert.strictEqual(check(without, "migrations").status, "pass");
    });
  });

  describe("the plan: secrets, orphans, the plan itself", () => {
    it("warns on required secrets without a secrets file, naming them but no value", () => {
      const r = evaluateReadiness(input({ plan: { kind: "plan", plan: PLAN, warnings: "" } }));
      const c = check(r, "secrets");
      assert.strictEqual(c.status, "warn");
      assert.ok(c.details.includes("commerce-payment-staging: WEBHOOK_SECRET (required)"));
      assert.ok(c.details.includes("commerce-orders-staging: also reads secrets the compiler cannot name"));
      assert.ok(!c.details.some((d) => d.includes("STRIPE_KEY")), "a supplied secret is not a requirement");
      assert.strictEqual(c.fix?.target, "plan");
    });
    it("passes once a secrets file is chosen, without reading it", () => {
      const r = evaluateReadiness(
        input({ target: { environment: "staging", secretsFile: "/work/.env.staging" }, plan: { kind: "plan", plan: PLAN, warnings: "" } }),
      );
      const c = check(r, "secrets");
      assert.strictEqual(c.status, "pass");
      assert.match(c.summary, /not read here/);
      assert.strictEqual(r.scope.secretsFile, true);
      assert.ok(!JSON.stringify(r).includes(".env.staging"), "the path is not even carried");
    });
    it("warns on orphans and says the deploy deletes nothing", () => {
      const r = evaluateReadiness(input({ plan: { kind: "plan", plan: PLAN, warnings: "" } }));
      const c = check(r, "orphans");
      assert.strictEqual(c.status, "warn");
      assert.deepStrictEqual(c.details, [
        "Worker legacy-staging",
        "KV namespace KV of legacy-staging",
        "KV namespace KV_CARTS of commerce-orders-staging",
        "queue old-intake-staging",
      ]);
      assert.match(c.summary, /never prunes/);
      assert.strictEqual(c.fix?.target, "environments");
    });
  });

  describe("a context moving Worker script (bynk#3562, v0.639.1)", () => {
    it("parses the recorded refusal", () => {
      assert.ok(isAgentMoveRefusal(REFUSAL));
      assert.deepStrictEqual(parseAgentMoves(REFUSAL), [{ context: "shop.orders", agent: "Counter", from: "acme-core", to: "shop-orders" }]);
      assert.deepStrictEqual(parseAgentMoves("bynk: some other refusal"), []);
    });
    it("fails, blocks Deploy, and leaves the plan-only checks unavailable rather than passed", () => {
      const outcome = planOutcome({ code: 1, stdout: "", stderr: REFUSAL }, false);
      const r = evaluateReadiness(input({ plan: outcome }));
      const move = check(r, "workerMove");
      assert.strictEqual(move.status, "fail");
      assert.ok(move.details[0].includes("shop.orders (agent Counter): acme-core → shop-orders"));
      assert.ok(move.details.some((d) => d.includes("--accept-fresh-agent")));
      assert.strictEqual(check(r, "secrets").status, "unavailable");
      assert.strictEqual(check(r, "orphans").status, "unavailable");
      assert.strictEqual(r.verdict, "blocked");
      assert.strictEqual(gateFor(r).kind, "block");
    });
    it("recognises the code even if the wording around it changes", () => {
      const r = evaluateReadiness(input({ plan: { kind: "failed", detail: "bynk: bynk.deploy.agent_move_refused: reworded entirely" } }));
      assert.strictEqual(check(r, "workerMove").status, "fail");
    });
    it("reads the fresh-agent plan's new orphan field without trouble", () => {
      const plan = parseDeployPlan(fixture("deploy-plan-fresh-agent.json"));
      assert.deepStrictEqual(plan.orphans.workers, ["acme-core"]);
      const c = check(evaluateReadiness(input({ plan: { kind: "plan", plan, warnings: "" } })), "orphans");
      assert.strictEqual(c.status, "warn");
    });
  });

  describe("any other plan refusal", () => {
    it("fails the plan row with the driver's first line, and does not claim a move", () => {
      const r = evaluateReadiness(input({ plan: { kind: "failed", detail: "bynk: `bynk.deploy.lock` is corrupt\n  fix it by hand" } }));
      const p = check(r, "plan");
      assert.strictEqual(p.status, "fail");
      assert.match(p.summary, /`bynk\.deploy\.lock` is corrupt/);
      assert.strictEqual(check(r, "workerMove").status, "unavailable");
      assert.strictEqual(r.verdict, "blocked");
    });
    it("is not checked, and does not block, when the plan was not run", () => {
      const r = evaluateReadiness(input({ plan: { kind: "unavailable", reason: "bynk is not installed" } }));
      assert.deepStrictEqual(["plan", "secrets", "orphans", "workerMove"].map((id) => check(r, id).status), ["unavailable", "unavailable", "unavailable", "unavailable"]);
      assert.strictEqual(r.verdict, "ready");
    });
  });

  describe("tests", () => {
    it("warns with no run, with failures and with a stale pass; passes a current pass", () => {
      const status = (tests: ReadinessInput["tests"]) => check(evaluateReadiness(input({ tests })), "tests").status;
      assert.strictEqual(status({ kind: "none" }), "warn");
      assert.strictEqual(status({ kind: "ran", passed: 3, failed: 1, skipped: 0, stale: false }), "warn");
      assert.strictEqual(status({ kind: "ran", passed: 4, failed: 0, skipped: 0, stale: true }), "warn");
      assert.strictEqual(status({ kind: "ran", passed: 4, failed: 0, skipped: 2, stale: false }), "pass");
      assert.strictEqual(check(evaluateReadiness(input({ tests: { kind: "none" } })), "tests").fix?.target, "tests");
    });
  });

  describe("the gate", () => {
    it("puts a breaking contract first in the confirmation, and sets it apart in the panel", () => {
      const rows = [service({ compat: { verdict: "breaking", reasons: ["breaking response.at: x"] } })];
      const r = evaluateReadiness(input({ tests: { kind: "none" }, contracts: model({ services: rows }) }));
      const gate = gateFor(r);
      assert.ok(gate.kind === "confirm" && gate.warnings[0].startsWith("Breaking contract changes"));
      assert.ok(renderReadinessHtml(r).includes("check warn prominent"));
      assert.ok(!renderReadinessHtml(evaluateReadiness(input())).includes("prominent""));
    });
    it("asks for a confirmation naming the warnings, and blocks only on failures", () => {
      const warned = evaluateReadiness(input({ tests: { kind: "none" } }));
      const gate = gateFor(warned);
      assert.strictEqual(gate.kind, "confirm");
      assert.ok(gate.kind === "confirm" && gate.warnings[0].startsWith("Tests:"));
      assert.strictEqual(verdictLine(warned), "Deploy to staging: 1 warning");
      const both = evaluateReadiness(input({ tests: { kind: "none" }, plan: { kind: "failed", detail: "bynk: no" } }));
      assert.strictEqual(gateFor(both).kind, "block");
    });
  });

  describe("the cache", () => {
    it("keys by environment, scope and secrets-file path", () => {
      assert.notStrictEqual(cacheKey({ environment: "a" }), cacheKey({ environment: "b" }));
      assert.notStrictEqual(cacheKey({ environment: "a" }), cacheKey({ environment: "a", context: "x" }));
      assert.notStrictEqual(cacheKey({ environment: "a" }), cacheKey({ environment: "a", secretsFile: "/f" }));
      assert.strictEqual(cacheKey({ environment: "a", context: "x" }), cacheKey({ environment: "a", context: "x" }));
    });
    it("returns an entry until a source changes, and drops an answer a save overtook", () => {
      const cache = new ReadinessCache<string>();
      cache.set("k", "one");
      assert.strictEqual(cache.get("k"), "one");
      cache.invalidate();
      assert.strictEqual(cache.get("k"), undefined);
      const started = cache.state;
      cache.invalidate(); // a save while the check ran
      cache.set("k", "stale", started);
      assert.strictEqual(cache.get("k"), undefined);
      cache.set("k", "two");
      assert.deepStrictEqual(cache.keys(), ["k"]);
    });
  });

  describe("the panel", () => {
    it("lists every check with its fix link, escaped, and offers Continue only when given", () => {
      const r = evaluateReadiness(input({ tests: { kind: "none" }, plan: { kind: "failed", detail: "bynk: <img src=x onerror=1>" } }));
      const html = renderReadinessHtml(r, { continueLabel: "Show plan" });
      assert.ok(!html.includes("<img"), "escaped");
      assert.ok(html.includes('data-action="fix" data-target="tests"'));
      assert.ok(html.includes('data-action="continue"'));
      assert.ok(html.includes('data-action="recheck"'));
      assert.match(html, /Not checked/);
      assert.ok(!renderReadinessHtml(r).includes('data-action="continue"'));
      assert.ok(html.includes("blocked"));
    });
  });
});
