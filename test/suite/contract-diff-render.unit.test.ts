// #2467: unit coverage for `contract-diff-render.ts`'s DOM-free sentence
// helpers (the DOM half has no direct test, like `wire-render.ts`'s).

import * as assert from "assert";

import {
  changeLabel,
  ledgerSentence,
  lockSentence,
  serviceClass,
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
    assert.strictEqual(summarySentence(m), "1 breaking, 2 compatible.");
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
      "4 service contracts changed (1 breaking, 2 compatible).",
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
    assert.strictEqual(serviceClass(row({ verdict: "compatible", reasons: [] })), "compatible");
    assert.strictEqual(serviceClass(row(null)), "changed");
    assert.strictEqual(serviceClass(row(null, "added")), "added");
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
