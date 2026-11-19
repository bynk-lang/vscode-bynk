// #225: the platform limits table, the CPU note's logic and the payload
// classification. The values asserted here are the table's own, so a change to
// the table is a change to these tests: that is the point of the table being
// in one place.

import * as assert from "assert";

import { CPU_NOTE_RATIO, cpuNote, ownMs } from "../../src/cpuNoteCore";
import { MAX_SHOWN, payloadHints, unboundedIn } from "../../src/payloadHintsCore";
import {
  DEFAULT_PLAN,
  formatLimit,
  limitInfo,
  limitOf,
  PLATFORM_LIMITS,
  toPlan,
  type LimitId,
} from "../../src/platformLimitsCore";
import type { WcBody, WcEnvelope, WcInst, WcModel, WcRef, WcType } from "../../src/webview/wireContractTypes";

describe("platform limits table (#225)", () => {
  const ids: LimitId[] = ["subrequests", "cpuTime", "kvValue", "queueMessage", "durableObjectValue", "requestBody", "responseBody"];

  it("has every limit the issue names, once, each with a Cloudflare documentation URL", () => {
    assert.deepStrictEqual(PLATFORM_LIMITS.map((l) => l.id).sort(), [...ids].sort());
    for (const l of PLATFORM_LIMITS) {
      assert.match(l.source, /^https:\/\/developers\.cloudflare\.com\//, l.id);
      assert.ok(l.note.length > 0, l.id);
    }
  });

  it("gives the free plan limits no higher than the paid plan's", () => {
    for (const l of PLATFORM_LIMITS) {
      if (l.free !== null && l.paid !== null) assert.ok(l.free <= l.paid, l.id);
    }
  });

  it("reads the documented values", () => {
    assert.strictEqual(limitOf("subrequests", "free"), 50);
    assert.strictEqual(limitOf("subrequests", "paid"), 10_000);
    assert.strictEqual(limitOf("durableObjectValue", "free"), 8 * 1024 * 1024);
    assert.strictEqual(limitOf("cpuTime", "free"), 10);
    assert.strictEqual(limitOf("cpuTime", "paid"), 30_000);
    assert.strictEqual(limitOf("queueMessage", "free"), 128 * 1024);
    assert.strictEqual(limitOf("kvValue", "paid"), 25 * 1024 * 1024);
    assert.strictEqual(limitOf("responseBody", "free"), null);
  });

  it("formats a limit as Cloudflare writes it", () => {
    assert.strictEqual(formatLimit("subrequests", "paid"), "10,000");
    assert.strictEqual(formatLimit("durableObjectValue", "paid"), "8 MB");
    assert.strictEqual(formatLimit("cpuTime", "free"), "10 ms");
    assert.strictEqual(formatLimit("cpuTime", "paid"), "30 s");
    assert.strictEqual(formatLimit("queueMessage", "free"), "128 KB");
    assert.strictEqual(formatLimit("kvValue", "free"), "25 MB");
    assert.strictEqual(formatLimit("responseBody", "paid"), "no fixed limit");
  });

  it("defaults to the free plan, and to it for anything that is not a plan", () => {
    assert.strictEqual(DEFAULT_PLAN, "free");
    assert.strictEqual(toPlan("paid"), "paid");
    assert.strictEqual(toPlan("PAID"), "free");
    assert.strictEqual(toPlan(undefined), "free");
    assert.throws(() => limitInfo("nope" as LimitId));
  });
});

describe("CPU note (#225)", () => {
  const steps = [
    { target: "Db.query", ms: 4 },
    { target: "Ledger.post", ms: 9 },
    { target: "Mailer.send", ms: 1 },
    { target: "Cache.get", ms: 0 },
    { target: "Db.write", ms: 6 },
  ]; // 20 ms in calls

  it("measures the time outside the traced calls", () => {
    assert.strictEqual(ownMs({ durationMs: 26, steps }), 6);
    assert.strictEqual(ownMs({ durationMs: 15, steps }), 15, "steps that add up to more overlapped: the whole time");
    assert.strictEqual(ownMs({ durationMs: 8, steps: [] }), 8);
  });

  it("says nothing for a request that waited on calls, however long it took", () => {
    assert.strictEqual(cpuNote({ durationMs: 24, steps }, "free"), undefined, "4 ms of its own");
    assert.strictEqual(cpuNote({ durationMs: 4.9, steps: [] }, "free"), undefined);
    assert.strictEqual(cpuNote({ durationMs: 5000, steps: [] }, "paid"), undefined);
  });

  it("notes a request whose own time is half the limit, naming the slowest calls and that the time is wall-clock", () => {
    const note = cpuNote({ durationMs: 20 + 10 * CPU_NOTE_RATIO, steps }, "free");
    assert.ok(note);
    assert.strictEqual(note.level, "near");
    assert.deepStrictEqual(note.slowest.map((s) => s.target), ["Ledger.post", "Db.write", "Db.query"]);
    assert.match(note.text, /wall-clock time in bynk dev/);
    assert.match(note.text, /5\.0 ms was outside the traced calls/);
    assert.match(note.text, /CPU time, which is lower than wall-clock time/);
    assert.match(note.text, /not measured here/);
    assert.match(note.text, /10 ms CPU limit of the free plan/);
    assert.match(note.text, /Ledger\.post \(9\.0 ms\)/);
  });

  it("notes a request at or over the limit, and that CPU time may still be under it", () => {
    const note = cpuNote({ durationMs: 32, steps }, "free");
    assert.ok(note);
    assert.strictEqual(note.level, "over");
    assert.match(note.text, /may well be under the limit/);
  });

  it("applies the plan's limit", () => {
    assert.ok(cpuNote({ durationMs: 20_000, steps: [] }, "paid"));
    assert.strictEqual(cpuNote({ durationMs: 20_000, steps: [] }, "paid")?.slowest.length, 0);
    assert.strictEqual(cpuNote({ durationMs: Number.NaN, steps }, "free"), undefined);
  });
});

describe("payload hints (#225)", () => {
  const bytes: WcRef = { kind: "Bytes" };
  const str: WcRef = { kind: "Base", base: "String", json: "String", guards: [], expected: { kind: "Json", json: "String" } };
  const record = (name: string, fields: Array<[string, WcRef]>): WcType => ({
    name,
    codecSuffix: name,
    provenance: { kind: "Owned" },
    body: { kind: "Record", fields: fields.map(([n, shape]) => ({ name: n, shape, pathSegment: n, default: null })) } as WcBody,
    loc: null,
  });
  const scalar = (name: string, base: "Bytes" | "String", predicates: string[]): WcType => ({
    name,
    codecSuffix: name,
    provenance: { kind: "Owned" },
    body: { kind: "Scalar", base, json: "String", opaque: false, predicates, baseGuards: [], revalidation: "ViaConstructor" },
    loc: null,
  });
  const model = (kind: WcModel["kind"], envelope: WcEnvelope, types: WcType[] = [], instantiations: WcInst[] = []): WcModel => ({
    unit: "jobs",
    service: "outbox",
    kind,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    handlerLine: 0,
    envelope,
    contract: null,
    types,
    instantiations,
    recursive: [],
    responses: [],
    noCrossContext: "NotACallHandler",
  });
  const named = (name: string): WcRef => ({ kind: "Named", name });

  it("flags a queue message with a Bytes field, by its path", () => {
    const m = model({ kind: "Message" }, { kind: "Bare", param: "message", shape: named("Upload") }, [record("Upload", [["name", str], ["data", bytes]])]);
    const hints = payloadHints(m, "free");
    assert.strictEqual(hints.length, 1);
    assert.strictEqual(hints[0].limit, "queueMessage");
    assert.deepStrictEqual(hints[0].unbounded, [{ path: "data", kind: "Bytes", type: "Bytes" }]);
    assert.match(hints[0].message, /may be larger than a queue allows/);
    assert.match(hints[0].message, /`data`/);
    assert.match(hints[0].message, /128 KB/);
    assert.match(hints[0].message, /free plan/);
  });

  it("flags a List or Map, through a nested record and an Option", () => {
    const m = model(
      { kind: "Message" },
      { kind: "Bare", param: "message", shape: named("Batch") },
      [record("Batch", [["id", str], ["body", named("Body")]]), record("Body", [["items", { kind: "Inst", key: "Option[List[Item]]" }], ["tags", { kind: "Inst", key: "Map[String, String]" }]])],
      [
        { kind: "OptionInst", key: "Option[List[Item]]", inner: { kind: "Inst", key: "List[Item]" } },
        { kind: "ListInst", key: "List[Item]", elem: str },
        { kind: "MapInst", key: "Map[String, String]", mapKey: str, val: str },
      ],
    );
    const found = unboundedIn({ kind: "Named", name: "Batch" }, "", m);
    assert.deepStrictEqual(found.map((u) => [u.path, u.kind, u.type]), [
      ["body.items", "List", "List[String]"],
      ["body.tags", "Map", "Map[String, String]"],
    ]);
  });

  it("does not flag Strings, numbers, or a message of bounded types", () => {
    const m = model({ kind: "Message" }, { kind: "Bare", param: "message", shape: named("Email") }, [record("Email", [["to", str], ["subject", str]])]);
    assert.deepStrictEqual(payloadHints(m, "free"), []);
  });

  it("does not flag a Bytes bounded by a length predicate, and flags an unbounded one", () => {
    const bounded = model({ kind: "Message" }, { kind: "Bare", param: "m", shape: named("Small") }, [scalar("Small", "Bytes", ["MaxLength(1024)"])]);
    assert.deepStrictEqual(payloadHints(bounded, "free"), []);
    const open = model({ kind: "Message" }, { kind: "Bare", param: "m", shape: named("Blob") }, [scalar("Blob", "Bytes", [])]);
    assert.strictEqual(payloadHints(open, "free").length, 1);
  });

  it("walks a recursive type once", () => {
    const tree = record("Tree", [["children", { kind: "Inst", key: "List[Tree]" }], ["next", named("Tree")], ["blob", bytes]]);
    const m = model({ kind: "Message" }, { kind: "Bare", param: "m", shape: named("Tree") }, [tree], [{ kind: "ListInst", key: "List[Tree]", elem: named("Tree") }]);
    assert.deepStrictEqual(unboundedIn(named("Tree"), "", m).map((u) => u.path), ["children", "blob"]);
  });

  it("names a few places and counts the rest", () => {
    const fields: Array<[string, WcRef]> = Array.from({ length: MAX_SHOWN + 2 }, (_, i) => [`f${i}`, bytes]);
    const m = model({ kind: "Message" }, { kind: "Bare", param: "m", shape: named("Wide") }, [record("Wide", fields)]);
    const [hint] = payloadHints(m, "free");
    assert.strictEqual(hint.unbounded.length, MAX_SHOWN);
    assert.match(hint.message, /and 2 more/);
  });

  it("flags a keyed queue message by parameter, and a raw one", () => {
    const keyed = model({ kind: "Message" }, { kind: "Keyed", params: [{ name: "payload", shape: bytes }, { name: "tag", shape: str }] });
    assert.deepStrictEqual(payloadHints(keyed, "free")[0].unbounded.map((u) => u.path), ["payload"]);
    const raw = model({ kind: "Message" }, { kind: "Raw", param: "body", contentType: "application/octet-stream" });
    assert.strictEqual(payloadHints(raw, "free").length, 1);
  });

  it("does not flag an HTTP handler, raw body or not: the platform refuses an oversized body first", () => {
    const raw = model({ kind: "Http", method: "POST", path: "/upload" }, { kind: "Raw", param: "body", contentType: "application/octet-stream" });
    assert.deepStrictEqual(payloadHints(raw, "paid"), []);
    const json = model({ kind: "Http", method: "POST", path: "/upload" }, { kind: "Bare", param: "b", shape: bytes });
    assert.deepStrictEqual(payloadHints(json, "free"), []);
  });

  it("flags nothing for a handler kind whose destination the model does not give", () => {
    for (const kind of [{ kind: "Call" }, { kind: "Event" }, { kind: "Cron", expr: "* * * * *" }, { kind: "Open" }] as WcModel["kind"][]) {
      assert.deepStrictEqual(payloadHints(model(kind, { kind: "Bare", param: "m", shape: bytes }), "free"), [], kind.kind);
    }
    assert.deepStrictEqual(payloadHints(model({ kind: "Message" }, { kind: "Empty" }), "free"), []);
  });
});
