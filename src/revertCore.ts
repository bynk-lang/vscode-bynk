// #222 (Part 1): the pure core of "Revert…", a wrapper over `bynk revert`.
//
// `bynk revert` (v0.639.1) makes a Worker's previous deployment live again,
// after checking what makes that unsafe: D1 migrations the live version applied,
// agent state stamped with a newer schema, contract skew against the other live
// Workers, a replaced resource id, a secret change. "Every unknown is a refusal,
// and a refusal changes nothing."
//
// The flow (revert.ts) is: `bynk revert --dry-run --format json`, shown as the
// CLI printed it; then, only if nothing was refused, a confirmation naming the
// environment and the Workers (and a typed one for a production-like
// environment); then the real revert, streamed to an output channel.
//
// DECISION C (differs from Deploy and Sweep, which open a terminal and never pass
//   `--yes`): the real revert runs as a child process with its output streamed to
//   the "Bynk Revert" channel, so `--yes` is needed. The gate is the one the user
//   has just passed: the dry run's verdict, shown in full, then a modal naming the
//   environment and Worker(s) (a typed name for production). `--yes` "never
//   overrides a refusal", and bynk re-checks before it changes anything.
// DECISION A: the arguments are built here and nowhere else. They never carry
//   `--accept-schema-ahead` or `--accept-secret-changes` (the CLI's own override
//   of a refusal: the editor never makes that call for the user), and `--to` is
//   not offered. `--yes` is passed only on the real run, after the dry run and
//   the confirmation: the child has no terminal to answer a prompt on, and
//   `--yes` "never overrides a refusal".
// DECISION B: credentials are the CLI's. The extension never reads, stores,
//   prompts for or logs `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`; when
//   the CLI says they are missing, `credentialsMessage` says so and points to
//   the docs.
//
// Dependency-free (no `vscode`), so the unit tests run in plain mocha.

import type { WorkerGroup } from "./contextNames";
import { validContextName, validEnvironmentName } from "./deployPlan";
import { isProductionEnvironment, typedConfirmation } from "./migrationsCore";
import { resolveScope } from "./workerGroups";

export interface RevertTarget {
  environment: string;
  /** One context's own Worker (dotted name, or its Worker directory). */
  context?: string;
  /** One Worker by its directory name: a group's key. A group goes back as one. */
  worker?: string;
}

/** The `bynk revert` argument list. `--context` and `--worker` are exclusive in
 *  the CLI, so a `worker` wins. The values are checked here, whatever the
 *  caller did, so none can read as a flag (`--env --yes`). */
export function revertArgs(target: RevertTarget, mode: "dryRun" | "run"): string[] {
  if (!validEnvironmentName(target.environment)) throw new Error(`not an environment name: ${JSON.stringify(target.environment)}`);
  if (target.context !== undefined && !validContextName(target.context)) {
    throw new Error(`not a context name: ${JSON.stringify(target.context)}`);
  }
  if (target.worker !== undefined && !validContextName(target.worker)) {
    throw new Error(`not a Worker name: ${JSON.stringify(target.worker)}`);
  }
  const args = ["revert"];
  if (mode === "dryRun") args.push("--dry-run", "--format", "json");
  else args.push("--yes");
  args.push("--env", target.environment);
  if (target.worker) args.push("--worker", target.worker);
  else if (target.context) args.push("--context", target.context);
  return args;
}

/** What a revert target comes to for `name` (a context node's context, or a
 *  group's key): a member of a group is refused by `--context`, so it becomes the
 *  group's Worker, which goes back with all its members. */
export function revertScopeFor(
  name: string,
  groups: readonly WorkerGroup[],
): { target: { context?: string; worker?: string }; group?: WorkerGroup; member: boolean } {
  const r = resolveScope(name, groups);
  if (r.kind === "context") return { target: { context: r.context }, member: false };
  return { target: { worker: r.worker }, group: r.group, member: r.member };
}

// ---------------------------------------------------------------------------
// The dry run's result

export interface RevertCheck {
  check: string;
  code: string;
  subject: string;
  verdict: string;
  detail: string;
}

export interface RevertWorker {
  worker: string;
  script: string;
  liveVersion: string;
  targetVersion: string;
  checks: RevertCheck[];
  ok: boolean;
  lockChanges: boolean;
}

export interface RevertPlan {
  environment: string;
  workers: RevertWorker[];
  ok: boolean;
  notes: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Parse `bynk revert --dry-run --format json` (`version: 1`). Throws on
 *  anything that is not that document: an unknown shape is a refusal. */
export function parseRevertPlan(text: string): RevertPlan {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object") throw new Error("not a revert plan");
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1 || !Array.isArray(doc.workers) || typeof doc.ok !== "boolean") throw new Error("not a revert plan (version 1)");
  const workers = doc.workers.map((w): RevertWorker => {
    const o = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
    const checks = (Array.isArray(o.checks) ? o.checks : []).map((c): RevertCheck => {
      const k = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      return { check: str(k.check), code: str(k.code), subject: str(k.subject), verdict: str(k.verdict), detail: str(k.detail) };
    });
    return {
      worker: str(o.worker),
      script: str(o.script),
      liveVersion: str(o.live_version),
      targetVersion: str(o.target_version),
      checks,
      ok: o.ok === true,
      lockChanges: o.lock_changes === true,
    };
  });
  return {
    environment: str(doc.environment),
    workers,
    ok: doc.ok,
    notes: (Array.isArray(doc.notes) ? doc.notes : []).filter((n): n is string => typeof n === "string"),
  };
}

/** What the dry run came to. The `verdict` values are undocumented at v0.639.1
 *  (bynk-lang/bynk#3797), so only `"refused"` is recognised, and readiness also
 *  needs `ok` and exit 0. A plan with `ok` false (or a worker not ok, or any
 *  check refused) is `refused`: every unknown is a refusal. */
export type RevertOutcome =
  | { kind: "ready"; plan: RevertPlan }
  | { kind: "refused"; plan: RevertPlan }
  | { kind: "credentials"; detail: string }
  | { kind: "failed"; detail: string }
  | { kind: "cancelled" };

/** Whether `bynk` said it has no Cloudflare credentials (the message names the
 *  variables). Only the CLI's own words are read: never the environment. The
 *  CLI gives no JSON and no code for this case at v0.639.1, so the text is all
 *  there is to match (bynk-lang/bynk#3797). */
export function mentionsMissingCredentials(text: string): boolean {
  return /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/.test(text);
}

export function revertOutcome(result: { code: number | null; stdout: string; stderr: string }, cancelled: boolean): RevertOutcome {
  if (cancelled) return { kind: "cancelled" };
  let plan: RevertPlan | undefined;
  try {
    plan = parseRevertPlan(result.stdout);
  } catch {
    plan = undefined;
  }
  if (plan) {
    const clean =
      result.code === 0 &&
      plan.ok &&
      plan.workers.length > 0 &&
      plan.workers.every((w) => w.ok && w.checks.every((c) => c.verdict !== "refused"));
    return clean ? { kind: "ready", plan } : { kind: "refused", plan };
  }
  const detail = (result.stderr.trim() || result.stdout.trim() || `bynk revert exited with ${result.code ?? "a signal"}`).trim();
  return mentionsMissingCredentials(detail) ? { kind: "credentials", detail } : { kind: "failed", detail };
}

export const CREDENTIALS_DOCS = "https://bynk-lang.org/book/";

/** What to tell the user when the CLI reports missing credentials. */
export function credentialsMessage(): string {
  return (
    "`bynk revert` needs CLOUDFLARE_API_TOKEN (with D1 read access) and CLOUDFLARE_ACCOUNT_ID in the environment VS Code runs in. " +
    "The extension never stores, reads or asks for them: set them where you start VS Code (or in its terminal environment), restart it, and try again. " +
    `See the deploy chapter of the Bynk book: ${CREDENTIALS_DOCS}`
  );
}

// ---------------------------------------------------------------------------
// Text

/** The dry run as the CLI reports it, one line per check, details verbatim. */
export function formatRevertPlan(plan: RevertPlan): string[] {
  const lines: string[] = [];
  for (const w of plan.workers) {
    const move = w.liveVersion || w.targetVersion ? `${w.liveVersion || "?"} -> ${w.targetVersion || "?"}` : "";
    lines.push(`revert ${w.worker}${w.script && w.script !== w.worker ? ` (${w.script})` : ""} (env ${plan.environment}): ${move}`.trimEnd());
    for (const c of w.checks) {
      lines.push(`  ${c.check.padEnd(9)} ${c.subject}: ${c.verdict}${c.detail ? `: ${c.detail}` : ""}${c.code ? `  [${c.code}]` : ""}`);
    }
    if (w.lockChanges) lines.push("  bynk.deploy.lock would change");
  }
  for (const n of plan.notes) lines.push(`note: ${n}`);
  lines.push(plan.ok ? "Nothing refused: this revert is possible." : "Refused: nothing was changed.");
  return lines;
}

/** The Workers a plan covers, naming each group's members: a group goes back as one. */
export function workerLines(plan: RevertPlan, groups: readonly WorkerGroup[]): string[] {
  return plan.workers.map((w) => {
    const g = groups.find((x) => x.key === w.worker);
    const versions = w.liveVersion || w.targetVersion ? `: ${w.liveVersion || "?"} → ${w.targetVersion || "?"}` : "";
    return g
      ? `${w.worker}${versions} (a Worker group: ${g.contexts.join(", ")} all go back together)`
      : `${w.worker}${versions}`;
  });
}

export interface Confirmation {
  title: string;
  detail: string;
  button: string;
  /** Production-like: the phrase to type as a second confirmation. */
  typed?: string;
}

/** The modal that follows a clean dry run: the environment, the Worker(s), and
 *  what runs. */
export function confirmation(target: RevertTarget, plan: RevertPlan, groups: readonly WorkerGroup[]): Confirmation {
  // The target's environment, not the document's: it is what the real run is given.
  const env = target.environment;
  const names = plan.workers.map((w) => w.worker);
  const lines = workerLines(plan, groups);
  const grouped = plan.workers.some((w) => groups.some((g) => g.key === w.worker));
  const production = isProductionEnvironment(env);
  const typed = typedConfirmation([env]);
  const detail = [
    `Environment: ${env}${production ? " (reads as production)" : ""}`,
    `${names.length === 1 ? "Worker" : "Workers"}:`,
    ...lines.map((l) => `  - ${l}`),
    ...(grouped ? ["", "A Worker group is one script, so every member goes back together."] : []),
    ...(plan.workers.some((w) => w.lockChanges) ? ["", "bynk.deploy.lock will change."] : []),
    "",
    `This runs \`bynk ${revertArgs({ ...target, environment: env }, "run").join(" ")}\`. The dry run found nothing to refuse; bynk checks again before it changes anything.`,
  ].join("\n");
  return {
    title: `Revert ${names.length === 1 ? names[0] : `${names.length} Workers`} in "${env}"?`,
    detail,
    button: "Revert",
    ...(typed ? { typed } : {}),
  };
}

/** What the user is told after a refusal, one line. */
export function refusalSummary(plan: RevertPlan): string {
  const refused = plan.workers.flatMap((w) => w.checks.filter((c) => c.verdict === "refused").map((c) => `${w.worker}: ${c.check}`));
  return refused.length > 0
    ? `bynk refuses this revert (${refused.join("; ")}). Nothing was changed.`
    : "bynk could not confirm this revert is safe. Nothing was changed.";
}
