// Fails if the esbuild bundle (out/extension.js) has any unresolved external
// `require` other than `vscode` (which the host provides). This guards against
// the packaging regression shipped in 0.20.0, where the VSIX excluded
// node_modules but the code wasn't bundled, so `vscode-languageserver-protocol`
// (a transitive dep of vscode-languageclient) was missing at activation.
//
// With `--web` it checks the web extension (#2102) instead: the browser entry
// may require only `vscode`, the worker nothing at all (a browser has no Node
// builtins to fall back on), and the two bundles and the wasm module stay within
// their size budgets (DECISION C).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";

const out = (file) => new URL(`../out/${file}`, import.meta.url);
const requiresOf = (file) => [
  ...new Set(
    [...readFileSync(out(file), "utf8").matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]),
  ),
];

function checkNode() {
  const isBuiltin = (name) => builtinModules.includes(name.replace(/^node:/, ""));
  const unresolved = requiresOf("extension.js").filter(
    (name) => !name.startsWith(".") && !isBuiltin(name) && name !== "vscode",
  );

  if (unresolved.length > 0) {
    console.error("Unbundled external require(s) in out/extension.js:", unresolved);
    console.error("The extension must bundle all deps except `vscode`. Check the esbuild build.");
    process.exit(1);
  }

  console.log("Bundle OK — only Node builtins + `vscode` are external.");
}

// Budgets in bytes. The bundles are minified; the wasm is a `--release` build.
// wasm-opt -Oz shrinks it further when binaryen is installed, but the budget
// holds without it so a machine lacking wasm-opt still packages. Raise a budget
// deliberately, in the PR that needs it.
const WEB_BUDGETS = {
  "web/extension.js": 600 * 1024,
  "web/server.js": 400 * 1024,
  "web/bynk_wasm_bg.wasm": 12 * 1024 * 1024,
};

function checkWeb() {
  let failed = false;
  const fail = (msg) => {
    console.error(msg);
    failed = true;
  };

  const extra = requiresOf("web/extension.js").filter((name) => name !== "vscode");
  if (extra.length > 0) {
    fail(`out/web/extension.js requires more than \`vscode\`: ${JSON.stringify(extra)}`);
  }
  const workerRequires = requiresOf("web/server.js");
  if (workerRequires.length > 0) {
    fail(`out/web/server.js must not require anything: ${JSON.stringify(workerRequires)}`);
  }

  for (const [file, budget] of Object.entries(WEB_BUDGETS)) {
    const size = statSync(out(file)).size;
    const line = `out/${file}: ${(size / 1024).toFixed(0)} KiB (budget ${(budget / 1024).toFixed(0)} KiB)`;
    if (size > budget) fail(`over budget — ${line}`);
    else console.log(line);
  }

  if (failed) process.exit(1);
  console.log("Web bundle OK — self-contained and within budget.");
}

// With `--package` it checks what `vsce package` would ship (#39). The VSIX
// must hold only the bundles under `out/` (the extension, its webview
// bundles, and the web build) and no sources, compiled test output or repo
// tooling (anything outside the top-level entries below): `npm test` compiles the pure modules to `out/src/`, which a stale
// `.vscodeignore` would silently ship.
function checkPackage() {
  const files = execFileSync("npx", ["--no", "vsce", "ls", "--no-dependencies"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  })
    .split(/\r?\n/)
    .filter(Boolean);
  const allowedOut = /^out\/(?:[\w-]+\.js|web\/.+)$/;
  const shipped = /^(?:out|assets|snippets|syntaxes|themes|walkthroughs)\/|^(?:package\.json|README\.md|CHANGELOG\.md|LICENSE(?:-\w+)?(?:\.md)?|language-configuration\.json)$/;
  const stray = files.filter((f) => !shipped.test(f) || (f.startsWith("out/") && !allowedOut.test(f)));
  if (stray.length > 0) {
    console.error(`The VSIX would ship ${stray.length} stray file(s):`);
    for (const f of stray.slice(0, 20)) console.error(`  ${f}`);
    if (stray.length > 20) console.error(`  … and ${stray.length - 20} more`);
    console.error("Exclude them in .vscodeignore.");
    process.exit(1);
  }
  if (!files.includes("out/extension.js")) {
    console.error("The VSIX would not ship out/extension.js. Run `npm run build` first.");
    process.exit(1);
  }
  console.log(`Package OK — ${files.length} files, no stray build output.`);
}

if (process.argv.includes("--package")) {
  checkPackage();
} else if (process.argv.includes("--web")) {
  checkWeb();
} else {
  checkNode();
}
