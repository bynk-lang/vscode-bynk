// node --test scripts/hotspots.test.mjs
//
// The two lists that used to be edited in one shared place by every new feature
// (the webview bundles in the build script, the registration calls in `activate`)
// are now discovered or kept sorted. These hold that shape.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { webviewEntries } from "./build.mjs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("webview entries are discovered from their marker, with unique output names", () => {
  const entries = webviewEntries();
  const names = entries.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
  // The sequence diagram's bundle keeps its historical name, `out/webview.js`.
  assert.ok(entries.some((e) => e.entry.endsWith("/main.ts") && e.name === "webview"));
  assert.ok(names.includes("state"));
});

test("every bundle the panels load still has an entry", () => {
  const have = new Set(webviewEntries().map((e) => e.name));
  for (const name of ["webview", "docview", "architecture", "wireContract", "contractDiff", "explainview", "refinedExplorer", "state"])
    assert.ok(have.has(name), `no webview entry builds out/${name}.js`);
});

test("the feature table is sorted and activate does not register its features twice", () => {
  const table = read("src/features.ts");
  const body = table.slice(table.indexOf("export const FEATURES"));
  const names = [...body.matchAll(/=> (register\w+)\(/g)].map((m) => m[1]);
  assert.ok(names.length > 10, "found the table's entries");
  assert.deepEqual(names, [...names].sort(), "FEATURES is kept sorted by feature name");
  assert.equal(new Set(names).size, names.length, "a feature is listed once");
  const activate = read("src/extension.ts");
  for (const name of names) assert.ok(!activate.includes(`${name}(`), `activate still calls ${name}`);
});
