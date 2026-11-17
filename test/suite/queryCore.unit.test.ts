// #148: the Bynk Query view's answers, over a hand-built architecture model.

import * as assert from "assert";

import type { ModelCoverage } from "../../src/modelCoverageCore";
import {
  capabilityChoices,
  capabilitiesQuery,
  eventsQuery,
  memberLabel,
  reachability,
  untestedQuery,
  type HandlerSite,
} from "../../src/queryCore";
import type { ArchHandlerUses, ArchLoc, ArchMember, ArchModel, ArchNode } from "../../src/webview/architectureTypes";
import type { AgentStateModel } from "../../src/webview/stateTypes";
import type { Range } from "../../src/webview/types";

const rng = (line: number, end = line): Range => ({ start: { line, character: 0 }, end: { line: end, character: 3 } });
const loc = (uri: string, line = 0): ArchLoc => ({ uri, range: rng(line) });

const member = (unit: string, kind: ArchMember["kind"], container: string, handler: string, line = 0): ArchMember => ({
  unit, kind, container, handler, loc: loc(`file:///${unit}.bynk`, line),
});
const uses = (m: ArchMember, caps: Array<[string, string | null, string[]?, boolean?]>, calls?: ArchHandlerUses["calls"]): ArchHandlerUses => ({
  member: m,
  uses: caps.map(([capability, from, stubs = [], inherited = false]) => ({
    capability, from, inherited, loc: m.loc, stubbedIn: stubs.map((suite) => ({ suite, loc: loc("file:///t.bynk") })),
  })),
  ...(calls ? { calls } : {}),
});
const node = (name: string, over: Partial<ArchNode> = {}): ArchNode => ({
  name, kind: "Context", loc: loc(`file:///${name}.bynk`), capabilities: [], providers: [], services: [], agents: [], ...over,
});

const place = member("shop", "service", "Orders", "POST /orders", 5);
const charge = member("shop", "agent", "Cart", "charge", 9);
const fetch = member("pay", "service", "Gateway", "authorise", 4);
const idle = member("pay", "service", "Gateway", "ping", 12);

function model(): ArchModel {
  return {
    nodes: [
      node("shop", {
        capabilities: [{ name: "Logger", local: false, from: "bynk", loc: loc("file:///shop.bynk", 1) }],
        providers: [{ capability: "Logger", providerName: "ConsoleLogger", external: false, loc: loc("file:///shop.bynk", 2) }],
        uses: [
          uses(place, [["Logger", "bynk", ["checkout suite"]]], [{ kind: "agent", unit: "shop", container: "Cart", handler: "charge", loc: loc("file:///shop.bynk", 6) }]),
          uses(charge, [], [{ kind: "service", unit: "pay", container: "Gateway", loc: loc("file:///shop.bynk", 10) }]),
        ],
      }),
      node("pay", {
        capabilities: [{ name: "Fetch", local: true, from: null, loc: loc("file:///pay.bynk", 1) }, { name: "Unused", local: true, from: null, loc: loc("file:///pay.bynk", 2) }],
        uses: [uses(fetch, [["Fetch", null, [], false]]), uses(idle, [])],
      }),
    ],
    edges: [],
    events: [
      {
        owner: "shop", name: "OrderPlaced", loc: loc("file:///shop.bynk", 20),
        emitters: [{ member: place, loc: loc("file:///shop.bynk", 7) }],
        subscribers: [{ member: member("pay", "service", "Billing", "on OrderPlaced"), delivery: "queue", loc: loc("file:///pay.bynk", 30) }],
      },
      { owner: "shop", name: "AAA", loc: loc("file:///shop.bynk", 21), emitters: [], subscribers: [] },
    ],
  };
}

describe("eventsQuery (#148)", () => {
  it("lists each event's emitters and subscribers, with how each is delivered", () => {
    const events = eventsQuery(model())!;
    assert.deepStrictEqual(events.map((e) => e.name), ["shop.AAA", "shop.OrderPlaced"]);
    assert.deepStrictEqual(events[1].emitters.map((r) => r.label), ["shop.Orders.POST /orders"]);
    assert.deepStrictEqual(events[1].subscribers.map((r) => [r.label, r.description]), [["pay.Billing.on OrderPlaced", "queue"]]);
    assert.deepStrictEqual(events[0].emitters, [], "an event nobody emits is still listed");
  });
  it("says it cannot tell from a server without events", () => {
    const m = model();
    delete m.events;
    assert.strictEqual(eventsQuery(m), undefined);
  });
});

describe("capabilitiesQuery (#148)", () => {
  const byUnit = Object.fromEntries(capabilitiesQuery(model()).map((c) => [c.unit, c]));
  it("lists what a context declares, consumes and provides, with its users and stubs", () => {
    const logger = byUnit.shop.rows.find((r) => r.capability === "Logger")!;
    assert.strictEqual(logger.from, "bynk");
    assert.deepStrictEqual(logger.providedBy, { name: "ConsoleLogger", external: false });
    assert.deepStrictEqual(logger.usedBy.map((r) => r.label), ["shop.Orders.POST /orders"]);
    assert.deepStrictEqual(logger.stubbedIn.map((r) => r.label), ["checkout suite"]);
  });
  it("lists a capability declared and never used, with no users", () => {
    const unused = byUnit.pay.rows.find((r) => r.capability === "Unused")!;
    assert.deepStrictEqual([unused.from, unused.usedBy], [null, []]);
    assert.deepStrictEqual(byUnit.pay.rows.find((r) => r.capability === "Fetch")!.usedBy.map((r) => r.label), ["pay.Gateway.authorise"]);
  });
  it("adds a capability a handler's given reaches that the unit's own table lacks", () => {
    const m = model();
    m.nodes[0].uses!.push(uses(charge, [["Clock", "bynk", [], true]]));
    const clock = capabilitiesQuery(m).find((c) => c.unit === "shop")!.rows.find((r) => r.capability === "Clock")!;
    assert.deepStrictEqual(clock.usedBy.map((r) => [r.label, r.description]), [["shop.Cart.charge", "inherited"]]);
  });
});

describe("reachability (#148)", () => {
  it("offers the capabilities some handler's given resolves to", () => {
    assert.deepStrictEqual(capabilityChoices(model()).map((c) => `${c.from ?? ""}/${c.capability}:${c.users}`), ["bynk/Logger:1", "/Fetch:1"]);
  });
  it("follows calls across contexts and through agents to every handler that can reach it", () => {
    const r = reachability(model(), { capability: "Fetch", from: null });
    assert.deepStrictEqual(
      r.reaching.map((x) => [x.row.label, x.direct, x.path]),
      [
        ["pay.Gateway.authorise", true, []],
        ["shop.Cart.charge", false, ["pay.Gateway.authorise"]],
        ["shop.Orders.POST /orders", false, ["shop.Cart.charge", "pay.Gateway.authorise"]],
      ],
    );
    assert.strictEqual(r.callsUnknown, false);
    // A handler that neither uses it nor calls toward it is not reported.
    assert.ok(!r.reaching.some((x) => x.row.label.endsWith("ping")));
  });
  it("calling a service reaches all of its handlers, and a cycle ends", () => {
    const m = model();
    // authorise calls back into the shop's agent: a cycle.
    m.nodes[1].uses![0].calls = [{ kind: "agent", unit: "shop", container: "Cart", handler: "charge", loc: loc("file:///pay.bynk") }];
    const r = reachability(m, { capability: "Fetch", from: null });
    assert.strictEqual(r.reaching.length, 3);
    const viaPing = model();
    viaPing.nodes[0].uses![1].calls = [{ kind: "service", unit: "pay", container: "Gateway", loc: loc("file:///shop.bynk") }];
    assert.ok(reachability(viaPing, { capability: "Fetch", from: null }).reaching.some((x) => x.row.label === "shop.Cart.charge"));
  });
  it("says so when the server sends no calls, listing only the direct uses", () => {
    const m = model();
    for (const n of m.nodes) for (const h of n.uses ?? []) delete h.calls;
    const r = reachability(m, { capability: "Fetch", from: null });
    assert.strictEqual(r.callsUnknown, true);
    assert.deepStrictEqual(r.reaching.map((x) => x.row.label), ["pay.Gateway.authorise"]);
  });
  it("names a member by unit, container and handler", () => {
    assert.strictEqual(memberLabel(place), "shop.Orders.POST /orders");
  });
});

describe("untestedQuery (#148)", () => {
  const cov = (ran: number[], missed: number[]): ModelCoverage => ({ runAt: 1, scope: "the whole project", stale: false, ran, missed });
  // Handlers' whole declarations, in 1-based lines 6-9 (the route), 10-12 and 20-22.
  const sites: HandlerSite[] = [
    { member: place, range: rng(5, 8), protocol: "http" },
    { member: charge, range: rng(9, 11), protocol: undefined },
    { member: fetch, range: rng(19, 21), protocol: "http" },
    { member: idle, range: null },
  ];
  const agent: AgentStateModel = {
    agent: "Cart", range: rng(8), handlers: [], effects: [],
    machines: [{
      field: "status", fieldRange: rng(9), states: ["New", "Paid"], initial: "New", reachable: ["New", "Paid"], truncated: [], notEvaluated: [],
      edges: [
        { handler: "charge", from: ["New"], guards: [], to: { kind: "State", state: "Paid" }, outcome: null, range: rng(10), violations: [] },
        { handler: "peek", from: ["New"], guards: [], to: { kind: "Unchanged" }, outcome: null, range: rng(11), violations: [] },
      ],
    }],
  };

  it("reports the routes, handlers and transitions no line of which ran, and the partly tested", () => {
    const a = untestedQuery(
      sites,
      { "file:///shop.bynk": cov([6, 7], [8, 9, 10, 11, 12]), "file:///pay.bynk": cov([], [20, 21, 22]) },
      [{ unit: "shop", agent: "Cart", uri: "file:///shop.bynk", model: agent }],
    );
    assert.deepStrictEqual(a.routes.map((r) => r.label), ["pay.Gateway.authorise"]);
    assert.deepStrictEqual(a.handlers.map((r) => r.label), ["shop.Cart.charge"]);
    assert.deepStrictEqual(a.partial.map((r) => [r.label, r.description]), [["shop.Orders.POST /orders", "partly tested"]]);
    // The agent's transition is on line 11 of the file, which did not run; the unchanged path is no transition.
    assert.deepStrictEqual(a.transitions.map((r) => r.label), ["shop.Cart.charge: New → Paid"]);
    assert.deepStrictEqual(a.measured, { routes: 2, handlers: 1, transitions: 1 });
  });
  it("leaves out what the run did not measure", () => {
    const a = untestedQuery(sites, { "file:///shop.bynk": cov([], []) }, []);
    assert.deepStrictEqual([a.routes, a.handlers, a.transitions, a.partial], [[], [], [], []]);
    assert.deepStrictEqual(a.measured, { routes: 0, handlers: 0, transitions: 0 });
  });
  it("counts a handler that ran as tested, and reports nothing", () => {
    const a = untestedQuery(sites.slice(0, 1), { "file:///shop.bynk": cov([6, 7, 8, 9], []) }, []);
    assert.deepStrictEqual([a.routes, a.partial], [[], []]);
    assert.strictEqual(a.measured.routes, 1);
  });
});
