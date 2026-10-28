// #2516: the containment test for which unsaved buffers belong to a project
// (src/pathInside.ts): a path comparison, not a string prefix.

import * as assert from "assert";
import * as path from "path";

import { isInside } from "../../src/pathInside";

describe("isInside (#2516)", () => {
  const root = path.join(path.sep, "work", "app");

  it("holds for files and nested files under the root", () => {
    assert.strictEqual(isInside(root, path.join(root, "src", "a.bynk")), true);
    assert.strictEqual(isInside(root, path.join(root, "a.bynk")), true);
  });

  it("does not hold for a sibling that shares the root's name as a prefix", () => {
    assert.strictEqual(isInside(root, path.join(path.sep, "work", "app-old", "src", "a.bynk")), false);
    assert.strictEqual(isInside(root, path.join(path.sep, "work", "application", "a.bynk")), false);
  });

  it("does not hold for the root itself, a parent, or a path that climbs out", () => {
    assert.strictEqual(isInside(root, root), false);
    assert.strictEqual(isInside(root, path.join(path.sep, "work")), false);
    assert.strictEqual(isInside(root, path.join(root, "..", "other", "a.bynk")), false);
  });

  it("holds for a directory whose name starts with two dots", () => {
    assert.strictEqual(isInside(root, path.join(root, "..hidden", "a.bynk")), true);
  });
});
