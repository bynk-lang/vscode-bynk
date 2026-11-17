// Context-name helpers shared by the Environments view, the Contract Diff
// filter, Send Request, scenarios and the deploy commands. A leaf module with
// no imports, so the webview bundle can use it without pulling in host code.
//
// A context is one Worker, named by turning its dots into hyphens, unless a
// `[deploy.workers.<key>]` group in `bynk.toml` puts it in a Worker with other
// contexts (Bynk v0.634+, `bynk-project/src/worker_groups.rs`). The group's
// *key* is then the Worker's identity: its directory under `workers/`, its
// ledger entry, its `--worker` selector and the name `bynk dev` serves it as.
// Every caller that needs "which Worker holds this context" goes through
// `workerKey` with the project's groups (`parseWorkerGroups`, `workerGroups.ts`).

/** One `[deploy.workers.<key>]` group. */
export interface WorkerGroup {
  /** The group's key: the Worker's directory name and ledger key. */
  key: string;
  /** The member contexts, as the manifest lists them (qualified names). */
  contexts: string[];
  /** The Cloudflare script name when `name` overrides the key. */
  name?: string;
}

/** The dasherised form of a dotted context name (`shop.orders` → `shop-orders`):
 *  the driver's own direction (`context.replace('.', "-")`,
 *  `bynk/src/deploy/plan.rs`), so matching stays correct if a context segment
 *  ever contains `-`. */
function dashed(context: string): string {
  return context.replace(/\./g, "-");
}

/** The group that holds `context` (dotted, or in its dashed form, as
 *  `--context` takes it), or `undefined` for a context on its own Worker. */
export function groupHolding(context: string, groups: readonly WorkerGroup[] | undefined): WorkerGroup | undefined {
  return groups?.find((g) => g.contexts.some((m) => m === context || dashed(m) === context));
}

/** The group whose key is `worker`, if any. */
export function groupByKey(worker: string, groups: readonly WorkerGroup[] | undefined): WorkerGroup | undefined {
  return groups?.find((g) => g.key === worker);
}

/** The Worker-directory key for a dotted context name: its group's key when a
 *  group holds it, else the dashed name. With no `groups` this is the ungrouped
 *  rule, exactly as before groups existed. */
export function workerKey(context: string, groups?: readonly WorkerGroup[]): string {
  return groupHolding(context, groups)?.key ?? dashed(context);
}

/** A context's dotted name from the ledger's Worker key. For display only:
 *  it is not the inverse of `workerKey` if a segment contains `-`, and a group's
 *  key is not a context at all (see `groupByKey`). */
export function contextFromWorker(worker: string): string {
  return worker.replace(/-/g, ".");
}

/** Whether a dotted (or Worker-key) `a` and `b` name one context. */
export function sameContext(a: string, b: string): boolean {
  return dashed(a) === dashed(b);
}

/** Whether `a` and `b` are held by one Worker: the same context, or two members
 *  of one group. */
export function sameWorker(a: string, b: string, groups?: readonly WorkerGroup[]): boolean {
  return workerKey(a, groups) === workerKey(b, groups);
}
