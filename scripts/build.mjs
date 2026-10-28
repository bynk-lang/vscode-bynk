// Build the extension: the Node entry (`out/extension.js`) and one browser
// bundle per webview (entry points are found by `// @webview-entry`; see
// webview-entries.mjs).
//
//   node scripts/build.mjs            minified, once
//   node scripts/build.mjs --watch    unminified, with sourcemaps, rebuilt on change
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { webviewEntries } from "./webview-entries.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const watch = process.argv.includes("--watch");

const views = webviewEntries();
if (views.length === 0) throw new Error("no `// @webview-entry` files in src/webview/");

const common = { absWorkingDir: root, bundle: true, minify: !watch, sourcemap: watch };
const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "out/extension.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node18",
  },
  ...views.map(({ entry, name }) => ({
    ...common,
    entryPoints: [entry],
    outfile: path.posix.join("out", `${name}.js`),
    format: "iife",
    platform: "browser",
    target: "es2022",
  })),
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log(`watching out/extension.js and ${views.map((v) => `${v.name}.js`).join(", ")}`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log(`built out/extension.js and ${views.map((v) => `${v.name}.js`).join(", ")}`);
}
