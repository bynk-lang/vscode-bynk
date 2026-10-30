// #40: the project-root rule over plain paths, free of `vscode` so it runs
// under Node. A file's project is the nearest `bynk.toml` at or above it, but
// never above the workspace folder holding the file: a stray manifest in a
// parent such as the home directory is not the file's project.
//
// A file outside every workspace folder (a loose file) looks at its own
// directory only. That keeps a standalone project opened from outside the
// workspace working without climbing anywhere unvetted.

/** `/`-separated, as a URI path is. */
const parentOf = (dir: string): string => dir.replace(/\/[^/]*$/, "") || "/";

/** The longest of `folders` that `path` is at or under, or `undefined`. */
export function containingFolder(path: string, folders: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const folder of folders) {
    const f = folder.replace(/\/+$/, "");
    if ((path === f || path.startsWith(`${f}/`)) && (best === undefined || f.length > best.length)) best = f;
  }
  return best;
}

/** The directory the lookup for `file` starts in and the highest it may reach. */
export function searchBounds(file: string, folders: readonly string[]): { start: string; top: string } {
  const start = parentOf(file);
  return { start, top: containingFolder(file, folders) ?? start };
}

/** The nearest directory from `start` up to `top` (inclusive) that
 *  `hasManifest`, or `undefined`. */
export async function findRoot(
  start: string,
  top: string,
  hasManifest: (dir: string) => Promise<boolean>,
): Promise<string | undefined> {
  const stop = top.replace(/\/+$/, "") || "/";
  let dir = start;
  for (;;) {
    if (await hasManifest(dir)) return dir;
    if (dir === stop) return undefined;
    const parent = parentOf(dir);
    // Past `top` (a start outside it) or at the filesystem root: give up.
    if (parent === dir || parent.length < stop.length) return undefined;
    dir = parent;
  }
}

/** The project root of `file` given the workspace `folders`. */
export function resolveRoot(
  file: string,
  folders: readonly string[],
  hasManifest: (dir: string) => Promise<boolean>,
): Promise<string | undefined> {
  const { start, top } = searchBounds(file, folders);
  return findRoot(start, top, hasManifest);
}
