// #16: the pure part of "Bynk: Export OpenAPI".

import * as assert from "assert";

import { openapiArgs, openapiFailure } from "../../src/openapiCore";

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
});
