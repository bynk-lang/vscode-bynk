// Context-name helpers shared by the Environments view and the Contract Diff
// filter. A leaf module with no imports, so the webview bundle can use it
// without pulling in host code.

/** The ledger's Worker key for a dotted context name: the driver's own
 *  direction (`context.replace('.', "-")`, `bynk/src/deploy/plan.rs`). Matching
 *  goes this way, so it stays correct if a context segment ever contains `-`. */
export function workerKey(context: string): string {
  return context.replace(/\./g, "-");
}

/** A context's dotted name from the ledger's Worker key. For display only:
 *  it is not the inverse of `workerKey` if a segment contains `-`. */
export function contextFromWorker(worker: string): string {
  return worker.replace(/-/g, ".");
}

/** Whether a dotted (or Worker-key) `a` and `b` name one context. */
export function sameContext(a: string, b: string): boolean {
  return workerKey(a) === workerKey(b);
}
