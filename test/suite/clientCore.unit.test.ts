// #131: the pure part of "Bynk: Generate TypeScript Client".

import * as assert from "assert";

import { clientArgs, clientFailure, clientOutcome, httpServiceChoices, httpServiceNames, skippedRoutes } from "../../src/clientCore";

describe("clientCore", () => {
  it("with only a root, the arguments leave everything to [build.client]", () => {
    assert.deepStrictEqual(clientArgs({ root: "/p" }), ["client", "/p"]);
  });

  it("names the output, the directory layout and each service", () => {
    assert.deepStrictEqual(
      clientArgs({ root: "/p", out: "/p/web/api", layout: "dir", services: ["orders", "billing"] }),
      ["client", "/p", "--out", "/p/web/api", "--layout", "dir", "--service", "orders", "--service", "billing"],
    );
    // `file` is the CLI's default, so it is not passed.
    assert.deepStrictEqual(clientArgs({ root: "/p", out: "/p/api.ts", layout: "file" }), ["client", "/p", "--out", "/p/api.ts"]);
  });

  it("finds the from-http services of a source", () => {
    assert.deepStrictEqual(
      httpServiceNames("context a\nservice api from http {\n}\n  service orders from http {\n}\nservice q from queue {\n}\n"),
      ["api", "orders"],
    );
  });

  it("offers unit.Name when two units declare the same service name", () => {
    const a = "context shop\nservice api from http {\n}\nservice admin from http {\n}\n";
    const b = "context billing\nservice api from http {\n}\n";
    assert.deepStrictEqual(httpServiceChoices([a, b]), ["admin", "billing.api", "shop.api"]);
    assert.deepStrictEqual(httpServiceChoices([a]), ["admin", "api"]);
  });

  it("collects skipped routes from stderr", () => {
    const stderr = "bynk: skipped `POST /u` of `api`: a `@raw` body\nnoise\nbynk: skipped `GET /s` of `api`: streamed\n";
    assert.deepStrictEqual(skippedRoutes(stderr), ["`POST /u` of `api`: a `@raw` body", "`GET /s` of `api`: streamed"]);
    assert.deepStrictEqual(skippedRoutes(""), []);
  });

  it("explains the CLI's refusals", () => {
    assert.match(clientFailure("error: unrecognized subcommand 'client'"), /no `bynk client` command/);
    assert.match(clientFailure("bynk: refusing to overwrite `a.ts`: it is not a client"), /will not overwrite/);
    assert.match(clientFailure("bynk: the project has no `from http` service"), /no `from http` service/);
    assert.match(clientFailure("bynk: no `from http` service `x`; the project's are: api"), /No such service[\s\S]*the project's are: api/);
    assert.match(clientFailure("bynk: no route of the selected services is one this version of `bynk client` can represent\n  a"), /cannot represent/);
    assert.match(clientFailure("bynk: `GET /a` and `GET /b` of service `api` both make the function `getA`; the client cannot name them apart"), /share a client function name/);
    // A check failure that merely says "duplicate" is still a check failure.
    const dup = clientFailure("src/a.bynk:1:1: error[bynk.resolve.duplicate_type]: duplicate type `T` with the same name");
    assert.match(dup, /must check clean/);
    assert.doesNotMatch(dup, /function name/);
    assert.match(clientFailure("src/a.bynk:1:1: error[x]: bad"), /must check clean[\s\S]*error\[x\]/);
    assert.match(clientFailure(" "), /without a message/);
  });

  it("classifies outcomes", () => {
    assert.deepStrictEqual(clientOutcome({ code: null, stderr: "" }, true), { kind: "cancelled" });
    assert.deepStrictEqual(clientOutcome({ error: new Error("no bynk") }, false), { kind: "failed", message: "no bynk" });
    assert.strictEqual(clientOutcome({ code: 1, stderr: "x" }, false).kind, "failed");
    assert.strictEqual(clientOutcome({ code: null, stderr: "" }, false).kind, "failed");
    assert.deepStrictEqual(clientOutcome({ code: 0, stderr: "bynk: skipped r" }, false), { kind: "written", skipped: ["r"] });
  });
});
