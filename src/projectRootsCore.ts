// #40: the project-root rule over plain paths, free of `vscode` so it runs
// under Node. A file's project is the nearest `bynk.toml` at or above it, but
// never above the workspace folder holding the file: a stray manifest in a
// parent such as the home directory is not the file's project.
//
// A file outside every workspace folder (a loose file the user opened on its
// own) walks up as it always did, so a scaffolded project's `src/main.bynk`
// still finds its project — but stops short of the home directory, so a stray
// `~/bynk.toml` is never taken, and at the filesystem root. Agent-steered paths
// don't reach this: they must lie in a workspace folder (`workspaceRootFor`).

export interface RootOptions {
  /** The home directory, as a path: a loose file's walk stops below it. */
  home?: string;
  /** Compare paths ignoring case (Windows). */
  caseInsensitive?: boolean;
}

/** `/`-separated, as a URI path is. */
const parentOf = (dir: string): string => dir.replace(/\/[^/]*$/, "") || "/";

const norm = (p: string, ci: boolean | undefined): string => {
  const t = p.replace(/\/+$/, "") || "/";
  return ci ? t.toLowerCase() : t;
};

/** The longest of `folders` that `path` is at or under, or `undefined`. */
export function containingFolder(path: string, folders: readonly string[], ci?: boolean): string | undefined {
  const p = norm(path, ci);
  let best: string | undefined;
  for (const folder of folders) {
    const f = norm(folder, ci);
    const under = f === "/" || p === f || p.startsWith(`${f}/`);
    if (under && (best === undefined || f.length > norm(best, ci).length)) best = folder.replace(/\/+$/, "");
  }
  return best;
}

/** The nearest directory from `start` up to `top` (inclusive) that
 *  `hasManifest`, or `undefined`. With `home` set, the walk also ends before
 *  reaching it. */
export async function findRoot(
  start: string,
  top: string,
  hasManifest: (dir: string) => Promise<boolean>,
  opts: RootOptions = {},
): Promise<string | undefined> {
  const ci = opts.caseInsensitive;
  const stop = norm(top, ci);
  const home = opts.home === undefined ? undefined : norm(opts.home, ci);
  let dir = start;
  for (;;) {
    if (home !== undefined && norm(dir, ci) === home) return undefined;
    if (await hasManifest(dir)) return dir;
    if (norm(dir, ci) === stop) return undefined;
    const parent = parentOf(dir);
    if (parent === dir || (stop !== "/" && parent.length < stop.length)) return undefined;
    dir = parent;
  }
}

/** Whether `file` lies in one of the workspace `folders`. */
export function inWorkspace(file: string, folders: readonly string[], opts: RootOptions = {}): boolean {
  return containingFolder(file, folders, opts.caseInsensitive) !== undefined;
}

/** The project root of `file` given the workspace `folders`: bounded by its
 *  folder, or, for a loose file, walking up to (not into) the home directory. */
export function resolveRoot(
  file: string,
  folders: readonly string[],
  hasManifest: (dir: string) => Promise<boolean>,
  opts: RootOptions = {},
): Promise<string | undefined> {
  const folder = containingFolder(file, folders, opts.caseInsensitive);
  const start = parentOf(file);
  return folder === undefined ? findRoot(start, "/", hasManifest, opts) : findRoot(start, folder, hasManifest, { caseInsensitive: opts.caseInsensitive });
}

/** A promise-per-key cache of resolved roots that never hands back one whose
 *  `bynk.toml` has since gone (#61): a hit costs one `stillHasManifest` check,
 *  and a stale entry is dropped and resolved again. A directory deleted outside
 *  VS Code raises no event the watchers would see, so the cache can't rely on
 *  them alone. */
export class RootCache<T> {
  private readonly entries = new Map<string, Promise<T | undefined>>();

  async get(
    key: string,
    resolve: () => Promise<T | undefined>,
    stillHasManifest: (root: T) => Promise<boolean>,
  ): Promise<T | undefined> {
    const hit = this.entries.get(key);
    if (hit) {
      const root = await hit;
      if (root === undefined || (await stillHasManifest(root))) return root;
      // Only drop the entry we checked: a concurrent caller may have replaced it.
      if (this.entries.get(key) === hit) this.entries.delete(key);
    }
    const fresh = this.entries.get(key) ?? resolve();
    this.entries.set(key, fresh);
    return fresh;
  }

  clear(): void {
    this.entries.clear();
  }
}
