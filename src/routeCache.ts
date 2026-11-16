// The scenario route index's cache policy (`scenario.ts`'s `RouteIndex`), kept
// free of `vscode` so it is unit-tested.
//
// A route set is built from the language server's answers, and the server can
// be asked before it has analysed a project: just after it starts, or when a
// project appears (a fixture copied in, a folder added). Its answers then are
// not "no routes", they are "can't say yet", and the set is built `complete:
// false`. The cache never keeps such a set, so the next ask builds again; and
// when the server next commits an analysis round, `roundCommitted` says the
// sets may now be different, so their users can check again (re-validate the
// open scenarios).
//
// Before this, an early, empty answer was cached as complete until a `.bynk`
// file changed. In a project nobody edits (the promote integration test's
// fixture) that was for good: every scenario step said "No handler serves" and
// Promote said "No step resolves to a route".

/** What the cache holds: whether a build had the server's full answer. */
export interface Completable {
  complete: boolean;
}

export class RouteCache<T extends Completable> {
  private generation = 0;
  private readonly entries = new Map<string, { generation: number; value: Promise<T> }>();
  /** A build came back incomplete since the last round: the next round may
   *  answer it. */
  private sawIncomplete = false;

  /** The set for `key`: the cached one if still current, else a new build. */
  get(key: string, build: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.generation === this.generation) return hit.value;
    const generation = this.generation;
    const value = build();
    const entry = { generation, value };
    this.entries.set(key, entry);
    value.then(
      (set) => {
        if (set.complete) return;
        this.sawIncomplete = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return value;
  }

  /** A source changed: every cached set may be stale. */
  invalidate(): void {
    this.generation++;
  }

  /** The server committed an analysis round. Returns whether a set built
   *  since the last round was incomplete, so the round may change it and its
   *  users should look again. */
  roundCommitted(): boolean {
    if (!this.sawIncomplete) return false;
    this.sawIncomplete = false;
    this.generation++;
    return true;
  }
}
