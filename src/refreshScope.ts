// #38: scoping a refresh to the projects that changed. Dependency-free (no
// `vscode` import) so the unit tests compile against it directly.

/** What a refresh covers: every project, or just these project roots (URI strings). */
export type Scope = "all" | ReadonlySet<string>;

/** `a` and `b` together: "all" absorbs everything. */
export function mergeScope(a: Scope | undefined, b: Scope): Scope {
  if (a === undefined) return b;
  if (a === "all" || b === "all") return "all";
  return new Set([...a, ...b]);
}

export function inScope(scope: Scope, root: string): boolean {
  return scope === "all" || scope.has(root);
}

/** Run `fn` over `items` with at most `limit` in flight, keeping the result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Per-key generations: a run records its generation when it starts and may
 *  cache its result only if it is still current when it finishes. */
export class Generations {
  private all = 0;
  private readonly each = new Map<string, number>();

  current(key: string): number {
    return this.all + (this.each.get(key) ?? 0);
  }

  /** Invalidate one key's in-flight runs, or every key's when `key` is omitted. */
  bump(key?: string): void {
    if (key === undefined) this.all++;
    else this.each.set(key, (this.each.get(key) ?? 0) + 1);
  }

  isCurrent(key: string, generation: number): boolean {
    return this.current(key) === generation;
  }
}

/** A file's identity for cache purposes: changes whenever its content plausibly did. */
export function statStamp(stat: { mtimeMs: number; size: number } | undefined): string {
  return stat ? `${stat.mtimeMs}:${stat.size}` : "-";
}

/** The `bynk deps` cache key: the manifest and the lock it resolves against. */
export function depsKey(manifest: string, lock: string): string {
  return `${manifest}|${lock}`;
}

/** Which of `roots` (longest match wins, so a nested project owns its files)
 *  contain each of `paths`; a path under none is reported as `unknown`. */
export function rootsFor(
  paths: readonly string[],
  roots: readonly string[],
  sep = "/",
): { roots: Set<string>; unknown: boolean } {
  const found = new Set<string>();
  let unknown = false;
  for (const p of paths) {
    let best: string | undefined;
    for (const r of roots) {
      const dir = r.endsWith(sep) ? r : r + sep;
      if ((p === r || p.startsWith(dir)) && (best === undefined || r.length > best.length)) best = r;
    }
    if (best === undefined) unknown = true;
    else found.add(best);
  }
  return { roots: found, unknown };
}

/** Group `items` by their project root; items with no root are left out. */
export function groupByRoot<T extends { root: string | undefined }>(
  items: readonly T[],
): Map<string, (T & { root: string })[]> {
  const out = new Map<string, (T & { root: string })[]>();
  for (const item of items) {
    if (item.root === undefined) continue;
    const list = out.get(item.root) ?? [];
    list.push(item as T & { root: string });
    out.set(item.root, list);
  }
  return out;
}
