// Test discovery: `bynk test --no-run` per project, reconciled onto the tree.
// Split out of `testing.ts`.

import * as vscode from "vscode";

import { projectRootFor } from "./projectRoots";
import { testFailures } from "./fileDecorationsCore";
import { carriesTiers, suiteFile, type JsonSuite, type TestRun } from "./testPlan";
import { fingerprintOf, migrateLegacyPins } from "./testSeeds";
import { describePins, savePins, type SeedState } from "./testSeedState";
import { runBynkcTest } from "./testDriver";
import type { RunEnv } from "./testEnv";
import { forEachCase, projectItem, prune, upsertCase, upsertSuite, workspaceRoots } from "./testTree";

/** Discover tests without running them: shell `bynk test --no-run --format
 *  json` (a pure compile that lists suites/cases — no `tsc`, no `node`, no test
 *  execution) and (re)build each project's subtree from its document. Backs both
 *  the resolve (view-open) and refresh handlers, and the eager triggers, which pass
 *  `only` — the files that changed — to discover just their projects. Stale suites
 *  and cases are pruned so a removed test disappears on refresh, and a project whose
 *  `bynk.toml` is gone with it; a transient failure leaves the tree untouched, and a
 *  project that does not compile keeps its tests and shows the error on its item.
 *  Compile errors are not routed to the Problems panel: the language
 *  server reports them live, and this compile sees only what is saved. */
export async function discover(
  env: RunEnv,
  only?: vscode.Uri[],
  token?: vscode.CancellationToken,
): Promise<void> {
  const { ctrl, problems, seeds } = env;
  let roots: vscode.Uri[];
  if (only) {
    const owners = new Map<string, vscode.Uri>();
    for (const file of only) {
      const root = await projectRootFor(file);
      if (root) owners.set(root.toString(), root);
    }
    roots = [...owners.values()];
  } else {
    roots = await workspaceRoots();
  }
  // A full pass also forgets a project that is no longer in the workspace.
  if (!only) prune(ctrl.items, new Set(roots.map((r) => r.toString())));
  if (roots.length === 0) return;
  // Old pins can only be attributed to a project when the workspace holds just one.
  const all = only ? await workspaceRoots() : roots;
  const onlyProject = all.length === 1;

  for (const root of roots) {
    if (token?.isCancellationRequested) return;
    let doc: TestRun;
    try {
      doc = await runBynkcTest(root, token, { noRun: true });
    } catch {
      continue; // network/exec hiccup — keep whatever the tree already shows
    }
    const project = projectItem(ctrl, root);
    if (doc.error?.kind === "compile") {
      // Say why the project has no (or stale) tests, rather than leave it unexplained.
      const first = doc.error.diagnostics?.[0];
      project.error = `This project does not compile, so its tests cannot be listed${first ? `: ${first}` : "."}`;
      continue;
    }
    project.error = undefined;
    // The compile is clean now: an earlier run's errors for this project are stale.
    const own = (uri: vscode.Uri): boolean => {
      const nearest = all.map((r) => r.toString() + "/").filter((p) => uri.toString().startsWith(p));
      return nearest.sort((a, b) => b.length - a.length)[0] === `${root.toString()}/`;
    };
    problems.forEach((uri) => {
      if (own(uri)) problems.delete(uri);
    });
    reconcile(ctrl, seeds, doc.suites ?? [], root, onlyProject);
  }
}

/** Bring one project's subtree in line with `suites`: upsert each suite and its
 *  cases, then delete any item no longer present in the document. */
export function reconcile(
  ctrl: vscode.TestController,
  seeds: SeedState,
  suites: JsonSuite[],
  root: vscode.Uri,
  onlyProject: boolean,
): void {
  const project = projectItem(ctrl, root);
  const liveSuites = new Set<string>();
  const legacy = !carriesTiers(suites);
  for (const suite of suites) {
    // A suite links to its file when all its cases are declared in one. The item's
    // `uri` is fixed at creation, so a suite whose file changed is recreated.
    const file = suiteFile(
      suite.cases.map((c) => (c.location ? vscode.Uri.joinPath(root, c.location.path).toString() : undefined)),
    );
    const suiteItem = upsertSuite(ctrl, project, suite, root, { uri: file ? vscode.Uri.parse(file) : undefined });
    liveSuites.add(suiteItem.id);
    seeds.generative.set(suiteItem.id, fingerprintOf(suite.cases));

    const liveCases = new Set<string>();
    for (const c of suite.cases) {
      liveCases.add(upsertCase(ctrl, suiteItem, c, root, legacy ? suite.kind : undefined).id);
    }
    prune(suiteItem.children, liveCases);
  }
  prune(project.children, liveSuites);
  const liveCaseIds = new Set<string>();
  forEachCase(ctrl, (c) => liveCaseIds.add(c.id));
  testFailures.retain(liveCaseIds);
  // A pin for a case that is gone has nothing to attach to; the others show
  // whether they still hold.
  let changed = false;
  // Pins from before ids were project-scoped belong to the only project there is.
  if (onlyProject && migrateLegacyPins(seeds.pins, root.toString())) changed = true;
  for (const key of [...seeds.pins.keys()]) {
    const suiteId = key.slice(0, key.indexOf("::"));
    if (liveSuites.has(suiteId) && !project.children.get(suiteId)?.children.get(key)) {
      seeds.pins.delete(key);
      changed = true;
    }
  }
  if (changed) void savePins(seeds);
  describePins(ctrl, seeds);
}
