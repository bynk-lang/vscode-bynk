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

// Model-diagrams slice 6: the pages that lay out with ELK share the one copy
// in `out/elk.js` (the `elk` entry, `src/webview/vendor-elk.ts`) instead of
// bundling their own. Their `import ELK from "elkjs/lib/elk.bundled.js"`
// resolves to the global that script sets; the host loads it first
// (`vendorScripts` in `livePanel.ts`, and the model diff's page). Mermaid is no
// longer a dependency: the views draw with the diagram engine, and "Copy as
// Mermaid" only writes text.
const sharedElk = {
  name: "shared-elk",
  setup(build) {
    build.onResolve({ filter: /^elkjs\/lib\/elk\.bundled\.js$/ }, () => ({ path: "elk", namespace: "bynk-shared-elk" }));
    build.onLoad({ filter: /.*/, namespace: "bynk-shared-elk" }, () => ({
      contents: "export default globalThis.__BYNK_ELK__;",
      loader: "js",
    }));
  },
};
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
    plugins: name === "elk" ? [] : [sharedElk],
  })),
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log(`watching out/extension.js and ${views.map((v) => `${v.name}.js`).join(", ")}`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log(`built out/extension.js and ${views.map((v) => `${v.name}.js`).join(", ")}`);
}
