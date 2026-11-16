// Model-diagrams slice 5: the architecture model the component-view tests
// open up (`shop`, with its callers and providers). A helper, not a spec, so
// importing it registers no tests.

import type { ArchModel, ArchUse } from "../../src/webview/architectureTypes";

export const L = (f: string, line: number) => ({ uri: `file:///p/${f}.bynk`, range: { start: { line, character: 0 }, end: { line, character: 4 } } });
const member = (unit: string, kind: "service" | "agent" | "provider", container: string, handler: string, line: number) => ({
  unit,
  kind,
  container,
  handler,
  loc: L(unit, line),
});
const use = (capability: string, from: string | null, line: number): ArchUse => ({ capability, from, inherited: false, loc: L("shop", line), stubbedIn: [] });

export function componentModel(): ArchModel {
  return {
    nodes: [
      {
        name: "shop",
        kind: "Context",
        loc: L("shop", 0),
        capabilities: [
          { name: "Clock", local: false, from: "bynk", loc: L("shop", 2) },
          { name: "Payments", local: false, from: "stripe", loc: L("shop", 3) },
          { name: "Ledger", local: true, from: null, loc: L("shop", 4) },
        ],
        providers: [{ capability: "Ledger", providerName: "MemLedger", external: false, loc: L("shop", 50) }],
        services: [
          { name: "web", handlerCount: 2, loc: L("shop", 5), protocol: "http", actors: ["Visitor"] },
          { name: "orders", handlerCount: 1, loc: L("shop", 40), protocol: "call", actors: [] },
        ],
        agents: [{ name: "Cart", handlerCount: 2, loc: L("shop", 20), key: "owner: CustomerId", state: ["lines", "total"] }],
        uses: [
          {
            member: member("shop", "service", "web", "POST /checkout", 7),
            uses: [use("Clock", "bynk", 7), use("Payments", "stripe", 7), use("Ledger", "shop", 7)],
            calls: [
              { kind: "service", unit: "billing", container: "Charges", loc: L("shop", 9) },
              { kind: "agent", unit: "shop", container: "Cart", handler: "add", loc: L("shop", 10) },
            ],
          },
          { member: member("shop", "service", "web", "GET /cart", 12), uses: [], calls: [{ kind: "agent", unit: "shop", container: "Cart", handler: "view", loc: L("shop", 13) }] },
          { member: member("shop", "service", "orders", "call", 41), uses: [], calls: [] },
          { member: member("shop", "agent", "Cart", "add", 24), uses: [], calls: [] },
          { member: member("shop", "agent", "Cart", "view", 28), uses: [], calls: [] },
          { member: member("shop", "provider", "MemLedger", "post", 51), uses: [], calls: [] },
        ],
      },
      {
        name: "billing",
        kind: "Context",
        loc: L("billing", 0),
        capabilities: [],
        providers: [],
        services: [{ name: "Charges", handlerCount: 1, loc: L("billing", 12), protocol: "call", actors: [] }],
        agents: [],
        uses: [{ member: member("billing", "service", "Charges", "call", 13), uses: [], calls: [{ kind: "service", unit: "shop", container: "orders", loc: L("billing", 14) }] }],
      },
      { name: "stripe", kind: "Adapter", loc: L("stripe", 0), capabilities: [], providers: [{ capability: "Payments", providerName: "Stripe", external: true, loc: L("stripe", 2) }], services: [], agents: [], uses: [] },
      { name: "audit", kind: "Context", loc: L("audit", 0), capabilities: [], providers: [], services: [], agents: [], uses: [] },
    ],
    edges: [
      { from: "shop", to: "billing", capabilities: [], loc: L("shop", 1) },
      { from: "billing", to: "shop", capabilities: [], loc: L("billing", 1) },
      { from: "shop", to: "stripe", capabilities: ["Payments"], loc: L("shop", 3) },
      { from: "shop", to: "audit", capabilities: [], loc: L("shop", 1) },
    ],
  };
}

