// Build the extension: the Node entry (`out/extension.js`) and one browser
// bundle per webview.
//
// A webview's entry point declares itself with a first line
//
//   // @webview-entry            -> out/<file name>.js
//   // @webview-entry <name>     -> out/<name>.js
//
// so adding a view is a new file, not an edit to a shared build line (which every
// new view used to change, and so conflicted on). Files in src/webview/ without
// the marker are libraries the entries import.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import * as esbuild from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const webviewDir = path.join(root, "src", "webview");
const marker = /^\/\/ @webview-entry(?: ([A-Za-z][\w-]*))?\s*$/;

/** The webview entries: `{ entry, name }` for each marked file, in name order. */
export function webviewEntries() {
  const entries = [];
  for (const file of readdirSync(webviewDir).sort()) {
    if (!file.endsWith(".ts")) continue;
    const first = readFileSync(path.join(webviewDir, file), "utf8").split("\n", 1)[0];
    const m = marker.exec(first);
    if (m) entries.push({ entry: `src/webview/${file}`, name: m[1] ?? file.slice(0, -3) });
  }
  const dup = entries.find((e, i) => entries.findIndex((o) => o.name === e.name) !== i);
  if (dup) throw new Error(`two webview entries would write out/${dup.name}.js`);
  return entries;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["src/extension.ts"],
    outfile: "out/extension.js",
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node18",
    minify: true,
  });
  const views = webviewEntries();
  if (views.length === 0) throw new Error("no `// @webview-entry` files in src/webview/");
  await Promise.all(
    views.map(({ entry, name }) =>
      esbuild.build({
        absWorkingDir: root,
        entryPoints: [entry],
        outfile: `out/${name}.js`,
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        minify: true,
      }),
    ),
  );
  console.log(`built out/extension.js and ${views.map((v) => `${v.name}.js`).join(", ")}`);
}
