// Serializes the language server's start and restart (#31): the steps of a
// start (stop the old client, resolve or download a server, create and start a
// new client) must not interleave, or two clients end up running. No vscode
// dependency, so it is unit-testable.

export class StartQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private latest = 0;
  private current: AbortController | undefined;

  /** Run `task` after every earlier task has settled. `superseded()` turns true
   *  once a later `run` (or {@link cancelPending}) has been requested, so a task
   *  can skip creating work its successor is about to replace; `signal` aborts
   *  at the same moment, to cut short work already under way. */
  run<T>(
    task: (superseded: () => boolean, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.current?.abort();
    const abort = (this.current = new AbortController());
    const gen = ++this.latest;
    const result = this.tail.then(() =>
      task(() => gen !== this.latest, abort.signal),
    );
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Supersede everything queued or running, without queueing anything. */
  cancelPending(): void {
    this.latest++;
    this.current?.abort();
    this.current = undefined;
  }

  /** Resolves once everything queued so far has settled. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
