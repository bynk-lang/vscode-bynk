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
  serviceDrift,
  splitDottedKey,
  worstDrift,
} from "../../src/environmentsCore";
import { parseMigrateStatus } from "../../src/migrationsCore";
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
