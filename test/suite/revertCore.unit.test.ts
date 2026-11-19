// Unit coverage for the revert flow's pure core (#222 Part 1): the argument
// list (never an override flag), the dry run's parsing against a document
// recorded from `bynk revert --dry-run --format json` v0.639.1, the outcome
// classes, and the confirmation text.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import {
  confirmation,
  credentialsMessage,
  formatRevertPlan,
  parseRevertPlan,
  refusalSummary,
  revertArgs,
  revertOutcome,
  revertScopeFor,
} from "../../src/revertCore";

const fixture = (n: string) => fs.readFileSync(path.resolve(__dirname, "../../../test/fixtures", n), "utf8");
const REFUSED = fixture("revert-refused.json"); // recorded from the pinned bynk
const READY = fixture("revert-plan.json"); // hand-written, same schema
const CREDS = fixture("revert-credentials.stderr.txt"); // recorded

const groups = [{ key: "core", contexts: ["shop.orders", "shop.catalogue"] }];

describe("revertArgs (#222)", () => {
  it("builds the dry run and the real run, and nothing that overrides a refusal", () => {
    assert.deepStrictEqual(revertArgs({ environment: "staging" }, "dryRun"), ["revert", "--dry-run", "--format", "json", "--env", "staging"]);
    assert.deepStrictEqual(revertArgs({ environment: "staging", worker: "core" }, "run"), ["revert", "--yes", "--env", "staging", "--worker", "core"]);
    assert.deepStrictEqual(revertArgs({ environment: "default", context: "shop.orders" }, "dryRun"), [
      "revert", "--dry-run", "--format", "json", "--env", "default", "--context", "shop.orders",
    ]);
    for (const mode of ["dryRun", "run"] as const) {
      const a = revertArgs({ environment: "e", context: "a.b", worker: "w" }, mode);
      for (const banned of ["--accept-schema-ahead", "--accept-secret-changes", "--to"]) assert.ok(!a.includes(banned), banned);
      assert.ok(!(a.includes("--context") && a.includes("--worker")), "mutually exclusive");
    }
    assert.ok(!revertArgs({ environment: "e" }, "dryRun").includes("--yes"), "no --yes before the confirmation");
  });
  it("refuses a name that would read as a flag", () => {
    assert.throws(() => revertArgs({ environment: "--yes" }, "run"));
    assert.throws(() => revertArgs({ environment: "e", worker: "--yes" }, "run"));
    assert.throws(() => revertArgs({ environment: "e", context: "a b" }, "run"));
  });
  it("turns a member of a group into the group's Worker", () => {
    assert.deepStrictEqual(revertScopeFor("shop.orders", groups), { target: { worker: "core" }, group: groups[0], member: true });
    assert.deepStrictEqual(revertScopeFor("core", groups).target, { worker: "core" });
    assert.deepStrictEqual(revertScopeFor("shop.payment", groups), { target: { context: "shop.payment" }, member: false });
  });
});

describe("revertOutcome (#222)", () => {
  it("parses the recorded refusal, keeping the CLI's words", () => {
    const o = revertOutcome({ code: 1, stdout: REFUSED, stderr: "" }, false);
    assert.strictEqual(o.kind, "refused");
    if (o.kind !== "refused") return;
    assert.strictEqual(o.plan.workers[0].checks[0].code, "bynk.revert.history_unplaceable");
    const text = formatRevertPlan(o.plan).join("\n");
    assert.ok(text.includes("refused: could not read the deployments"), text);
    assert.ok(text.endsWith("Refused: nothing was changed."));
    assert.match(refusalSummary(o.plan), /core: history/);
  });
  it("is ready only when everything is ok and the exit is 0", () => {
    assert.strictEqual(revertOutcome({ code: 0, stdout: READY, stderr: "" }, false).kind, "ready");
    assert.strictEqual(revertOutcome({ code: 1, stdout: READY, stderr: "" }, false).kind, "refused", "exit code counts");
    const bad = JSON.parse(READY);
    bad.workers[0].checks = [{ check: "secrets", code: "bynk.revert.secret_changed", subject: "core", verdict: "refused", detail: "x" }];
    assert.strictEqual(revertOutcome({ code: 0, stdout: JSON.stringify(bad), stderr: "" }, false).kind, "refused");
    const empty = { ...JSON.parse(READY), workers: [] };
    assert.strictEqual(revertOutcome({ code: 0, stdout: JSON.stringify(empty), stderr: "" }, false).kind, "refused", "no Worker: an unknown");
  });
  it("recognises missing credentials from the CLI's own message, and other failures", () => {
    const c = revertOutcome({ code: 1, stdout: "", stderr: CREDS }, false);
    assert.strictEqual(c.kind, "credentials");
    assert.match(credentialsMessage(), /never stores, reads or asks/);
    const f = revertOutcome({ code: 1, stdout: "", stderr: "bynk: `x` is not recorded as deployed in environment `default`" }, false);
    assert.deepStrictEqual(f, { kind: "failed", detail: "bynk: `x` is not recorded as deployed in environment `default`" });
    assert.strictEqual(revertOutcome({ code: 1, stdout: "not json", stderr: "" }, false).kind, "failed");
    assert.strictEqual(revertOutcome({ code: null, stdout: "", stderr: "" }, true).kind, "cancelled");
  });
  it("rejects a document that is not a version 1 plan", () => {
    assert.throws(() => parseRevertPlan('{"version":2,"workers":[],"ok":true}'));
    assert.throws(() => parseRevertPlan("[]"));
  });
});

describe("confirmation (#222)", () => {
  const plan = parseRevertPlan(READY);
  it("names the environment, the Workers, a group's members and the command", () => {
    const c = confirmation({ environment: "default", worker: "core" }, plan, groups);
    assert.match(c.title, /Revert core in "default"\?/);
    assert.match(c.detail, /Environment: default \(reads as production\)/);
    assert.match(c.detail, /core: v2 → v1 \(a Worker group: shop\.orders, shop\.catalogue all go back together\)/);
    assert.match(c.detail, /every member goes back together/);
    assert.match(c.detail, /bynk\.deploy\.lock will change/);
    assert.match(c.detail, /`bynk revert --yes --env default --worker core`/);
  });
  it("asks for a typed confirmation only for a production-like environment", () => {
    assert.strictEqual(confirmation({ environment: "default" }, plan, groups).typed, "default");
    const staging = { ...plan, environment: "staging" };
    assert.strictEqual(confirmation({ environment: "staging" }, staging, groups).typed, undefined);
    assert.strictEqual(confirmation({ environment: "production" }, { ...plan, environment: "production" }, []).typed, "production");
  });
  it("does not describe a plain Worker as a group", () => {
    const c = confirmation({ environment: "staging" }, { ...plan, environment: "staging" }, []);
    assert.ok(!/Worker group/.test(c.detail));
  });
});
