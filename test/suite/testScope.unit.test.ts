// Unit coverage for how the Test Explorer namespaces its items by project: the
// workspace can hold several Bynk projects, so a suite's id carries its project's
// root and a run's items are grouped by it. `src/testPlan.ts` imports no `vscode`.

import * as assert from "assert";

import { migrateLegacyPins } from "../../src/testSeeds";
import { caseKey, groupByProject, planRun, projectOf, scopeSuiteId, suiteNameOf } from "../../src/testPlan";

const A = "file:///work/a";
const B = "file:///work/b";
const unit = (root: string, name: string): string => scopeSuiteId(root, `bynk-test:unit:${name}`);

describe("project-scoped test ids", () => {
  it("prefixes a suite id with its project root, and reads it back", () => {
    const id = unit(A, "orders");
    assert.strictEqual(id, "file:///work/a|bynk-test:unit:orders");
    assert.strictEqual(projectOf(id), A);
    assert.strictEqual(projectOf(caseKey(id, "adds up")), A);
  });

  it("keeps two projects' same-named suites and cases distinct", () => {
    assert.notStrictEqual(unit(A, "orders"), unit(B, "orders"));
    assert.notStrictEqual(caseKey(unit(A, "orders"), "x"), caseKey(unit(B, "orders"), "x"));
  });

  it("leaves an unscoped id as it was", () => {
    assert.strictEqual(scopeSuiteId(undefined, "bynk-test:unit:orders"), "bynk-test:unit:orders");
    assert.strictEqual(projectOf("bynk-test:unit:orders"), undefined);
  });

  it("names the suite for the driver without the project", () => {
    assert.strictEqual(suiteNameOf(unit(A, "orders")), "orders");
    assert.strictEqual(suiteNameOf(scopeSuiteId("file:///c%3A/my%20proj", "bynk-test:integration:a:b")), "a:b");
    assert.strictEqual(suiteNameOf("bynk-test:unit:orders"), "orders");
  });

  it("splits a case key back into its suite id", () => {
    const key = caseKey(unit(A, "orders"), "a::b");
    assert.strictEqual(key.slice(0, key.indexOf("::")), unit(A, "orders"));
  });
});

describe("grouping a run's items by project", () => {
  it("groups refs by project, in first-seen order", () => {
    const groups = groupByProject([
      { suiteId: unit(B, "s"), name: "one" },
      { suiteId: unit(A, "s") },
      { suiteId: unit(B, "t"), name: "two" },
    ]);
    assert.deepStrictEqual([...groups.keys()], [B, A]);
    assert.strictEqual(groups.get(B)?.length, 2);
    assert.strictEqual(groups.get(A)?.length, 1);
  });

  it("keeps a single project's request in one group", () => {
    assert.strictEqual(groupByProject([{ suiteId: unit(A, "s"), name: "x" }, { suiteId: unit(A, "t") }]).size, 1);
  });

  it("groups nothing for no items", () => {
    assert.strictEqual(groupByProject([]).size, 0);
  });

  it("plans each project's share from only its own cases", () => {
    const all = [
      { suiteId: unit(A, "s"), name: "x" },
      { suiteId: unit(B, "s"), name: "x" },
    ];
    const groups = groupByProject([{ suiteId: unit(A, "s"), name: "x" }]);
    const plan = planRun(
      all.filter((c) => projectOf(c.suiteId) === A),
      { include: groups.get(A) },
      { coverage: false, remote: false, sets: true },
    );
    assert.deepStrictEqual(plan.wanted, [caseKey(unit(A, "s"), "x")]);
  });
});

describe("pins saved before ids were project-scoped", () => {
  const pin = { seed: "0x1", fingerprint: ["a"] };

  it("move under the only project", () => {
    const pins = new Map([["bynk-test:unit:s::c", pin]]);
    assert.strictEqual(migrateLegacyPins(pins, A), true);
    assert.deepStrictEqual([...pins.keys()], [`${A}|bynk-test:unit:s::c`]);
  });

  it("leave a pin that is already scoped alone", () => {
    const key = `${A}|bynk-test:unit:s::c`;
    const pins = new Map([[key, pin]]);
    assert.strictEqual(migrateLegacyPins(pins, B), false);
    assert.deepStrictEqual([...pins.keys()], [key]);
  });
});
