// #182: Worker groups. The `[deploy.workers.<key>]` reader and the one
// context → Worker mapping every caller goes through, against the fixture
// project (test/fixtures/groups) and the formats of bynk v0.639.1
// (`bynk-project/src/worker_groups.rs`, `bynk/src/deploy/ledger.rs`).

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import { groupByKey, groupHolding, sameWorker, workerKey } from "../../src/contextNames";
import { groupedSweepIssue, parseWorkerGroups, resolveScope, scriptName, workerScopes } from "../../src/workerGroups";

const FIXTURE = path.resolve(__dirname, "../../../test/fixtures/groups");
const MANIFEST = fs.readFileSync(path.join(FIXTURE, "bynk.toml"), "utf8");

describe("parseWorkerGroups (#182)", () => {
  it("reads the fixture's group, with its script name override", () => {
    assert.deepStrictEqual(parseWorkerGroups(MANIFEST), [
      { key: "core", contexts: ["shop.orders", "shop.catalogue"], name: "acme-core" },
    ]);
  });

  it("is empty for a project with no [deploy.workers]", () => {
    assert.deepStrictEqual(parseWorkerGroups('[project]\nname = "p"\n\n[deploy]\nanything = "x"\n'), []);
    assert.deepStrictEqual(parseWorkerGroups(""), []);
  });

  it("reads several groups, a multi-line list, comments and literal strings", () => {
    const text = [
      "[deploy.workers.core]",
      "contexts = [",
      '  "shop.orders", # the first',
      "  'shop.pricing',",
      "]",
      "",
      "[deploy.workers.payments]",
      'contexts = ["shop.payment"]',
      'name = "acme-payments"  # script name',
      'routes = ["pay.example.com/*"]',
    ].join("\n");
    assert.deepStrictEqual(parseWorkerGroups(text), [
      { key: "core", contexts: ["shop.orders", "shop.pricing"] },
      { key: "payments", contexts: ["shop.payment"], name: "acme-payments" },
    ]);
  });

  it("reads dotted keys under [deploy.workers] and under [deploy], and inline tables", () => {
    assert.deepStrictEqual(parseWorkerGroups('[deploy.workers]\ncore.contexts = ["a.b"]\ncore.name = "c1"\n'), [
      { key: "core", contexts: ["a.b"], name: "c1" },
    ]);
    assert.deepStrictEqual(parseWorkerGroups('[deploy]\nworkers.core.contexts = ["a.b"]\n'), [{ key: "core", contexts: ["a.b"] }]);
    assert.deepStrictEqual(parseWorkerGroups('[deploy.workers]\ncore = { contexts = ["a.b", "a.c"], name = "n" }\n'), [
      { key: "core", contexts: ["a.b", "a.c"], name: "n" },
    ]);
  });

  it("does not read an array of tables' keys as the group's", () => {
    const text = '[deploy.workers.core]\ncontexts = ["a.b"]\n\n[[other]]\nname = "x"\ncontexts = ["z.z"]\n';
    assert.deepStrictEqual(parseWorkerGroups(text), [{ key: "core", contexts: ["a.b"] }]);
  });

  it("ignores other tables' keys and a group with no contexts", () => {
    assert.deepStrictEqual(parseWorkerGroups('[workers]\ncontexts = ["x.y"]\n\n[deploy.workers.empty]\nname = "n"\n'), []);
  });
});

describe("workerKey (#182)", () => {
  const groups = parseWorkerGroups(MANIFEST);

  it("keeps the dotted→hyphen rule for a context no group holds, and without groups", () => {
    assert.strictEqual(workerKey("shop.payment", groups), "shop-payment");
    assert.strictEqual(workerKey("shop.orders"), "shop-orders");
    assert.strictEqual(workerKey("shop.orders", []), "shop-orders");
  });

  it("names a member's Worker by its group's key, dotted or dashed, whatever the script name", () => {
    assert.strictEqual(workerKey("shop.orders", groups), "core");
    assert.strictEqual(workerKey("shop-catalogue", groups), "core");
    assert.strictEqual(scriptName(groups[0]), "acme-core");
    assert.strictEqual(scriptName({ key: "core", contexts: ["a.b"] }), "core");
  });

  it("finds a group by key or member, and compares Workers", () => {
    assert.strictEqual(groupByKey("core", groups)?.key, "core");
    assert.strictEqual(groupByKey("shop-orders", groups), undefined);
    assert.strictEqual(groupHolding("shop.payment", groups), undefined);
    assert.ok(parseWorkerGroups(MANIFEST).length === 1);
    assert.ok(sameWorker("shop.orders", "shop.catalogue", groups));
    assert.ok(!sameWorker("shop.orders", "shop.payment", groups));
    assert.ok(!sameWorker("shop.orders", "shop.catalogue"), "without groups they are two Workers");
  });
});

describe("workerScopes and resolveScope (#182)", () => {
  const groups = parseWorkerGroups(MANIFEST);
  const contexts = ["shop.catalogue", "shop.orders", "shop.payment"];

  it("offers a group as one choice and the other contexts singly", () => {
    const scopes = workerScopes(contexts, groups);
    assert.deepStrictEqual(
      scopes.map((s) => [s.kind, s.value]),
      [
        ["worker", "core"],
        ["context", "shop.payment"],
      ],
    );
    assert.match(scopes[0].description, /shop\.orders, shop\.catalogue.*acme-core/);
  });

  it("offers every context when there are no groups", () => {
    assert.deepStrictEqual(
      workerScopes(contexts, []).map((s) => s.value),
      contexts,
    );
  });

  it("turns a member into its group's Worker, as `--context` of a member is refused", () => {
    const member = resolveScope("shop.orders", groups);
    assert.ok(member.kind === "worker" && member.worker === "core" && member.member);
    const key = resolveScope("core", groups);
    assert.ok(key.kind === "worker" && key.worker === "core" && !key.member);
    assert.deepStrictEqual(resolveScope("shop.payment", groups), { kind: "context", context: "shop.payment" });
    assert.deepStrictEqual(resolveScope("shop-payment", []), { kind: "context", context: "shop-payment" });
  });
});

describe("groupedSweepIssue (#182, bynk-lang/bynk#3686)", () => {
  const groups = parseWorkerGroups(MANIFEST);

  it("refuses a sweep of a group member or of the group, naming the upstream issue", () => {
    assert.match(groupedSweepIssue("shop.orders", [], groups) ?? "", /Worker group `core`.*bynk-lang\/bynk#3686/);
    assert.match(groupedSweepIssue("core", [], groups) ?? "", /bynk#3686/);
  });

  it("refuses the whole project only when a grouped member has classes", () => {
    assert.match(groupedSweepIssue("", ["shop.orders", "shop.payment"], groups) ?? "", /shop\.orders.*bynk#3686/);
    assert.strictEqual(groupedSweepIssue("", ["shop.payment"], groups), undefined);
  });

  it("leaves an ungrouped context, or a project with no groups, alone", () => {
    assert.strictEqual(groupedSweepIssue("shop.payment", [], groups), undefined);
    assert.strictEqual(groupedSweepIssue("shop.orders", ["shop.orders"], []), undefined);
    assert.strictEqual(groupedSweepIssue("", ["shop.orders"], []), undefined);
  });
});
