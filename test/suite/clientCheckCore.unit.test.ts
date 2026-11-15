// Unit coverage for the stale-client warning's pure core (#132): reading
// `bynk client --check`'s outcome, spotting `[build.client]`, and the state
// the editor keeps between checks. The stderr below is what bynk v0.614.0
// prints (bynk/src/http_client.rs).

import * as assert from "assert";

import {
  CHECK_ARGS,
  classifyCheck,
  hasBuildClient,
  isDrifted,
  nextState,
  statusFor,
  type ClientOutcome,
} from "../../src/clientCheckCore";

const run = (code: number | null, stderr = "", stdout = "") => ({ code, stdout, stderr });

describe("hasBuildClient (#132)", () => {
  it("finds the table", () => {
    assert.ok(hasBuildClient('[package]\nname = "x"\n\n[build.client]\nout = "../web/api.ts"\n'));
    assert.ok(hasBuildClient("[build.client] # the client\nout = 'a.ts'\n"));
    assert.ok(hasBuildClient("  [ build . client ]\r\nout = 'a.ts'\r\n"));
    assert.ok(hasBuildClient('["build"."client"]\nout = "a.ts"\n'));
  });

  it("ignores manifests without it", () => {
    assert.ok(!hasBuildClient(""));
    assert.ok(!hasBuildClient('[build]\nout = "dist"\n'));
    assert.ok(!hasBuildClient("[build.clients]\n"));
    assert.ok(!hasBuildClient("# [build.client]\n"));
    assert.ok(!hasBuildClient("[[build.client]]\n"));
  });
});

describe("classifyCheck (#132)", () => {
  it("passes a client that is current", () => {
    assert.deepStrictEqual(classifyCheck(run(0)), { kind: "fresh" });
    // Notes about leftover files and skipped routes do not make it stale.
    assert.deepStrictEqual(
      classifyCheck(run(0, "bynk: skipped POST /raw\nbynk: note: `old.ts` is not part of the client\n")),
      { kind: "fresh" },
    );
  });

  it("names the first differing line of a stale client", () => {
    const stderr =
      "bynk: skipped GET /stream\n" +
      "bynk: client is stale: run `bynk client --out /p/web/api.ts`\n" +
      "  /p/web/api.ts differs at line 12 (3 lines in all):\n" +
      "    - found:    get: () => 1\n" +
      "    + expected: get: () => 2\n";
    const outcome = classifyCheck(run(1, stderr));
    assert.strictEqual(outcome.kind, "stale");
    assert.ok(outcome.kind === "stale");
    assert.strictEqual(outcome.summary, "/p/web/api.ts differs at line 12");
    assert.strictEqual(
      outcome.detail,
      "  /p/web/api.ts differs at line 12 (3 lines in all):\n    - found:    get: () => 1\n    + expected: get: () => 2",
    );
  });

  it("calls a client that was never written missing", () => {
    const one = classifyCheck(
      run(1, "bynk: client is stale: run `bynk client --out /p/api.ts`\n  /p/api.ts: missing\n"),
    );
    assert.strictEqual(one.kind, "missing");
    assert.ok(one.kind === "missing");
    assert.strictEqual(one.summary, "/p/api.ts does not exist");

    const dir = classifyCheck(
      run(
        1,
        "bynk: client is stale: run `bynk client --layout dir --out /p/api`\n" +
          "  /p/api/index.ts: missing\n  /p/api/types.ts: missing\n  /p/api/codecs.ts: missing\n  /p/api/runtime.ts: missing\n",
      ),
    );
    assert.strictEqual(dir.kind, "missing");
    assert.ok(dir.kind === "missing");
    assert.strictEqual(dir.summary, "4 client files do not exist");
  });

  it("calls a directory client with some files missing stale", () => {
    const outcome = classifyCheck(
      run(
        1,
        "bynk: client is stale: run `bynk client --layout dir --out /p/api`\n" +
          "  /p/api/index.ts: missing\n" +
          "  /p/api/types.ts differs at line 1 (1 line in all):\n    - found:    a\n    + expected: b\n",
      ),
    );
    assert.strictEqual(outcome.kind, "stale");
  });

  it("does not mistake a differing line that ends in `: missing` for a missing file", () => {
    const outcome = classifyCheck(
      run(
        1,
        "bynk: client is stale: run `bynk client --out /p/api.ts`\n" +
          "  /p/api.ts differs at line 4 (1 line in all):\n" +
          "    - found:    status: missing\n" +
          "    + expected: status: ready\n",
      ),
    );
    assert.strictEqual(outcome.kind, "stale");
  });

  it("cannot check a project with errors, or one the CLI refuses", () => {
    const errors = classifyCheck(run(1, "bynk: the project does not check: 2 errors\n"));
    assert.deepStrictEqual(errors, { kind: "unknown", reason: "the project does not check: 2 errors" });

    const noTable = classifyCheck(
      run(1, "bynk: `--check` compares with a written client: pass `--out PATH`, or set `[build.client]` in bynk.toml\n"),
    );
    assert.strictEqual(noTable.kind, "unknown");
  });

  it("cannot check when the process failed without a message or was stopped", () => {
    assert.deepStrictEqual(classifyCheck(run(2)), {
      kind: "unknown",
      reason: "`bynk client --check` exited with 2",
    });
    assert.deepStrictEqual(classifyCheck(run(null)), {
      kind: "unknown",
      reason: "`bynk client --check` was stopped",
    });
    // Only notes on stderr: still no statement of failure.
    assert.strictEqual(classifyCheck(run(1, "bynk: note: `x.ts` is not part of the client\n")).kind, "unknown");
  });
});

describe("nextState (#132)", () => {
  const stale: ClientOutcome = { kind: "stale", summary: "s", detail: "d" };
  const unknown: ClientOutcome = { kind: "unknown", reason: "errors" };

  it("shows a drift and clears it when the client is fresh", () => {
    assert.deepStrictEqual(nextState({ kind: "none" }, stale), stale);
    assert.deepStrictEqual(nextState(stale, { kind: "fresh" }), { kind: "fresh" });
  });

  it("keeps what was known when the check could not say", () => {
    assert.deepStrictEqual(nextState(stale, unknown), stale);
    assert.deepStrictEqual(nextState({ kind: "none" }, unknown), { kind: "none" });
  });

  it("tells drift from the rest", () => {
    assert.ok(isDrifted(stale));
    assert.ok(isDrifted({ kind: "missing", summary: "m", detail: "" }));
    assert.ok(!isDrifted({ kind: "fresh" }));
    assert.ok(!isDrifted(unknown));
    assert.ok(!isDrifted({ kind: "none" }));
  });
});

describe("statusFor (#132)", () => {
  it("shows nothing when no client has drifted", () => {
    assert.strictEqual(statusFor([]), undefined);
    assert.strictEqual(statusFor([{ name: "a", state: { kind: "fresh" } }]), undefined);
  });

  it("words a stale and a missing client differently", () => {
    const stale = statusFor([{ name: "a", state: { kind: "stale", summary: "api.ts differs at line 3", detail: "" } }]);
    assert.strictEqual(stale?.text, "$(warning) Bynk client stale");
    assert.ok(stale?.tooltip.includes("api.ts differs at line 3"));

    const missing = statusFor([{ name: "a", state: { kind: "missing", summary: "api.ts does not exist", detail: "" } }]);
    assert.strictEqual(missing?.text, "$(warning) Bynk client missing");
  });

  it("names each project when several have drifted", () => {
    const status = statusFor([
      { name: "api", state: { kind: "stale", summary: "x", detail: "" } },
      { name: "shop", state: { kind: "missing", summary: "y", detail: "" } },
      { name: "ok", state: { kind: "fresh" } },
    ]);
    assert.strictEqual(status?.text, "$(warning) Bynk client stale");
    assert.ok(status?.tooltip.includes("api: x") && status?.tooltip.includes("shop: y"));
    assert.ok(!status?.tooltip.includes("ok:"));
  });
});

describe("CHECK_ARGS (#132)", () => {
  it("passes no further arguments: `[build.client]` supplies them", () => {
    assert.deepStrictEqual([...CHECK_ARGS], ["client", "--check"]);
  });
});
