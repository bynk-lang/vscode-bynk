// The Test Explorer's tree: its items, how they are found, tagged and planned from,
// and which projects a request covers. Split out of `testing.ts`.

import * as vscode from "vscode";

import { projectRootFor } from "./projectRoots";
import {
  projectOf,
  scopeSuiteId,
  TIERS,
  tierOf,
  isDocExample,
  docGroupId,
  isDocGroupId,
  itemRefs,
  type ItemRef,
  type JsonCase,
  type JsonLocation,
  type JsonSuite,
  type PlanCase,
  type RequestRef,
  type Tier,
} from "./testPlan";

/** The first discovered case item labelled `name`, across every suite — the
 *  per-case run/debug target (v0.127). Case names are unique within a suite; a
 *  cross-suite clash resolves to the first, matching the CLI's `--case`. */
export function findCase(ctrl: vscode.TestController, name: string): vscode.TestItem | undefined {
  // A lens sits in the active file, so a name two projects share means that file's.
  const active = vscode.window.activeTextEditor?.document.uri.toString();
  let found: vscode.TestItem | undefined;
  forEachCase(ctrl, (c) => {
    if (c.label !== name) return;
    if (!found || (c.uri?.toString() === active && found.uri?.toString() !== active)) found = c;
  });
  return found;
}

/** Every project item: the tree's top level holds one per Bynk project. */
export function forEachProject(ctrl: vscode.TestController, fn: (project: vscode.TestItem) => void): void {
  ctrl.items.forEach(fn);
}

/** Every suite item, across all projects. */
export function forEachSuite(ctrl: vscode.TestController, fn: (suite: vscode.TestItem) => void): void {
  forEachProject(ctrl, (project) => project.children.forEach(fn));
}

/** Every case item, across all projects. */
export function forEachCase(ctrl: vscode.TestController, fn: (c: vscode.TestItem) => void): void {
  forEachSuite(ctrl, (suite) => suiteCases(suite).forEach((c) => fn(c)));
}

/** A suite's case items: its direct children, and those of its "Doc examples" group
 *  node, which is not a case itself. The one walk over a suite's cases. */
export function suiteCases(suite: vscode.TestItem): vscode.TestItem[] {
  const cases: vscode.TestItem[] = [];
  suite.children.forEach((child) => {
    if (isDocGroupId(child.id)) child.children.forEach((c) => void cases.push(c));
    else cases.push(child);
  });
  return cases;
}

/** The case item `id` (its full id) of a suite, wherever it sits. */
export function suiteCase(suite: vscode.TestItem, id: string): vscode.TestItem | undefined {
  return suiteCases(suite).find((c) => c.id === id);
}

/** The case item with this full id in the suite `suiteId`, if both exist. */
export function findCaseById(ctrl: vscode.TestController, suiteId: string, id: string): vscode.TestItem | undefined {
  const suite = findSuite(ctrl, suiteId);
  return suite && suiteCase(suite, id);
}

/** The suite item with this (project-scoped) id. */
export function findSuite(ctrl: vscode.TestController, suiteId: string): vscode.TestItem | undefined {
  const scope = projectOf(suiteId);
  return scope === undefined ? undefined : ctrl.items.get(scope)?.children.get(suiteId);
}

/** A project's name in messages: its folder. */
export function projectLabel(root: vscode.Uri): string {
  return root.path.split("/").filter(Boolean).pop() ?? root.fsPath;
}

/** The project item for `root`, created on first use. */
export function projectItem(ctrl: vscode.TestController, root: vscode.Uri): vscode.TestItem {
  const id = root.toString();
  let item = ctrl.items.get(id);
  if (!item) {
    item = ctrl.createTestItem(id, projectLabel(root), root);
    item.description = vscode.workspace.asRelativePath(root, false);
    ctrl.items.add(item);
  }
  return item;
}

/** A comparable key for a source file: its path, folded on Windows where paths
 *  are case-insensitive. Used both for a case's file and for the active file. */
export function fileKey(uri: vscode.Uri): string {
  return process.platform === "win32" ? uri.fsPath.toLowerCase() : uri.fsPath;
}

/** One tag per tier, so the Testing view's filter selects by tier. The tag id is
 *  the tier's own name. */
export const tierTags = new Map<Tier, vscode.TestTag>(TIERS.map((t) => [t, new vscode.TestTag(t)]));

/** The tag every doc-comment example's case carries (#2461), so the Testing view's
 *  filter shows the doc examples, or leaves them out, as a group. */
export const docTag = new vscode.TestTag("doc-example");

/** The case item a command was given: the tree item itself, or anything with its
 *  id (a menu hands over the item; the tests hand over an id). */
export function caseItem(ctrl: vscode.TestController, arg: unknown): vscode.TestItem | undefined {
  const id = typeof arg === "string" ? arg : (arg as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string") return undefined;
  let found: vscode.TestItem | undefined;
  forEachSuite(ctrl, (suite) => {
    const c = suiteCase(suite, id);
    if (c) found = c;
  });
  if (found) return found;
  // An id without its project scope names the case when only one project has it.
  const matches: vscode.TestItem[] = [];
  forEachCase(ctrl, (c) => {
    if (c.id.endsWith(`|${id}`)) matches.push(c);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** The tier a case item is tagged with, if any. */
export function tierOfItem(item: vscode.TestItem): Tier | undefined {
  return TIERS.find((t) => item.tags.some((tag) => tag.id === t));
}

/** The tree as the run plan sees it: every discovered case with its suite, file
 *  and tier. */
export function planCases(ctrl: vscode.TestController): PlanCase[] {
  const cases: PlanCase[] = [];
  forEachSuite(ctrl, (suite) => {
    for (const c of suiteCases(suite)) {
      cases.push({
        suiteId: suite.id,
        name: c.label,
        file: c.uri ? fileKey(c.uri) : undefined,
        tier: tierOfItem(c),
      });
    }
  });
  return cases;
}

/** A request's include/exclude lists as plain references (see `itemRefs`). */
export function requestRef(request: vscode.TestRunRequest): RequestRef {
  const refs = (i: vscode.TestItem): ItemRef[] => itemRefs(i);
  return { include: request.include?.flatMap(refs), exclude: request.exclude?.flatMap(refs) };
}

/** The project roots a request covers: those of the items it includes, or every
 *  project in the tree when it includes none ("Run All"). Never the active editor's. */
export function requestRoots(ctrl: vscode.TestController, request: vscode.TestRunRequest): vscode.Uri[] {
  const roots = new Map<string, vscode.Uri>();
  const add = (item: vscode.TestItem): void => {
    let top = item;
    while (top.parent) top = top.parent;
    if (top.uri) roots.set(top.id, top.uri);
  };
  if (request.include?.length) request.include.forEach(add);
  else forEachProject(ctrl, add);
  return [...roots.values()];
}

/** The roots to run a request in: those of its items, and for a request with none
 *  ("Run All") also every project in the workspace, since eager discovery only
 *  reaches the projects the user has touched. */
export async function requestedRoots(ctrl: vscode.TestController, request: vscode.TestRunRequest): Promise<vscode.Uri[]> {
  const roots = new Map(requestRoots(ctrl, request).map((r) => [r.toString(), r]));
  if (!request.include?.length) for (const r of await workspaceRoots()) roots.set(r.toString(), r);
  return [...roots.values()];
}

/** The Bynk projects in the workspace: the directory of every `bynk.toml`. */
export async function workspaceRoots(): Promise<vscode.Uri[]> {
  const manifests = await vscode.workspace.findFiles("**/bynk.toml", "**/node_modules/**");
  const roots = new Map<string, vscode.Uri>();
  for (const m of manifests) {
    const root = vscode.Uri.joinPath(m, "..");
    roots.set(root.toString(), root);
  }
  // A project opened from outside the workspace folders is still the editor's own.
  const active = vscode.window.activeTextEditor?.document;
  if (active?.languageId === "bynk" && active.uri.scheme === "file") {
    const root = await projectRootFor(active.uri);
    if (root) roots.set(root.toString(), root);
  }
  return [...roots.values()].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

/** Delete every item in `collection` whose id is not in `keep`. Collected first,
 *  then deleted, to avoid mutating the collection mid-iteration. */
export function prune(
  collection: vscode.TestItemCollection,
  keep: Set<string>,
): void {
  const stale: string[] = [];
  collection.forEach((item) => {
    if (!keep.has(item.id)) stale.push(item.id);
  });
  for (const id of stale) collection.delete(id);
}

/** A `path:line:col` document location as a 0-indexed VS Code `Position` (the
 *  document's line/col are 1-indexed). */
export function sourcePosition(loc: JsonLocation): vscode.Position {
  return new vscode.Position(Math.max(0, loc.line - 1), Math.max(0, loc.col - 1));
}

export const PREFIX = "bynk-test:";

/** A suite item's id: its kind and name, so a unit and an integration suite of
 *  the same name stay distinct, namespaced by its project's `scope` so two
 *  projects can both have a suite of that name. */
export function suiteIdOf(suite: JsonSuite, scope?: string): string {
  return scopeSuiteId(scope, `${PREFIX}${suite.kind}:${suite.name}`);
}

/** Find or create a suite item under its `project`. With `place`, the item's `uri`
 *  is brought in line with `place.uri` (discovery knows the cases' files); without
 *  it, an existing item is left as it is (a run document's passing cases carry no
 *  location). */
export function upsertSuite(
  ctrl: vscode.TestController,
  project: vscode.TestItem,
  suite: JsonSuite,
  root: vscode.Uri,
  place?: { uri: vscode.Uri | undefined },
): vscode.TestItem {
  const id = suiteIdOf(suite, root.toString());
  let item = project.children.get(id);
  if (item && place && item.uri?.toString() !== place.uri?.toString()) {
    project.children.delete(id);
    item = undefined;
  }
  if (!item) {
    const label = suite.kind === "integration" ? `${suite.name} (integration)` : suite.name;
    item = ctrl.createTestItem(id, label, place?.uri);
    project.children.add(item);
  }
  return item;
}

/** The suite's "Doc examples" group node, created on first use. */
function docGroup(ctrl: vscode.TestController, suiteItem: vscode.TestItem): vscode.TestItem {
  const id = docGroupId(suiteItem.id);
  let group = suiteItem.children.get(id);
  if (!group) {
    group = ctrl.createTestItem(id, "Doc examples");
    suiteItem.children.add(group);
  }
  return group;
}

/** Delete the suite's cases not in `live`, and the group node once it holds none. */
export function pruneCases(suiteItem: vscode.TestItem, live: Set<string>): void {
  const groupId = docGroupId(suiteItem.id);
  const group = suiteItem.children.get(groupId);
  if (group) {
    prune(group.children, live);
    if (group.children.size === 0) suiteItem.children.delete(groupId);
  }
  prune(suiteItem.children, new Set([...live, ...(group && group.children.size > 0 ? [groupId] : [])]));
}

export function upsertCase(
  ctrl: vscode.TestController,
  suiteItem: vscode.TestItem,
  c: JsonCase,
  root: vscode.Uri,
  legacyKind?: string,
): vscode.TestItem {
  const id = `${suiteItem.id}::${c.name}`;
  const doc = isDocExample(c);
  const parent = doc ? docGroup(ctrl, suiteItem) : suiteItem;
  let item = parent.children.get(id);
  if (!item) {
    // A case that changed between doc and ordinary moves: deleted from the old
    // parent and recreated, under the same id, in the right one.
    const other = doc ? suiteItem : suiteItem.children.get(docGroupId(suiteItem.id));
    other?.children.delete(id);
    if (!doc && other?.children.size === 0) suiteItem.children.delete(other.id);
    // A discovered case carries its declaration `location`, so the tree links to
    // the `.bynk` source before any run. The uri is fixed at creation; the range
    // is refreshed each pass (a passing run case carries no location, so we never
    // clobber a discovered one with `undefined`).
    const uri = c.location
      ? vscode.Uri.joinPath(root, c.location.path)
      : undefined;
    item = ctrl.createTestItem(id, c.name, uri);
    parent.children.add(item);
  }
  if (c.location) {
    const pos = sourcePosition(c.location);
    item.range = new vscode.Range(pos, pos);
  }
  // The tier tag: the driver's per-case tier (the suite's kind only for a driver
  // that predates it). Left as it was when none is known, so a document without
  // one never clears a tag.
  const tier = tierOf(c, legacyKind);
  const tags: vscode.TestTag[] = [];
  if (tier) tags.push(tierTags.get(tier) as vscode.TestTag);
  if (isDocExample(c)) tags.push(docTag);
  if (tags.length > 0) item.tags = tags;
  return item;
}
