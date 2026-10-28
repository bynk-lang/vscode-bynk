// #2467: unit coverage for `contract-diff-render.ts`'s DOM-free sentence
// helpers (the DOM half has no direct test, like `wire-render.ts`'s).

import * as assert from "assert";

import {
  changeLabel,
  ledgerSentence,
  lockSentence,
  foldReasons,
  serviceClass,
  serviceRowView,
  serviceNote,
  serviceRowClass,
  serviceSentence,
  summarySentence,
} from "../../src/webview/contract-diff-render";
import type { CdChange, CdCompat, CdModel, CdService } from "../../src/webview/contractDiffTypes";

const change = (name: string, cls: CdChange["class"]): CdChange => ({
  kind: "event",
  unit: "commerce.order",
  name,
  class: cls,
  lockedVersion: 1,
  detail: "field(s) removed: email",
  loc: null,
});

const model = (over: Partial<CdModel>): CdModel => ({
  lock: "read",
  ledger: "read",
  changes: [],
  services: [],
  ...over,
});

describe("summarySentence", () => {
  it("says so when nothing changed", () => {
    assert.strictEqual(summarySentence(model({})), "No boundary changes since the lock.");
  });

  it("counts breaking and compatible changes apart", () => {
    const m = model({
      changes: [change("A", "breaking"), change("B", "compatible"), change("C", "compatible")],
    });
    assert.strictEqual(summarySentence(m), "1 breaking, 2 compatible schema changes.");
  });

  it("counts service contracts as changed when none has a verdict", () => {
    const svc: CdService = {
      environment: "default",
      context: "shop.billing",
      service: "charge",
      status: "changed",
      live: "aaaaaaaaaaaaaaaa",
      current: "bbbbbbbbbbbbbbbb",
      compat: null,
      loc: null,
    };
    assert.strictEqual(summarySentence(model({ services: [svc, svc] })), "2 service contracts changed.");
    assert.ok(!summarySentence(model({ services: [svc] })).includes("breaking"));
  });

  it("keeps schema changes and service contracts as separate, labelled groups", () => {
    const svc: CdService = {
      environment: "default",
      context: "shop.billing",
      service: "charge",
      status: "changed",
      live: "aaaaaaaaaaaaaaaa",
      current: "bbbbbbbbbbbbbbbb",
      compat: { verdict: "breaking", reasons: [] },
      loc: null,
    };
    const m = model({
      changes: [change("A", "breaking"), change("B", "breaking")],
      services: [svc, { ...svc, compat: null }, { ...svc, compat: null }],
    });
    assert.strictEqual(summarySentence(m), "2 breaking schema changes; 3 service contracts changed (1 breaking).");
  });

  it("breaks service contracts down by verdict where the compiler gave one", () => {
    const svc = (verdict: CdCompat["verdict"] | null): CdService => ({
      environment: "default",
      context: "shop.billing",
      service: "charge",
      status: "changed",
      live: "aaaaaaaaaaaaaaaa",
      current: "bbbbbbbbbbbbbbbb",
      compat: verdict ? { verdict, reasons: [] } : null,
      loc: null,
    });
    assert.strictEqual(
      summarySentence(model({ services: [svc("breaking"), svc("compatible"), svc("compatible"), svc(null)] })),
      "4 service contracts changed (1 breaking, 2 compatible for callers).",
    );
  });
});

describe("labels", () => {
  it("names a change by kind and qualified name", () => {
    assert.strictEqual(changeLabel(change("PaymentConfirmed", "breaking")), "event commerce.order.PaymentConfirmed");
  });

  it("shortens hashes in a service sentence", () => {
    const s: CdService = {
      environment: "default",
      context: "shop.billing",
      service: "charge",
      status: "changed",
      live: "aaaaaaaaaaaaaaaa",
      current: "bbbbbbbbbbbbbbbb",
      compat: null,
      loc: null,
    };
    assert.strictEqual(serviceSentence(s), "charge: contract aaaaaaaa → bbbbbbbb");
    assert.ok(serviceSentence({ ...s, status: "added", live: null }).includes("not in the live record"));
    assert.ok(serviceSentence({ ...s, status: "removed", current: null }).includes("no longer provided"));
  });
});

describe("serviceClass", () => {
  const row = (compat: CdService["compat"], status: CdService["status"] = "changed"): CdService => ({
    environment: "default",
    context: "shop.billing",
    service: "charge",
    status,
    live: "aaaaaaaaaaaaaaaa",
    current: "bbbbbbbbbbbbbbbb",
    compat,
    loc: null,
  });

  it("shows the verdict when there is one, and the status when there is not", () => {
    assert.strictEqual(serviceClass(row({ verdict: "breaking", reasons: ["breaking response.at: x"] })), "breaking");
    assert.strictEqual(serviceClass(row({ verdict: "compatible", reasons: [] })), "compatible for callers");
    assert.strictEqual(serviceClass(row(null)), "changed");
    assert.strictEqual(serviceClass(row(null, "added")), "added");
  });
});

describe("serviceRowClass", () => {
  const row = (compat: CdService["compat"]): CdService => ({
    environment: "default",
    context: "shop.billing",
    service: "charge",
    status: "changed",
    live: "aaaaaaaaaaaaaaaa",
    current: "bbbbbbbbbbbbbbbb",
    compat,
    loc: null,
  });

  it("never styles a service verdict as the schema table's passing compatible", () => {
    assert.strictEqual(serviceRowClass(row({ verdict: "compatible", reasons: [] })), "cd-row cd-service-compatible");
    assert.strictEqual(serviceRowClass(row({ verdict: "breaking", reasons: [] })), "cd-row cd-breaking");
    assert.strictEqual(serviceRowClass(row(null)), "cd-row cd-changed");
  });
});

describe("foldReasons", () => {
  it("puts breaking reasons first whatever order the server sent", () => {
    const { shown } = foldReasons(["compatible a: x", "breaking b: y", "compatible c: z", "breaking d: w"]);
    assert.deepStrictEqual(shown, ["breaking b: y", "breaking d: w", "compatible a: x"]);
  });

  it("folds the reasons past the limit, losing none", () => {
    const reasons = Array.from({ length: 10 }, (_, i) => `compatible f${i}: x`);
    const { shown, folded } = foldReasons(reasons);
    assert.strictEqual(shown.length, 3);
    assert.strictEqual(shown.length + folded.length, 10);
    assert.deepStrictEqual(foldReasons(["breaking a: x"]).folded, []);
  });
});

describe("serviceRowView", () => {
  const base = {
    environment: "default",
    context: "shop.billing",
    service: "charge",
    status: "changed" as const,
    live: "aaaaaaaaaaaaaaaa",
    current: "bbbbbbbbbbbbbbbb",
    loc: null,
  };

  it("draws a classified row from its verdict and reasons", () => {
    const v = serviceRowView({ ...base, compat: { verdict: "breaking", reasons: ["compatible a: x", "breaking b: y"] } });
    assert.strictEqual(v.className, "cd-row cd-breaking");
    assert.strictEqual(v.label, "breaking");
    assert.deepStrictEqual(v.shown, ["breaking b: y", "compatible a: x"]);
  });

  it("draws a row with no verdict as a plain change, whether compat is null or absent", () => {
    for (const compat of [null, undefined]) {
      const v = serviceRowView({ ...base, compat });
      assert.strictEqual(v.className, "cd-row cd-changed");
      assert.strictEqual(v.label, "changed");
      assert.deepStrictEqual([v.shown, v.folded], [[], []]);
    }
    // An older bynk-lsp omits the field entirely.
    const { compat: _omitted, ...legacy } = { ...base, compat: null };
    assert.strictEqual(serviceRowView(legacy as CdService).label, "changed");
  });
});

describe("serviceNote", () => {
  const row = (status: CdService["status"], compat: CdService["compat"] = null): CdService => ({
    environment: "default",
    context: "shop.billing",
    service: "charge",
    status,
    live: status === "added" ? null : "aaaaaaaaaaaaaaaa",
    current: status === "removed" ? null : "bbbbbbbbbbbbbbbb",
    compat,
    loc: null,
  });
  const compatible = { verdict: "compatible" as const, reasons: [] };

  it("mentions a missing verdict only when a changed row lacks one", () => {
    assert.ok(!serviceNote([row("changed", compatible)]).includes("no verdict"));
    assert.ok(serviceNote([row("changed")]).includes("no verdict"));
  });

  it("does not suggest a deploy would classify an added or removed row", () => {
    assert.ok(!serviceNote([row("added"), row("removed")]).includes("no verdict"));
  });

  it("says a compatible change is still refused only when one is shown", () => {
    assert.ok(serviceNote([row("changed", compatible)]).includes("even when the change is compatible for callers"));
    assert.ok(!serviceNote([row("changed")]).includes("even when"));
  });
});

describe("ledgerSentence", () => {
  it("explains each way the ledger can be missing", () => {
    assert.ok(ledgerSentence("absent", 0)?.includes("no bynk.deploy.lock"));
    assert.ok(ledgerSentence("unreadable", 0)?.includes("could not be read"));
  });

  it("is silent when there are rows to show", () => {
    assert.strictEqual(ledgerSentence("read", 2), null);
    assert.ok(ledgerSentence("read", 0)?.includes("No service contract differs"));
  });
});

describe("lockSentence", () => {
  it("tells an absent lock from one that could not be read", () => {
    assert.ok(lockSentence("absent")?.includes("There is no bynk.schema.lock"));
    assert.ok(lockSentence("unreadable")?.includes("could not be read"));
    assert.ok(!lockSentence("unreadable")?.includes("There is no"), "a corrupt lock is not 'no lock'");
  });

  it("is silent for a readable lock", () => {
    assert.strictEqual(lockSentence("read"), null);
  });
});
