// node --test scripts/hotspots.test.mjs
//
// The two lists that used to be edited in one shared place by every new feature
// (the webview bundles in the build script, the registration calls in `activate`)
// are now discovered or kept sorted. These hold that shape.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import os from "node:os";
import path from "node:path";

import { webviewEntries } from "./webview-entries.mjs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("webview entries are discovered from their marker, with unique output names", () => {
  const entries = webviewEntries();
  const names = entries.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
  // The sequence diagram's bundle keeps its historical name, `out/webview.js`.
  assert.ok(entries.some((e) => e.entry.endsWith("/main.ts") && e.name === "webview"));
  assert.ok(names.includes("state"));
});

/** A scratch src/webview/ with these files. */
function webviewDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bynk-webview-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("discovery tolerates a byte-order mark and a mention of the API in a comment or declaration", () => {
  const dir = webviewDir({
    "a.ts": "\uFEFF// @webview-entry\nconst api = acquireVsCodeApi();\n",
    "lib.ts": "// Never calls acquireVsCodeApi() itself.\ndeclare function acquireVsCodeApi(): unknown;\n",
    "b.ts": "// @webview-entry other\n",
  });
  assert.deepEqual(webviewEntries(dir).map((e) => e.name), ["a", "other"]);
});

test("discovery fails loudly rather than skip a file that would be an entry", () => {
  assert.throws(() => webviewEntries(webviewDir({ "x.ts": "const api = acquireVsCodeApi();\n" })), /x\.ts calls acquireVsCodeApi\(\)/);
  assert.throws(() => webviewEntries(webviewDir({ "x.ts": "\n// @webview-entry\n" })), /exactly the file's first line/);
  assert.throws(() => webviewEntries(webviewDir({ "x.ts": "// Licence\n// @webview-entry\n" })), /exactly the file's first line/);
  assert.throws(() => webviewEntries(webviewDir({ "x.ts": "// @webview-entry  \t two words\n" })), /exactly the file's first line/);
  assert.throws(
    () => webviewEntries(webviewDir({ "x.ts": "// @webview-entry same\n", "y.ts": "// @webview-entry same\n" })),
    /two webview entries would write out\/same\.js/,
  );
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
