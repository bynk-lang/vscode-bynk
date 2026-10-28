// The tags `upsertCase` puts on a Testing-view case: its tier, and `doc-example`
// for a doc-comment example (#2461). A case can carry both, and a regression in
// either would quietly break the view's tag filter, hiding doc tests from a tier
// filter or tagging ordinary cases. `testPlan.unit.test.ts` covers *reading* the
// driver's `origin`; this covers applying it to the tree.
//
// Inside the extension host: `upsertCase` makes real `TestItem`s.

import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import type { JsonCase } from "../../src/testPlan";
import { upsertCase } from "../../src/testing";

describe("upsertCase tags", () => {
  const ROOT = vscode.Uri.file(path.join(os.tmpdir(), "bynk-case-tags-root"));
  let ctrl: vscode.TestController;
  let suite: vscode.TestItem;

  before(() => {
    ctrl = vscode.tests.createTestController("bynk-case-tags-test", "Case tags test");
  });
  after(() => ctrl.dispose());
  beforeEach(() => {
    ctrl.items.replace([]);
    suite = ctrl.createTestItem("shop.cart", "shop.cart");
    ctrl.items.add(suite);
  });

  const tagsOf = (c: Partial<JsonCase> & { name: string }): string[] =>
    upsertCase(ctrl, suite, { outcome: "discovered", ...c }, ROOT)
      .tags.map((t) => t.id)
      .sort();

  it("gives a doc example with a tier both its tier tag and doc-example", () => {
    assert.deepStrictEqual(tagsOf({ name: "a", tier: "integration", origin: "doc" }), [
      "doc-example",
      "integration",
    ]);
  });

  it("gives a doc example without a tier only doc-example", () => {
    assert.deepStrictEqual(tagsOf({ name: "b", origin: "doc" }), ["doc-example"]);
  });

  it("never gives an ordinary case doc-example", () => {
    assert.deepStrictEqual(tagsOf({ name: "c", tier: "unit" }), ["unit"]);
    assert.deepStrictEqual(tagsOf({ name: "d" }), []);
    // Only the driver's `origin` counts; another origin, or a name that looks
    // like a doc example's, does not.
    assert.deepStrictEqual(tagsOf({ name: "doc example", tier: "unit", origin: "other" }), ["unit"]);
  });
});
