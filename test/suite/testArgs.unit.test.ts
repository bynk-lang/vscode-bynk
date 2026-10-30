// Unit coverage for `testArgs` (src/testArgs.ts), the `bynk test` argument list for
// a run — no extension host.

import * as assert from "assert";

import { testArgs } from "../../src/testArgs";

describe("testArgs", () => {
  it("runs the current directory as one json document by default", () => {
    assert.deepStrictEqual(testArgs("/p", undefined, "json"), ["test", ".", "--format", "json"]);
  });

  it("lists without running for discovery", () => {
    assert.deepStrictEqual(testArgs("/p", { noRun: true }, "json"), ["test", ".", "--no-run", "--format", "json"]);
  });

  it("names the project by absolute path for coverage", () => {
    assert.deepStrictEqual(testArgs("/p", { coverage: true }, "ndjson"), [
      "test", "/p", "--format", "ndjson", "--coverage",
    ]);
  });

  it("passes a case, a set, a valid seed and a target", () => {
    const args = testArgs(
      "/p",
      { caseName: "one", suites: ["s"], cases: ["a", "b"], seed: "0xdeadbeef", against: "dev", skipUnsupported: true },
      "json",
    );
    assert.deepStrictEqual(args.slice(4), [
      "--case", "one", "--suite", "s", "--case", "a", "--case", "b", "--seed", "0xdeadbeef", "--against", "dev", "--skip-unsupported",
    ]);
  });

  it("drops an invalid seed and a skip flag with no target", () => {
    assert.deepStrictEqual(testArgs("/p", { seed: "nope", skipUnsupported: true }, "json"), [
      "test", ".", "--format", "json",
    ]);
  });
});
