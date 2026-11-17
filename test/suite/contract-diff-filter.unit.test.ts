// #157: the Contract Diff panel's context / environment filter.

import * as assert from "assert";

import { applyFilter, filterLabel, hiddenSentence, isActive, matchesService, parseFilter } from "../../src/contractDiffFilter";
import type { CdModel, CdService } from "../../src/webview/contractDiffTypes";

const svc = (context: string, environment: string): CdService => ({
  environment,
  context,
  service: "Pay",
  status: "changed",
  live: "aaaaaaaa11",
  current: "bbbbbbbb22",
  loc: null,
});

const model: CdModel = {
  lock: "read",
  ledger: "read",
  changes: [{ kind: "event", unit: "shop.order", name: "Placed", class: "breaking", lockedVersion: 1, detail: "x", loc: null }],
  services: [svc("shop.payment", "staging"), svc("shop.payment", "prod"), svc("shop.cart", "staging")],
};

describe("contract diff filter for a Worker group (#182)", () => {
  const group = { context: "core", contexts: ["shop.payment", "shop.cart"], environment: "staging" };

  it("shows every member's services, and only in its environment", () => {
    assert.deepStrictEqual(
      applyFilter(model, group).model.services.map((s) => `${s.context}/${s.environment}`),
      ["shop.payment/staging", "shop.cart/staging"],
    );
    assert.ok(!matchesService(group, svc("shop.other", "staging")));
  });

  it("reads the members from an untrusted argument, dropping anything not a string list", () => {
    assert.deepStrictEqual(parseFilter(group), group);
    assert.deepStrictEqual(parseFilter({ context: "core", contexts: [1] }), { context: "core" });
    assert.deepStrictEqual(parseFilter({ context: "core", contexts: [] }), { context: "core" });
  });
});

describe("contract diff filter (#157)", () => {
  it("leaves the model untouched without an active filter", () => {
    for (const f of [undefined, null, {}, { context: "" }]) {
      const r = applyFilter(model, f);
      assert.strictEqual(r.model, model);
      assert.deepStrictEqual([r.hiddenChanges, r.hiddenServices], [0, 0]);
    }
  });

  it("filters by context and environment together", () => {
    const r = applyFilter(model, { context: "shop.payment", environment: "staging" });
    assert.deepStrictEqual(r.model.services, [model.services[0]]);
    assert.strictEqual(r.hiddenServices, 2);
  });

  it("filters by context alone or environment alone", () => {
    assert.strictEqual(applyFilter(model, { context: "shop.payment" }).model.services.length, 2);
    assert.strictEqual(applyFilter(model, { environment: "staging" }).model.services.length, 2);
  });

  it("matches a Worker key for a dotted context", () => {
    assert.ok(matchesService({ context: "shop-payment" }, svc("shop.payment", "prod")));
    assert.ok(!matchesService({ context: "shop.pay" }, svc("shop.payment", "prod")));
  });

  it("hides project-wide boundary changes under a filter, and counts them", () => {
    const r = applyFilter(model, { context: "shop.cart" });
    assert.deepStrictEqual(r.model.changes, []);
    assert.strictEqual(r.hiddenChanges, 1);
    assert.match(hiddenSentence(r.hiddenChanges, r.hiddenServices) ?? "", /2 other service contracts and 1 event and agent change/);
    assert.strictEqual(hiddenSentence(0, 0), null);
  });

  it("words the chip", () => {
    assert.strictEqual(filterLabel({ context: "shop.payment", environment: "staging" }), "Showing shop.payment in staging");
    assert.strictEqual(filterLabel({ context: "shop.payment" }), "Showing shop.payment");
    assert.strictEqual(filterLabel({ environment: "prod" }), "Showing environment prod");
  });

  it("parses untrusted arguments", () => {
    assert.deepStrictEqual(parseFilter({ context: "a", environment: "b", extra: 1 }), { context: "a", environment: "b" });
    for (const bad of [undefined, null, "file:///x", 3, {}, { context: 4 }, { context: "" }]) {
      assert.strictEqual(parseFilter(bad), undefined);
    }
    assert.ok(isActive({ environment: "x" }));
  });
});
