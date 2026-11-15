// #2478: the Explorer decorations' badge rules and failing-test bookkeeping
// (`fileDecorationsCore.ts`), `vscode`-free.

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import {
  FailureTracker,
  CONTRACT_DIFF_TITLE,
  abbreviate,
  contextBadge,
  hasContractBreak,
  type ScannedFile,
  clientFiles,
  clientTooltip,
  hasClientHeader,
  parseClientConfig,
} from "../../src/fileDecorationsCore";

const file = (kind: ScannedFile["kind"], name: string, root = "file:///p"): ScannedFile => ({ root, kind, name });

describe("file decorations (#2478)", () => {
  describe("abbreviate", () => {
    it("takes the first two letters of a single word", () => {
      assert.strictEqual(abbreviate("billing"), "BI");
      assert.strictEqual(abbreviate("a"), "A");
    });
    it("takes the initials of a multi-word name", () => {
      assert.strictEqual(abbreviate("order.billing"), "OB");
      assert.strictEqual(abbreviate("order_billing"), "OB");
      assert.strictEqual(abbreviate("OrderBilling"), "OB");
      assert.strictEqual(abbreviate("a.b.c"), "AB");
    });
  });

  describe("contextBadge", () => {
    const two = new Map<string, ScannedFile>([
      ["file:///p/billing.bynk", file("context", "billing")],
      ["file:///p/store.bynk", file("context", "storefront")],
      ["file:///p/billing_test.bynk", file("test", "billing")],
      ["file:///p/orphan_test.bynk", file("test", "missing")],
      ["file:///p/money.bynk", file("commons", "money")],
      ["file:///q/solo.bynk", file("context", "solo", "file:///q")],
    ]);

    it("badges context files, with the full name for the tooltip", () => {
      assert.deepStrictEqual(contextBadge(two, "file:///p/billing.bynk", "auto"), { badge: "BI", context: "billing" });
    });
    it("badges a suite with the context it tests", () => {
      assert.strictEqual(contextBadge(two, "file:///p/billing_test.bynk", "auto")?.context, "billing");
    });
    it("leaves commons, unmatched suites and unknown files bare", () => {
      assert.strictEqual(contextBadge(two, "file:///p/money.bynk", "auto"), undefined);
      assert.strictEqual(contextBadge(two, "file:///p/orphan_test.bynk", "auto"), undefined);
      assert.strictEqual(contextBadge(two, "file:///p/none.bynk", "auto"), undefined);
    });
    it("is off for a single-context project unless always", () => {
      assert.strictEqual(contextBadge(two, "file:///q/solo.bynk", "auto"), undefined);
      assert.strictEqual(contextBadge(two, "file:///q/solo.bynk", "always")?.badge, "SO");
    });
    it("is off when never", () => {
      assert.strictEqual(contextBadge(two, "file:///p/billing.bynk", "never"), undefined);
    });
  });

  describe("FailureTracker", () => {
    it("tints a file on a failure and clears it when the case passes", () => {
      const t = new FailureTracker();
      const seen: string[][] = [];
      t.onDidChange((u) => seen.push(u));
      t.record("f", "a", "failed");
      assert.ok(t.hasFailures("f"));
      t.record("f", "a", "passed");
      assert.ok(!t.hasFailures("f"));
      assert.deepStrictEqual(seen, [["f"], ["f"]]);
    });
    it("keeps the tint while another case in the file still fails", () => {
      const t = new FailureTracker();
      t.record("f", "a", "failed");
      t.record("f", "b", "failed");
      t.record("f", "a", "passed");
      assert.ok(t.hasFailures("f"));
      t.record("f", "b", "passed");
      assert.ok(!t.hasFailures("f"));
    });
    it("does not fire for a repeat or for a pass that was never a failure", () => {
      const t = new FailureTracker();
      let n = 0;
      t.onDidChange(() => n++);
      t.record("f", "a", "passed");
      t.record("f", "a", "failed");
      t.record("f", "a", "failed");
      assert.strictEqual(n, 1);
    });
    it("ignores a case with no file", () => {
      const t = new FailureTracker();
      t.record(undefined, "a", "failed");
      assert.ok(!t.hasFailures("undefined"));
    });
    it("forgets a failed case that no longer exists", () => {
      const t = new FailureTracker();
      t.record("f", "a", "failed");
      t.record("g", "b", "failed");
      t.retain(new Set(["b"]));
      assert.ok(!t.hasFailures("f"));
      assert.ok(t.hasFailures("g"));
    });
  });

  describe("hasContractBreak (#2519)", () => {
    it("recognises both boundary-break codes", () => {
      assert.strictEqual(hasContractBreak([{ code: "bynk.event.non_additive_schema_change" }]), true);
      assert.strictEqual(hasContractBreak([{ code: "bynk.agent.non_additive_state_change" }]), true);
    });
    it("reads a code that carries a documentation link", () => {
      assert.strictEqual(
        hasContractBreak([{ code: { value: "bynk.event.non_additive_schema_change", target: {} } }]),
        true,
      );
    });
    it("ignores other diagnostics, numeric codes and missing codes", () => {
      assert.strictEqual(hasContractBreak([]), false);
      assert.strictEqual(hasContractBreak([{}, { code: 12 }, { code: "bynk.type.mismatch" }]), false);
      assert.strictEqual(hasContractBreak([{ code: { value: 7 } }]), false);
    });
    it("does not throw on a null code, which a server can publish despite the type", () => {
      assert.strictEqual(hasContractBreak([{ code: null }]), false);
      assert.strictEqual(
        hasContractBreak([{ code: null }, { code: "bynk.event.non_additive_schema_change" }]),
        true,
      );
    });
    it("names the contract diff command by its package.json title", () => {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"));
      const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === "bynk.showContractDiff");
      assert.strictEqual(CONTRACT_DIFF_TITLE, `${cmd.category}: ${cmd.title}`);
    });
    it("finds one among others", () => {
      assert.strictEqual(
        hasContractBreak([{ code: "bynk.type.mismatch" }, { code: "bynk.agent.non_additive_state_change" }]),
        true,
      );
    });
  });
});

describe("generated client (#134)", () => {
  it("reads [build.client] from a header table", () => {
    assert.deepStrictEqual(
      parseClientConfig('[project]\nname = "x"\n\n[build.client]\nout = "../web/src/lib/api.ts"  # front end\n'),
      { out: "../web/src/lib/api.ts", layout: "file" },
    );
    assert.deepStrictEqual(parseClientConfig("[build.client]\nout = 'gen'\nlayout = \"dir\"\n"), {
      out: "gen",
      layout: "dir",
    });
  });

  it("reads the inline and dotted spellings under [build]", () => {
    assert.deepStrictEqual(parseClientConfig('[build]\nclient = { out = "a.ts", layout = "file" }\n'), {
      out: "a.ts",
      layout: "file",
    });
    assert.deepStrictEqual(parseClientConfig('[build]\nclient.out = "d"\nclient.layout = "dir"\n'), {
      out: "d",
      layout: "dir",
    });
  });

  it("ignores other tables and a missing out", () => {
    assert.strictEqual(parseClientConfig('[build]\nout = "dist"\n'), undefined);
    assert.strictEqual(parseClientConfig("[build.client]\nlayout = \"dir\"\n"), undefined);
    assert.strictEqual(parseClientConfig('[other.client]\nout = "x.ts"\n'), undefined);
  });

  it("resolves out beside or outside the project", () => {
    assert.deepStrictEqual(clientFiles("/w/api", { out: "../web/src/lib/api.ts", layout: "file" }), [
      "/w/web/src/lib/api.ts",
    ]);
    assert.deepStrictEqual(clientFiles("/w/api", { out: "./gen/", layout: "dir" }), [
      "/w/api/gen/index.ts",
      "/w/api/gen/types.ts",
      "/w/api/gen/codecs.ts",
      "/w/api/gen/runtime.ts",
    ]);
  });

  it("recognises the generated header on the first line only", () => {
    assert.ok(hasClientHeader("// @generated by `bynk client`\nexport {};\n"));
    // The first line bynk v0.614.0 actually writes.
    assert.ok(
      hasClientHeader(
        "// @generated by `bynk client` — do not edit by hand.\n// bynk 0.614.0. Regenerate with `bynk client`; see https://bynk-lang.org/book/reference/http-client/\n",
      ),
    );
    assert.ok(hasClientHeader("﻿// @generated by `bynk client`\r\n"));
    assert.ok(!hasClientHeader("export {};\n// @generated by `bynk client`\n"));
    assert.ok(!hasClientHeader(""));
    assert.ok(!hasClientHeader("// hand-written client\n"));
  });

  it("names the project in the tooltip", () => {
    assert.match(clientTooltip("api"), /Generated by `bynk client` from api; regenerate rather than edit/);
  });
});
