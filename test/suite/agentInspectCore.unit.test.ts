// #145: the pure core of live agent inspection. The JSON below is
// `bynk dev inspect`'s own output as documented for bynk v0.639.1
// (`site/src/content/docs/docs/bynk-cli.md`, "Inspecting agents"; the shapes
// pinned by `bynk/src/dev_inspect.rs`); keep the two in step.

import * as assert from "assert";

import {
  faultText,
  historySteps,
  inspectAgentArgs,
  inspectAgentsArgs,
  inspectFailure,
  keyArgument,
  keyText,
  liveInstances,
  parseAgentInspection,
  parseAgentListing,
  renderWireValue,
  schemaStanding,
  stateOfCell,
  toInstanceView,
} from "../../src/agentInspectCore";

const LISTING = JSON.stringify({
  agents: [
    { context: "shop.orders", class: "Cart", key: "u1", id: "29bacc06" },
    { context: "shop.orders", class: "Cart", key: 7, id: "5f3e10c2" },
    { context: "shop.orders", class: "Ledger", key: { a: 1 }, id: "0d11" },
  ],
  errors: [{ context: "shop.pay", error: "answered 500" }],
});

const STATE = JSON.stringify({
  context: "shop.orders",
  class: "Cart",
  key: "u1",
  id: "29bacc06",
  exists: true,
  readable: true,
  version: 1,
  current: 2,
  layout: 2,
  migrationPending: true,
  cells: { status: { tag: "Placed" }, total: 4 },
  collections: { lines: { kind: "map", size: 2, entries: [{ key: "apple", value: { i: 0, v: 2 } }], next: "m/lines/apple" } },
  history: [
    { handler: null, old: null, new: { cells: { status: { tag: "Pending" }, total: 0 }, collections: { lines: 0 } }, at: 1700000000000 },
    {
      handler: "place",
      old: { cells: { status: { tag: "Pending" }, total: 0 }, collections: { lines: 0 } },
      new: { cells: { status: { tag: "Placed" }, total: 4 }, collections: { lines: 2 } },
      at: 1700000001000,
    },
  ],
});

describe("parseAgentListing", () => {
  it("reads the agents and the contexts that could not be asked", () => {
    const l = parseAgentListing(LISTING);
    assert.ok(l);
    assert.strictEqual(l.agents.length, 3);
    assert.deepStrictEqual(l.agents[1], { context: "shop.orders", class: "Cart", key: 7, id: "5f3e10c2" });
    assert.deepStrictEqual(l.errors, [{ context: "shop.pay", error: "answered 500" }]);
  });

  it("is total: nonsense is undefined, odd entries are skipped, new fields ignored", () => {
    assert.strictEqual(parseAgentListing("not json"), undefined);
    assert.strictEqual(parseAgentListing("[]"), undefined);
    assert.strictEqual(parseAgentListing('{"agents":3}'), undefined);
    const l = parseAgentListing('{"agents":[1,{"class":"A"},{"class":"A","key":"k","id":"x","extra":1}],"errors":[]}');
    assert.deepStrictEqual(l?.agents, [{ context: "", class: "A", key: "k", id: "x" }]);
  });
});

describe("parseAgentInspection", () => {
  it("reads a readable instance with its history", () => {
    const s = parseAgentInspection(STATE);
    assert.ok(s?.exists && s.readable);
    assert.strictEqual(s.version, 1);
    assert.strictEqual(s.current, 2);
    assert.strictEqual(s.migrationPending, true);
    assert.deepStrictEqual(s.cells.status, { tag: "Placed" });
    assert.strictEqual(s.collections.lines.size, 2);
    assert.strictEqual(s.collections.lines.next, "m/lines/apple");
    assert.strictEqual(s.history.length, 2);
    assert.strictEqual(s.history[0].handler, null, "a migration's commit has no handler");
    assert.strictEqual(s.history[0].old, null, "the first recorded commit has no old state");
    assert.strictEqual(s.history[1].handler, "place");
  });

  it("reads an instance with no stored state, and one this build cannot read", () => {
    const none = parseAgentInspection('{"context":"c","class":"Cart","key":"u","id":"i","exists":false}');
    assert.strictEqual(none?.exists, false);
    const bad = parseAgentInspection('{"context":"c","class":"Cart","key":"u","id":"i","exists":true,"readable":false,"fault":"NewerSchema"}');
    assert.ok(bad?.exists && !bad.readable);
    assert.strictEqual(bad.fault, "NewerSchema");
  });

  it("treats a missing history as none (a build before v0.633.2) and rejects nonsense", () => {
    const s = parseAgentInspection('{"class":"A","exists":true,"readable":true,"cells":{},"collections":{}}');
    assert.ok(s?.exists && s.readable);
    assert.deepStrictEqual(s.history, []);
    assert.strictEqual(s.version, null);
    assert.strictEqual(parseAgentInspection("{}"), undefined);
    assert.strictEqual(parseAgentInspection('{"class":"A","exists":true,"readable":true}'), undefined);
  });
});

describe("arguments", () => {
  it("lists one class, optionally in one context", () => {
    assert.deepStrictEqual(inspectAgentsArgs("Cart"), ["dev", "inspect", "agents", ".", "--class", "Cart"]);
    assert.deepStrictEqual(inspectAgentsArgs("Cart", "shop.orders").slice(-2), ["--context", "shop.orders"]);
  });

  it("gives a string key as it is and any other key as JSON", () => {
    assert.strictEqual(keyArgument("u1"), "u1");
    assert.strictEqual(keyArgument(7), "7");
    assert.strictEqual(keyArgument({ a: 1 }), '{"a":1}');
  });

  it("puts the positionals after `--`, so a key starting with `-` is still a key", () => {
    const args = inspectAgentArgs("Cart", "--path", { context: "shop.orders" });
    assert.deepStrictEqual(args, ["dev", "inspect", "agent", "--path", ".", "--context", "shop.orders", "--", "Cart", "--path"]);
  });
});

describe("renderWireValue", () => {
  it("renders in Bynk's terms", () => {
    assert.strictEqual(renderWireValue({ tag: "Pending" }), "Pending");
    assert.strictEqual(renderWireValue({ tag: "Ok", value: 42 }), "Ok(42)");
    assert.strictEqual(renderWireValue("hi"), '"hi"');
    assert.strictEqual(renderWireValue([1, { tag: "None" }]), "[1, None]");
    assert.strictEqual(renderWireValue({ a: 1, b: "x" }), '{ a: 1, b: "x" }');
    assert.strictEqual(renderWireValue(null), "null");
  });

  it("is bounded", () => {
    const long = renderWireValue(Array.from({ length: 500 }, (_, i) => `item-${i}`));
    assert.ok(long.length <= 240);
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = [deep];
    assert.ok(renderWireValue(deep).includes("…"));
  });

  it("names a key for the picker", () => {
    assert.strictEqual(keyText("u1"), "u1");
    assert.strictEqual(keyText(7), "7");
    assert.strictEqual(keyText({ a: 1 }), "{ a: 1 }");
  });
});

describe("stateOfCell", () => {
  const states = ["Pending", "Placed"];
  it("finds the constructor of a tagged value, or a bare string, among the machine's states", () => {
    assert.strictEqual(stateOfCell({ tag: "Placed" }, states), "Placed");
    assert.strictEqual(stateOfCell("Pending", states), "Pending");
    assert.strictEqual(stateOfCell({ tag: "Unknown" }, states), null);
    assert.strictEqual(stateOfCell(3, states), null);
    assert.strictEqual(stateOfCell(undefined, states), null);
  });
});

describe("history", () => {
  const entries = (() => {
    const s = parseAgentInspection(STATE);
    return s?.exists && s.readable ? s.history : [];
  })();

  it("reduces each step to the machine's move and what changed", () => {
    const steps = historySteps(entries, "status", ["Pending", "Placed"]);
    assert.strictEqual(steps[0].from, null);
    assert.strictEqual(steps[0].to, "Pending");
    assert.strictEqual(steps[1].from, "Pending");
    assert.strictEqual(steps[1].to, "Placed");
    assert.deepStrictEqual(steps[1].changes, [
      { cell: "status", before: "Pending", after: "Placed" },
      { cell: "total", before: "0", after: "4" },
    ]);
    assert.deepStrictEqual(steps[1].sizes, [{ field: "lines", before: 0, after: 2 }]);
    // The first commit: every cell is new.
    assert.deepStrictEqual(steps[0].changes[0], { cell: "status", before: undefined, after: "Pending" });
  });
});

describe("toInstanceView and liveInstances", () => {
  it("builds what the page shows", () => {
    const s = parseAgentInspection(STATE);
    assert.ok(s);
    const v = toInstanceView(s, [{ field: "status", states: ["Pending", "Placed"] }]);
    assert.ok(v.exists && v.readable);
    assert.deepStrictEqual(v.states, { status: "Placed" });
    assert.deepStrictEqual(v.cells, [
      { name: "status", text: "Placed" },
      { name: "total", text: "4" },
    ]);
    assert.deepStrictEqual(v.collections, [{ name: "lines", kind: "map", size: 2, shown: 1 }]);
    assert.strictEqual(v.history.length, 2);
    assert.deepStrictEqual(v.history[1].states, { status: { from: "Pending", to: "Placed" } });
    assert.deepStrictEqual(v.schema, { text: "schema v1, current v2; migration pending (shown as stored)", behind: true });
  });

  it("passes an absent or unreadable record through", () => {
    assert.deepStrictEqual(toInstanceView({ exists: false, context: "", class: "A", key: "k", id: "" }, []), { exists: false });
    const v = toInstanceView({ exists: true, readable: false, fault: "NewerSchema", context: "", class: "A", key: "k", id: "" }, []);
    assert.deepStrictEqual(v, { exists: true, readable: false, fault: "stored by a newer build (schema)" });
  });

  it("offers the instances of one class by key, in a stable order", () => {
    const l = parseAgentListing(LISTING);
    assert.ok(l);
    const carts = liveInstances(l, "Cart");
    assert.deepStrictEqual(carts.map((c) => c.key), ["7", "u1"]);
    assert.ok(carts.every((c) => c.ref.startsWith("Cart")));
    assert.deepStrictEqual(liveInstances(l, "Nothing"), []);
  });
});

describe("schemaStanding, faultText, inspectFailure", () => {
  it("compares the stored version with the class's", () => {
    assert.deepStrictEqual(schemaStanding(2, 2, false), { text: "schema v2 (current)", behind: false });
    assert.strictEqual(schemaStanding(1, 2, false).behind, true);
    assert.strictEqual(schemaStanding(null, 2, false).behind, false);
    assert.ok(schemaStanding(1, null, false).text.includes("no schema lock"));
  });

  it("words the faults", () => {
    assert.ok(faultText("NoMigrationPath").includes("migration"));
    assert.strictEqual(faultText(""), "unreadable");
  });

  it("passes on the CLI's own message", () => {
    assert.strictEqual(
      inspectFailure("bynk: no running `bynk dev` session for this project (start one with `bynk dev`)\n"),
      "no running `bynk dev` session for this project (start one with `bynk dev`)",
    );
    assert.strictEqual(inspectFailure(""), "bynk dev inspect failed");
  });
});
