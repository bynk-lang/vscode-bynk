// #16: the pure part of "Bynk: Export OpenAPI".

import * as assert from "assert";

import { openapiArgs, openapiFailure, openapiOutcome } from "../../src/openapiCore";

describe("openapiCore", () => {
  it("the arguments name the project and the output file", () => {
    assert.deepStrictEqual(openapiArgs("/p", "/p/api.yaml"), ["openapi", "/p", "--out", "/p/api.yaml"]);
  });

  it("a toolchain without the subcommand gets an update hint", () => {
    const msg = openapiFailure("error: unrecognized subcommand 'openapi'\n");
    assert.match(msg, /no `bynk openapi` command/);
  });

  it("other failures pass the CLI's own message through", () => {
    assert.match(openapiFailure("error: project does not check clean\n"), /does not check clean/);
    assert.match(openapiFailure("  \n"), /without a message/);
  });

  it("a cancelled run is not reported as a failure, whatever its exit code", () => {
    assert.deepStrictEqual(openapiOutcome({ code: null, stderr: "" }, true), { kind: "cancelled" });
    assert.deepStrictEqual(openapiOutcome({ error: new Error("x") }, true), { kind: "cancelled" });
  });

  it("a rejection of any type becomes a message", () => {
    assert.deepStrictEqual(openapiOutcome({ error: new Error("no bynk") }, false), { kind: "failed", message: "no bynk" });
    assert.deepStrictEqual(openapiOutcome({ error: "boom" }, false), { kind: "failed", message: "boom" });
  });

  it("a non-zero or signal exit fails; zero writes", () => {
    assert.strictEqual(openapiOutcome({ code: 1, stderr: "bad" }, false).kind, "failed");
    assert.strictEqual(openapiOutcome({ code: null, stderr: "" }, false).kind, "failed");
    assert.deepStrictEqual(openapiOutcome({ code: 0, stderr: "" }, false), { kind: "written" });
  });
});
