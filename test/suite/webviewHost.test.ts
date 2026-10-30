// Unit tests for the shape check on a webview's `reveal` message (#41).

import * as assert from "assert";

import { isRevealMessage } from "../../src/webviewHost";

const pos = (line: number, character: number) => ({ line, character });
const good = { type: "reveal", uri: "file:///a.bynk", range: { start: pos(1, 2), end: pos(1, 5) } };

describe("isRevealMessage", () => {
  it("accepts a well-formed message", () => {
    assert.ok(isRevealMessage(good));
  });

  it("rejects a missing or non-string uri", () => {
    assert.ok(!isRevealMessage({ ...good, uri: undefined }));
    assert.ok(!isRevealMessage({ ...good, uri: 5 }));
    assert.ok(!isRevealMessage({ ...good, uri: "" }));
  });

  it("rejects a missing or malformed range", () => {
    assert.ok(!isRevealMessage({ ...good, range: undefined }));
    assert.ok(!isRevealMessage({ ...good, range: { start: pos(1, 2) } }));
    assert.ok(!isRevealMessage({ ...good, range: { start: pos(-1, 0), end: pos(1, 0) } }));
    assert.ok(!isRevealMessage({ ...good, range: { start: pos(1.5, 0), end: pos(1, 0) } }));
    assert.ok(!isRevealMessage({ ...good, range: { start: pos(1, 0), end: { line: "1", character: 0 } } }));
  });

  it("rejects non-objects and other types", () => {
    assert.ok(!isRevealMessage(null));
    assert.ok(!isRevealMessage("reveal"));
    assert.ok(!isRevealMessage({ ...good, type: "pin" }));
  });
});
