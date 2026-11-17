// Unit coverage for the Environments view's pure core (#150): the
// `bynk.deploy.lock` reader (against a fixture in the driver's v0.614.0 ledger
// format), drift per context, migration warnings per environment, and the
// tree built from all three.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import {
  buildEnvironmentsTree,
  driftedContexts,
  type EnvTreeNode,
  migrationWarnings,
  parseDeployLock,
  sameContext,
  serviceDrift,
  splitDottedKey,
  workerKey,
  worstDrift,
} from "../../src/environmentsCore";
import { parseMigrateStatus } from "../../src/migrationsCore";
import { parseWorkerGroups } from "../../src/workerGroups";
import type { CdService } from "../../src/webview/contractDiffTypes";

const fixture = (name: string) => fs.readFileSync(path.resolve(__dirname, "../../../test/fixtures", name), "utf8");
const LOCK = fixture("deploy.lock");
const CLASSES = parseMigrateStatus(fixture("migrate-status.json"));

const row = (over: Partial<CdService>): CdService => ({
  environment: "default",
  context: "shop.payment",
  service: "authorise",
  status: "changed",
  live: "aaaaaaaaaaaaaaaa",
  current: "dddddddddddddddd",
  loc: null,
  ...over,
});

const find = (nodes: EnvTreeNode[], id: string): EnvTreeNode => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = n.children.length > 0 ? find(n.children, id) : undefined;
    if (inner) return inner;
  }
  return undefined as never;
};

describe("splitDottedKey", () => {
  it("splits bare and quoted parts", () => {
    assert.deepStrictEqual(splitDottedKey('environments.default.workers.shop-payment'), [
      "environments", "default", "workers", "shop-payment",
    ]);
    assert.deepStrictEqual(splitDottedKey('a."b.c".d'), ["a", "b.c", "d"]);
    assert.strictEqual(splitDottedKey("a..b"), undefined);
  });
});

describe("parseDeployLock", () => {
  it("reads each environment's Workers and contract hashes", () => {
    const envs = parseDeployLock(LOCK);
    assert.deepStrictEqual(envs.map((e) => e.name), ["default", "staging"]);
    const [orders, payment] = envs[0].workers;
    assert.deepStrictEqual(orders, { worker: "shop-orders", deployed: true, contracts: { place: "cccccccccccccccc" } });
    assert.deepStrictEqual(payment.contracts, { authorise: "aaaaaaaaaaaaaaaa", refund: "bbbbbbbbbbbbbbbb" });
    assert.strictEqual(envs[1].workers.length, 1);
  });

  it("leaves `contracts` undefined for a Worker an older driver pushed", () => {
    const [env] = parseDeployLock('version = 1\n[environments.default.workers.a]\ndeployed = true\n');
    assert.strictEqual(env.workers[0].contracts, undefined);
  });

  it("keeps an empty `contracts` table distinct from none", () => {
    const [env] = parseDeployLock('version = 1\n[environments.default.workers.a]\ndeployed = true\n[environments.default.workers.a.contracts]\n');
    assert.deepStrictEqual(env.workers[0].contracts, {});
  });

  it("refuses text with no version, as the driver does", () => {
    assert.throws(() => parseDeployLock("[environments.default]\n"));
  });

  it("reads an environment with no Workers", () => {
    assert.deepStrictEqual(parseDeployLock("version = 1\n[environments.prod]\nqueues = []\n"), [{ name: "prod", workers: [] }]);
  });
});

describe("drift", () => {
  it("prefers the compatibility verdict over a bare hash change", () => {
    assert.strictEqual(serviceDrift(row({})), "changed");
    assert.strictEqual(serviceDrift(row({ compat: { verdict: "breaking", reasons: [] } })), "breaking");
    assert.strictEqual(serviceDrift(row({ compat: { verdict: "compatible", reasons: [] } })), "compatible");
    assert.strictEqual(serviceDrift(row({ status: "added" })), "added");
    assert.strictEqual(serviceDrift(row({ status: "removed" })), "removed");
  });

  it("takes the worst state", () => {
    assert.strictEqual(worstDrift([]), "in-sync");
    assert.strictEqual(worstDrift(["compatible", "breaking", "added"]), "breaking");
  });
});

describe("migrationWarnings", () => {
  it("lists classes deployed to the environment whose floor or paths lag", () => {
    assert.deepStrictEqual(migrationWarnings(CLASSES, "staging").map((c) => c.class), ["shop.Cart"]);
    assert.deepStrictEqual(migrationWarnings(CLASSES, "elsewhere"), []);
  });

  it("does not warn for a class at its floor", () => {
    const [c] = CLASSES;
    assert.deepStrictEqual(migrationWarnings([{ ...c, floor: c.version, withoutPath: [] }], "default"), []);
  });
});

describe("buildEnvironmentsTree", () => {
  const status = { kind: "status" as const, classes: CLASSES };

  it("says so when there is no lock", () => {
    const [n] = buildEnvironmentsTree({ lock: undefined, drift: null, migrations: status });
    assert.match(n.label, /No bynk\.deploy\.lock/);
  });

  it("reports an unreadable lock", () => {
    const [n] = buildEnvironmentsTree({ lock: "garbage", drift: null, migrations: status });
    assert.match(n.label, /could not be read/);
  });

  it("has one node per recorded environment, with its contexts", () => {
    const tree = buildEnvironmentsTree({ lock: LOCK, drift: [], migrations: status });
    assert.deepStrictEqual(tree.map((n) => n.label), ["default", "staging"]);
    const ctx = tree[0].children.filter((c) => c.data.kind === "context").map((c) => c.label);
    assert.deepStrictEqual(ctx, ["shop.orders", "shop.payment"]);
    const svc = find(tree, "default/shop.payment/authorise");
    assert.match(svc.description ?? "", /aaaaaaaaaaaaaaaa/);
    assert.strictEqual(find(tree, "default/shop.payment").description, "deployed · in sync");
    assert.strictEqual(tree[0].description, "2 Workers · in sync");
    assert.strictEqual(driftedContexts(tree), 0);
  });

  it("marks drift per environment and context", () => {
    const tree = buildEnvironmentsTree({
      lock: LOCK,
      drift: [row({ compat: { verdict: "breaking", reasons: ["breaking response.at: x"] } }), row({ service: "refund", compat: { verdict: "compatible", reasons: [] } })],
      migrations: status,
    });
    const payment = find(tree, "default/shop.payment");
    assert.strictEqual(payment.description, "deployed · breaking change");
    assert.match(find(tree, "default/shop.payment/authorise").description ?? "", /breaking change/);
    assert.match(find(tree, "default/shop.payment/authorise").tooltip ?? "", /breaking response\.at/);
    assert.match(find(tree, "default/shop.payment/refund").description ?? "", /compatible change/);
    assert.strictEqual(tree[0].description, "2 Workers · 1 breaking");
    // The staging record is untouched by default's rows.
    assert.strictEqual(find(tree, "staging/shop.payment").description, "deployed · in sync");
    assert.strictEqual(driftedContexts(tree), 1);
  });

  it("lists a context only the working tree has as not deployed", () => {
    const tree = buildEnvironmentsTree({
      lock: LOCK,
      drift: [row({ context: "shop.shipping", service: "dispatch", status: "added", live: null })],
      migrations: status,
    });
    const shipping = find(tree, "default/shop.shipping");
    assert.strictEqual(shipping.description, "not deployed · new service");
    assert.strictEqual(find(tree, "default/shop.shipping/dispatch").label, "dispatch");
  });

  it("leaves drift out, rather than guessing, when the diff is unavailable", () => {
    const tree = buildEnvironmentsTree({ lock: LOCK, drift: null, migrations: status });
    assert.strictEqual(find(tree, "default/shop.payment").description, "deployed");
    assert.match(tree[0].description ?? "", /drift unknown/);
  });

  it("shows migration warnings only for the environment they are deployed to", () => {
    const tree = buildEnvironmentsTree({ lock: LOCK, drift: [], migrations: status });
    assert.strictEqual(find(tree, "default/migrations").children.length, 1);
    assert.strictEqual(find(tree, "default/migrations/shop.Cart").data.kind, "migrationClass");
    assert.match(find(tree, "default/migrations/shop.Cart").description ?? "", /no path from v1, v2/);
    assert.strictEqual(find(tree, "default/migrations").description, "1 class below current");
  });

  it("reports unavailable migrations instead of hiding them", () => {
    const tree = buildEnvironmentsTree({ lock: LOCK, drift: [], migrations: { kind: "unavailable", detail: "boom" } });
    assert.match(find(tree, "default/migrations-unavailable").label, /boom/);
  });

  it("carries the environment each action needs, and no flag-like value", () => {
    const tree = buildEnvironmentsTree({ lock: LOCK, drift: [], migrations: status });
    assert.deepStrictEqual(tree[1].data, { kind: "environment", environment: "staging" });
    assert.strictEqual(tree[0].contextValue, "bynkEnvironment");
    assert.strictEqual(find(tree, "default/shop.payment").contextValue, "bynkEnvContext");
  });
});

describe("context matching", () => {
  it("maps the dotted name to the Worker key, the driver's direction", () => {
    assert.strictEqual(workerKey("shop.payment"), "shop-payment");
    assert.ok(sameContext("shop.payment", "shop-payment"));
    assert.ok(!sameContext("shop.payment", "shop.pay-ment"));
  });

  it("keeps a hyphenated segment matched to its own Worker", () => {
    const lock = 'version = 1\n[environments.default.workers.a-b-c]\ndeployed = true\n[environments.default.workers.a-b-c.contracts]\nx = "1111111111111111"\n';
    const tree = buildEnvironmentsTree({
      lock,
      drift: [row({ context: "a.b-c", service: "x", compat: { verdict: "breaking", reasons: [] } })],
      migrations: { kind: "status", classes: [] },
    });
    assert.strictEqual(tree[0].children.filter((c) => c.data.kind === "context").length, 1);
    assert.match(tree[0].children[0].description ?? "", /breaking/);
  });
});

// #182: Worker groups, against the fixture project's manifest and ledger
// (test/fixtures/groups). The ledger's group record is `WorkerRecord` in
// bynk v0.639.1 `bynk/src/deploy/ledger.rs`: `contexts` and `script`, omitted
// for a context on a Worker of its own.
describe("Worker groups in the Environments view (#182)", () => {
  const dir = path.resolve(__dirname, "../../../test/fixtures/groups");
  const GROUP_LOCK = fs.readFileSync(path.join(dir, "bynk.deploy.lock"), "utf8");
  const GROUPS = parseWorkerGroups(fs.readFileSync(path.join(dir, "bynk.toml"), "utf8"));
  const unavailable = { kind: "unavailable", detail: "" } as const;
  const tree = (over: Partial<Parameters<typeof buildEnvironmentsTree>[0]> = {}) =>
    buildEnvironmentsTree({ lock: GROUP_LOCK, drift: null, migrations: unavailable, groups: GROUPS, ...over });

  it("reads a group Worker's members and script from the ledger, and none for another", () => {
    const [env] = parseDeployLock(GROUP_LOCK);
    const [core, payment] = env.workers;
    assert.deepStrictEqual(core, {
      worker: "core",
      deployed: true,
      contracts: { lookup: "aaaaaaaaaaaaaaaa" },
      contexts: ["shop.orders", "shop.catalogue"],
      script: "acme-core",
    });
    assert.deepStrictEqual(payment, { worker: "shop-payment", deployed: true, contracts: { authorise: "bbbbbbbbbbbbbbbb" } });
  });

  it("shows the group as one node holding its members, beside the context on its own Worker", () => {
    const [env] = tree();
    const [core, payment] = env.children;
    assert.strictEqual(core.label, "core");
    assert.strictEqual(core.contextValue, "bynkEnvWorker");
    assert.deepStrictEqual(core.data, { kind: "workerGroup", environment: "default", worker: "core", contexts: ["shop.orders", "shop.catalogue"], drift: "in-sync" });
    assert.match(core.description ?? "", /Worker group · 2 contexts · deployed/);
    assert.match(core.tooltip ?? "", /script acme-core/);
    assert.match(core.tooltip ?? "", /--worker core/);
    assert.deepStrictEqual(core.children.filter((c) => c.contextValue === "bynkEnvContext").map((c) => c.label), ["shop.orders", "shop.catalogue"]);
    assert.strictEqual(payment.contextValue, "bynkEnvContext");
    assert.strictEqual(payment.label, "shop.payment");
    assert.strictEqual(env.description?.startsWith("2 Workers"), true, "a group is one Worker");
  });

  it("is no longer a group of 'not deployed' contexts beside an unrecognised Worker", () => {
    // The old behaviour: with drift rows, members were looked up by their own dashed names.
    const rows = [row({ context: "shop.orders", service: "api", live: null, current: "x", status: "added" }), row({ context: "shop.catalogue", service: "lookup", live: "aaaaaaaaaaaaaaaa", current: "aaaaaaaaaaaaaaaa", status: "unchanged" as never })];
    const [env] = tree({ drift: rows });
    const labels = env.children.map((c) => c.label);
    assert.deepStrictEqual(labels.slice(0, 2), ["core", "shop.payment"]);
    assert.ok(!env.children.some((c) => c.description?.includes("not deployed") && c.data.kind === "context" && c.data.context !== "shop.payment"));
    const core = env.children[0];
    const orders = core.children.find((c) => c.label === "shop.orders");
    assert.match(orders?.description ?? "", /deployed/);
  });

  it("attributes the Worker's live contracts to the member the working tree says provides them", () => {
    const rows = [row({ context: "shop.catalogue", service: "lookup", status: "changed" })];
    const [env] = tree({ drift: rows });
    const core = env.children[0];
    assert.strictEqual(core.data.kind === "workerGroup" && core.data.drift, "changed");
    const catalogue = core.children.find((c) => c.label === "shop.catalogue");
    assert.deepStrictEqual(catalogue?.children.map((c) => c.label), ["lookup"]);
    assert.deepStrictEqual(core.children.find((c) => c.label === "shop.orders")?.children, []);
    assert.strictEqual(driftedContexts([env]), 1, "counts the member, not the group");
  });

  it("keeps a live service no member's row names on the group itself, and when drift is unknown", () => {
    const [env] = tree();
    const core = env.children[0];
    assert.deepStrictEqual(core.children.filter((c) => c.contextValue === "bynkEnvService").map((c) => c.label), ["lookup"]);
  });

  it("shows a group the environment has not deployed as undeployed, from the manifest", () => {
    const lock = "version = 1\n[environments.staging.workers.shop-payment]\ndeployed = true\n";
    const rows = [row({ environment: "staging", context: "shop.orders", service: "api", status: "added", live: null })];
    const [env] = tree({ lock, drift: rows });
    const core = env.children.find((c) => c.label === "core");
    assert.ok(core && core.data.kind === "workerGroup");
    assert.match(core.description ?? "", /not deployed/);
    assert.deepStrictEqual(core.children.map((c) => c.label), ["shop.orders", "shop.catalogue"]);
  });

  it("still shows a group from the ledger alone, when the manifest cannot be read", () => {
    const [env] = tree({ groups: undefined });
    assert.strictEqual(env.children[0].contextValue, "bynkEnvWorker");
    assert.deepStrictEqual(env.children[0].children.filter((c) => c.contextValue === "bynkEnvContext").map((c) => c.label), ["shop.orders", "shop.catalogue"]);
  });

  it("marks a member the Worker was not last pushed with", () => {
    const groups = [{ key: "core", contexts: ["shop.orders", "shop.catalogue", "shop.pricing"], name: "acme-core" }];
    const [env] = tree({ groups });
    const pricing = env.children[0].children.find((c) => c.label === "shop.pricing");
    assert.match(pricing?.description ?? "", /not deployed/);
  });

  it("counts a group member's agent classes as deployed where the group's Worker is", () => {
    // `bynk migrate status` keys deployment by the dashed context, which is no group's Worker.
    const classes = parseMigrateStatus(fixture("migrate-status.json")).slice(0, 1).map((c) => ({ ...c, class: "shop.orders.Cart", deployedTo: [] as string[] }));
    const [env] = tree({ migrations: { kind: "status", classes } });
    const migrations = env.children.find((c) => c.data.kind === "migrations");
    assert.deepStrictEqual(migrations?.children.map((c) => c.label), ["shop.orders.Cart"]);
  });

  it("leaves an ungrouped project's tree exactly as it was", () => {
    const base = buildEnvironmentsTree({ lock: LOCK, drift: [row({})], migrations: { kind: "status", classes: CLASSES } });
    const same = buildEnvironmentsTree({ lock: LOCK, drift: [row({})], migrations: { kind: "status", classes: CLASSES }, groups: [] });
    assert.deepStrictEqual(same, base);
  });
});
