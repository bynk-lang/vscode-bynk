// The dependency-free core of "Bynk: Check Deploy Readiness" (#221): what can go
// wrong in a deploy to one environment, gathered from the sources the editor
// already reads, as one list of checks each *passed*, *warned*, *failed* (or
// *unavailable*). No `vscode` import, so the unit tests compile against it
// directly (see tsconfig.test.json); `deployReadiness.ts` wires it to the editor.
//
// Sources (all local and read-only; nothing is provisioned, deployed or written):
//   - breaking service contracts against what is live, and event or agent schema
//     changes against `bynk.schema.lock`: the language server's `bynk/contractDiff`;
//   - pending state migrations: `bynk migrate status`;
//   - secrets, orphans and a context moving Worker script: the plan, `bynk deploy
//     --dry-run --format json` (`--plan` is its alias), and its refusal;
//   - tests: the Test Explorer's last run of the project;
//   - Worker size: not available with this `bynk` (bynk-lang/bynk#3792).
//
// A secret's *value* is never read here or anywhere in the readiness path: only
// the plan's names and its `secrets_complete` flag.
//
// What a failure means: `fail` is only ever a refusal `bynk` itself would make
// (the plan cannot be had, the schema lock refuses a change, a context would
// move Worker script). The extension's own Deploy is blocked on those. A `warn`
// is a risk the user may accept with an explicit "Deploy anyway".
//
// v0.639.1 reports the "context moving Worker script" refusal
// (`bynk.deploy.agent_move_refused`, bynk#3562) only as the dry run's failure:
// exit 1, a line on stderr, and no plan at all. It is not a field of the plan, so
// it is read from that line (`parseAgentMoves`), and the checks that need the
// plan are then unavailable rather than passed.

import { groupHolding, sameContext, type WorkerGroup } from "./contextNames";
import { migrationWarnings, migrationWarningText, parseDeployLock } from "./environmentsCore";
import { type DeployPlan, type DeployTarget, type PlanOutcome } from "./deployPlan";
import { escapeHtml } from "./cliCore";
import { type ClassStatus, contextOf } from "./migrationsCore";
import type { CdModel } from "./webview/contractDiffTypes";

export type CheckStatus = "pass" | "warn" | "fail" | "unavailable";

export type CheckId =
  | "contracts"
  | "schema"
  | "migrations"
  | "secrets"
  | "orphans"
  | "workerMove"
  | "plan"
  | "tests"
  | "workerSize";

/** The view that fixes a check; the wrapper maps each onto a command. */
export type FixTarget = "contractDiff" | "migrations" | "environments" | "plan" | "tests" | "manifest" | "doctor";

export interface ReadinessCheck {
  id: CheckId;
  title: string;
  status: CheckStatus;
  /** One line: what was found. */
  summary: string;
  /** Specifics, one per line (a service, a class, a secret name). */
  details: string[];
  /** The view that fixes it; absent when there is nothing to fix. */
  fix?: { target: FixTarget; label: string };
}

/** `ready`: nothing to say; `warnings`: some check warned; `blocked`: a check
 *  failed, so the extension's own Deploy refuses. Checks that are `unavailable`
 *  neither block nor warn: they are listed as not checked. */
export type Verdict = "ready" | "warnings" | "blocked";

export interface ReadinessReport {
  environment: string;
  scope: { context?: string; worker?: string; secretsFile?: boolean };
  checks: ReadinessCheck[];
  verdict: Verdict;
}

/** The test run the check reads. `stale`: a source changed since the run. */
export type TestsInput =
  | { kind: "none" }
  | { kind: "ran"; passed: number; failed: number; skipped: number; stale: boolean };

export interface ReadinessInput {
  environment: string;
  target: DeployTarget;
  /** `bynk/contractDiff`, or why it is not available (no server yet, no analysis). */
  contracts: CdModel | { unavailable: string };
  /** The dry-run plan, its refusal, or why it was not run. */
  plan: PlanOutcome | { kind: "unavailable"; reason: string };
  /** `bynk migrate status`. */
  migrations: { kind: "status"; classes: ClassStatus[] } | { kind: "unavailable"; detail: string };
  /** `bynk.deploy.lock`'s text, to tell which classes are deployed to the environment. */
  lock: string | undefined;
  groups: readonly WorkerGroup[];
  tests: TestsInput;
}

const worst = (checks: ReadinessCheck[]): Verdict =>
  checks.some((c) => c.status === "fail") ? "blocked" : checks.some((c) => c.status === "warn") ? "warnings" : "ready";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Whether a service's context is in the deploy's scope: the whole project, one
 *  context, or one Worker (a group's key, whose members share it). */
function inScope(context: string, target: DeployTarget, groups: readonly WorkerGroup[]): boolean {
  if (target.worker) {
    const group = groups.find((g) => g.key === target.worker);
    return group ? group.contexts.some((c) => sameContext(c, context)) : sameContext(target.worker, context);
  }
  if (target.context) return sameContext(target.context, context);
  return true;
}

// ---------------------------------------------------------------------------
// The plan's refusal

/** One context the dry run refused to move. */
export interface AgentMove {
  context: string;
  agent: string;
  from: string;
  to: string;
}

/** The moves `bynk deploy` refused with `bynk.deploy.agent_move_refused` (bynk
 *  v0.639.1, #3562), from its stderr:
 *
 *    bynk: bynk.deploy.agent_move_refused: context `shop.orders` hosts agent
 *    `Counter` and would move from Worker script `acme-core` to `shop-orders`; …
 *
 *  Empty for any other text. The code is the reliable part; the rest is read
 *  leniently, so a rewording only loses the detail, never the refusal. */
export function parseAgentMoves(stderr: string): AgentMove[] {
  const moves: AgentMove[] = [];
  for (const m of stderr.matchAll(
    /bynk\.deploy\.agent_move_refused:\s*context `([^`]+)` hosts agent `([^`]+)` and would move from Worker script `([^`]+)` to `([^`]+)`/g,
  )) {
    moves.push({ context: m[1], agent: m[2], from: m[3], to: m[4] });
  }
  return moves;
}

/** Whether the text is that refusal, whatever its wording after the code. */
export function isAgentMoveRefusal(text: string): boolean {
  return text.includes("bynk.deploy.agent_move_refused");
}

/** The first line of the driver's refusal: what the check row says. */
function firstLine(detail: string): string {
  const line = detail.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^bynk:\s*/, "").trim();
}

// ---------------------------------------------------------------------------
// The checks

function contractChecks(input: ReadinessInput): ReadinessCheck[] {
  const title = "Breaking contract changes against what is live";
  const schemaTitle = "Event and agent schema changes";
  if ("unavailable" in input.contracts) {
    const summary = `not checked: ${input.contracts.unavailable}`;
    return [
      { id: "contracts", title, status: "unavailable", summary, details: [] },
      { id: "schema", title: schemaTitle, status: "unavailable", summary, details: [] },
    ];
  }
  const model = input.contracts;
  const out: ReadinessCheck[] = [];

  // Service contracts: the ledger's hashes against this source, for this environment.
  if (model.ledger !== "read") {
    out.push({
      id: "contracts",
      title,
      status: "unavailable",
      summary:
        model.ledger === "absent"
          ? "not checked: no bynk.deploy.lock records anything live yet"
          : "not checked: bynk.deploy.lock could not be read",
      details: [],
    });
  } else {
    const rows = model.services.filter(
      (s) => s.environment === input.environment && inScope(s.context, input.target, input.groups),
    );
    const breaking = rows.filter((s) => s.status === "changed" && s.compat?.verdict === "breaking");
    const unknown = rows.filter((s) => s.status === "changed" && !s.compat);
    const removed = rows.filter((s) => s.status === "removed");
    const details = [
      ...breaking.map((s) => `${s.context}.${s.service}: breaking${s.compat?.reasons[0] ? ` (${s.compat.reasons[0]})` : ""}`),
      ...removed.map((s) => `${s.context}.${s.service}: removed, callers of the live contract lose it`),
      ...unknown.map((s) => `${s.context}.${s.service}: changed, compatibility not recorded`),
    ];
    const status: CheckStatus = breaking.length + removed.length > 0 ? "warn" : unknown.length > 0 ? "warn" : "pass";
    const summary =
      breaking.length + removed.length > 0
        ? `${plural(breaking.length + removed.length, "service contract")} would break callers of what is live`
        : unknown.length > 0
          ? `${plural(unknown.length, "service contract")} changed, with no compatibility verdict`
          : rows.some((s) => s.status === "changed")
            ? "every changed service contract is compatible with what is live"
            : "service contracts match what is live";
    out.push({
      id: "contracts",
      title,
      status,
      summary,
      details,
      ...(status === "pass" ? {} : { fix: { target: "contractDiff", label: "Show Contract Diff" } }),
    });
  }

  // Event and agent schemas: `bynk.schema.lock`. A breaking one is refused by
  // `bynk check`, hence by the build `bynk deploy` starts with.
  if (model.lock !== "read") {
    out.push({
      id: "schema",
      title: schemaTitle,
      status: "unavailable",
      summary:
        model.lock === "absent" ? "not checked: no bynk.schema.lock yet" : "not checked: bynk.schema.lock could not be read",
      details: [],
    });
  } else {
    const breaking = model.changes.filter((c) => c.class === "breaking");
    const compatible = model.changes.filter((c) => c.class === "compatible");
    out.push({
      id: "schema",
      title: schemaTitle,
      status: breaking.length > 0 ? "fail" : "pass",
      summary:
        breaking.length > 0
          ? `${plural(breaking.length, "breaking change")} against bynk.schema.lock: bynk refuses to build it`
          : compatible.length > 0
            ? `${plural(compatible.length, "compatible change")} against bynk.schema.lock`
            : "no change against bynk.schema.lock",
      details: breaking.map((c) => `${c.unit}.${c.name} (${c.kind}): ${c.detail}`),
      ...(breaking.length > 0 ? { fix: { target: "contractDiff", label: "Show Contract Diff" } } : {}),
    });
  }
  return out;
}

function migrationsCheck(input: ReadinessInput): ReadinessCheck {
  const title = "Pending state migrations";
  if (input.migrations.kind === "unavailable") {
    return { id: "migrations", title, status: "unavailable", summary: `not checked: ${input.migrations.detail}`, details: [] };
  }
  // `bynk migrate status` names where a class is deployed by its context's own
  // Worker, so a class in a group member is put where the ledger says: as the
  // Environments view does (bynk-lang/bynk#3686).
  let classes = input.migrations.classes;
  if (input.groups.length > 0 && input.lock !== undefined) {
    try {
      const env = parseDeployLock(input.lock).find((e) => e.name === input.environment);
      if (env) {
        classes = classes.map((c) => {
          const group = groupHolding(contextOf(c.class), input.groups);
          const live = group && env.workers.some((w) => w.worker === group.key && w.deployed);
          return live && !c.deployedTo.includes(env.name) ? { ...c, deployedTo: [...c.deployedTo, env.name] } : c;
        });
      }
    } catch {
      /* an unreadable ledger: the classes stay as the driver reported them */
    }
  }
  const scoped = classes.filter((c) => inScope(contextOf(c.class), input.target, input.groups));
  const warned = migrationWarnings(scoped, input.environment);
  if (warned.length === 0) {
    return { id: "migrations", title, status: "pass", summary: "no deployed agent class has records to migrate", details: [] };
  }
  const noPath = warned.filter((c) => c.withoutPath.length > 0).length;
  return {
    id: "migrations",
    title,
    status: "warn",
    summary:
      `${plural(warned.length, "agent class", "agent classes")} deployed here may hold older records` +
      (noPath > 0 ? `, ${noPath} with a stored version that has no migrate path` : ""),
    details: warned.map((c) => `${c.class}: ${migrationWarningText(c)}`),
    fix: { target: "migrations", label: "Open State Migrations" },
  };
}

/** The checks that read the plan: secrets, orphans, a context moving Worker
 *  script, and the plan itself. */
function planChecks(input: ReadinessInput): ReadinessCheck[] {
  const secretsTitle = "Secrets for the environment";
  const orphansTitle = "What the deploy would delete or orphan";
  const moveTitle = "A context moving Worker script";
  const planTitle = "The deploy plan";
  const plan = input.plan;

  if (plan.kind === "unavailable" || plan.kind === "cancelled") {
    const reason = plan.kind === "unavailable" ? plan.reason : "the dry run was cancelled";
    const why = `not checked: ${reason}`;
    return [
      { id: "plan", title: planTitle, status: "unavailable", summary: why, details: [] },
      { id: "secrets", title: secretsTitle, status: "unavailable", summary: why, details: [] },
      { id: "orphans", title: orphansTitle, status: "unavailable", summary: why, details: [] },
      { id: "workerMove", title: moveTitle, status: "unavailable", summary: why, details: [] },
    ];
  }

  if (plan.kind === "failed") {
    // The driver refused before planning. The Worker-script move is the one
    // refusal with its own row; any other is the plan row.
    const moves = parseAgentMoves(plan.detail);
    const moved = isAgentMoveRefusal(plan.detail);
    const why = "not checked: bynk could not plan this deploy";
    const rows: ReadinessCheck[] = [
      moved
        ? {
            id: "plan",
            title: planTitle,
            status: "fail",
            summary: "bynk refuses to plan this deploy (see the Worker script row)",
            details: [],
            fix: { target: "plan", label: "Show Deploy Plan" },
          }
        : {
            id: "plan",
            title: planTitle,
            status: "fail",
            summary: `bynk refuses to plan this deploy: ${firstLine(plan.detail) || "no reason given"}`,
            details: plan.detail.split("\n").map((l) => l.trim()).filter((l) => l !== "").slice(1, 6),
            fix: { target: "plan", label: "Show Deploy Plan" },
          },
      { id: "secrets", title: secretsTitle, status: "unavailable", summary: why, details: [] },
      { id: "orphans", title: orphansTitle, status: "unavailable", summary: why, details: [] },
    ];
    rows.push(
      moved
        ? {
            id: "workerMove",
            title: moveTitle,
            status: "fail",
            summary:
              moves.length > 0
                ? `${plural(moves.length, "context")} would move Worker script, so its agent state would start empty: bynk refuses`
                : "a context hosting agents would move Worker script, so its agent state would start empty: bynk refuses",
            details: [
              ...moves.map((m) => `${m.context} (agent ${m.agent}): ${m.from} → ${m.to}`),
              "Keep the context on its Worker script, or start it fresh deliberately: `bynk deploy --accept-fresh-agent <context>` in a terminal (the old state stays in the old script).",
            ],
            fix: { target: "manifest", label: "Open bynk.toml (Worker groups)" },
          }
        : { id: "workerMove", title: moveTitle, status: "unavailable", summary: why, details: [] },
    );
    return rows;
  }

  // A plan: the checks read it.
  const p: DeployPlan = plan.plan;
  const out: ReadinessCheck[] = [
    {
      id: "plan",
      title: planTitle,
      status: "pass",
      summary: `${plural(p.contexts.length, "Worker")} to ${p.contexts.some((c) => c.action === "deploy") ? "deploy or redeploy" : "redeploy"}`,
      details: [],
    },
  ];

  // Secrets: names and completeness only. The plan cannot say which are already
  // set in Cloudflare (that needs the account), so a required secret is a
  // reminder, not a verdict: the driver prompts for, or reads from a secrets
  // file, whatever is not yet set.
  const required = p.contexts.flatMap((c) => c.secrets.filter((s) => s.origin === "declared").map((s) => `${c.worker}: ${s.name}`));
  const incomplete = p.contexts.filter((c) => !c.secretsComplete).map((c) => c.worker);
  const supplied = input.target.secretsFile !== undefined;
  const secretDetails = [
    ...required.map((r) => `${r} (required)`),
    ...incomplete.map((w) => `${w}: also reads secrets the compiler cannot name`),
  ];
  const needsValues = (required.length > 0 || incomplete.length > 0) && !supplied;
  out.push({
    id: "secrets",
    title: secretsTitle,
    status: needsValues ? "warn" : "pass",
    summary: needsValues
      ? `${plural(required.length, "required secret")}${incomplete.length > 0 ? ` and ${plural(incomplete.length, "Worker")} reading unnamed secrets` : ""} need values: give a secrets file, or bynk prompts`
      : supplied && secretDetails.length > 0
        ? "values come from the chosen secrets file (its contents are not read here)"
        : "no secret needs a value from you",
    details: secretDetails,
    ...(needsValues ? { fix: { target: "plan", label: "Choose a secrets file in the plan" } } : {}),
  });

  // Orphans: left in place by this deploy (the extension never prunes).
  const o = p.orphans;
  const orphanDetails = [
    ...o.workers.map((w) => `Worker ${w}`),
    ...o.kv.map((k) => `KV namespace ${k.binding ?? "KV"} of ${k.worker}`),
    ...o.queues.map((q) => `queue ${q}`),
  ];
  out.push({
    id: "orphans",
    title: orphansTitle,
    status: orphanDetails.length > 0 ? "warn" : "pass",
    summary:
      orphanDetails.length > 0
        ? `${plural(orphanDetails.length, "resource")} in bynk.deploy.lock no longer declared; this deploy leaves them in place (it never prunes)`
        : "nothing is left behind, and the deploy deletes nothing",
    details: orphanDetails,
    ...(orphanDetails.length > 0 ? { fix: { target: "environments", label: "Open Environments" } } : {}),
  });

  // The plan came back, so `bynk` did not refuse a Worker-script move.
  out.push({
    id: "workerMove",
    title: moveTitle,
    status: "pass",
    summary: "no context hosting agents moves Worker script",
    details: [],
  });
  return out;
}

function testsCheck(t: TestsInput): ReadinessCheck {
  const title = "Tests";
  if (t.kind === "none") {
    return {
      id: "tests",
      title,
      status: "warn",
      summary: "no test run of this project in this session",
      details: [],
      fix: { target: "tests", label: "Run Tests" },
    };
  }
  const counts = `${t.passed} passed${t.failed > 0 ? `, ${t.failed} failed` : ""}${t.skipped > 0 ? `, ${t.skipped} skipped` : ""}`;
  if (t.failed > 0) {
    return { id: "tests", title, status: "warn", summary: `the last run had failures: ${counts}`, details: [], fix: { target: "tests", label: "Run Tests" } };
  }
  if (t.stale) {
    return {
      id: "tests",
      title,
      status: "warn",
      summary: `the last run passed (${counts}) but a source has changed since`,
      details: [],
      fix: { target: "tests", label: "Run Tests" },
    };
  }
  return { id: "tests", title, status: "pass", summary: `the last run passed: ${counts}`, details: [] };
}

/** Worker size against the platform limit needs what bynk-lang/bynk#3792 adds
 *  (the build reporting each Worker's size). Until `bynk` has it, the row says
 *  so: it is never shown as passed. */
function workerSizeCheck(): ReadinessCheck {
  return {
    id: "workerSize",
    title: "Worker size against the limit",
    status: "unavailable",
    summary: "not available with this bynk (needs bynk-lang/bynk#3792)",
    details: [],
  };
}

/** Evaluate every check for one environment. Pure: the same input, the same report. */
export function evaluateReadiness(input: ReadinessInput): ReadinessReport {
  const [contracts, schema] = contractChecks(input);
  const [plan, secrets, orphans, workerMove] = planChecks(input);
  const checks = [contracts, schema, migrationsCheck(input), secrets, orphans, workerMove, plan, testsCheck(input.tests), workerSizeCheck()];
  return {
    environment: input.environment,
    scope: {
      ...(input.target.context ? { context: input.target.context } : {}),
      ...(input.target.worker ? { worker: input.target.worker } : {}),
      ...(input.target.secretsFile !== undefined ? { secretsFile: true } : {}),
    },
    checks,
    verdict: worst(checks),
  };
}

// ---------------------------------------------------------------------------
// Gating Deploy

/** What the extension's own Deploy does with a report. */
export type Gate =
  | { kind: "allow" }
  /** Warnings: an explicit "Deploy anyway", naming what was warned. */
  | { kind: "confirm"; warnings: string[] }
  /** A refusal `bynk` would make: no way past it from the editor. */
  | { kind: "block"; failures: string[] };

export function gateFor(report: ReadinessReport): Gate {
  const failures = report.checks.filter((c) => c.status === "fail");
  if (failures.length > 0) return { kind: "block", failures: failures.map((c) => `${c.title}: ${c.summary}`) };
  const warnings = report.checks.filter((c) => c.status === "warn");
  if (warnings.length > 0) return { kind: "confirm", warnings: warnings.map((c) => `${c.title}: ${c.summary}`) };
  return { kind: "allow" };
}

/** The verdict as one line for a notification or the panel's heading. */
export function verdictLine(report: ReadinessReport): string {
  const n = (s: CheckStatus) => report.checks.filter((c) => c.status === s).length;
  switch (report.verdict) {
    case "ready":
      return `Ready to deploy to ${report.environment}`;
    case "warnings":
      return `Deploy to ${report.environment}: ${plural(n("warn"), "warning")}`;
    case "blocked":
      return `Deploy to ${report.environment} is blocked: ${plural(n("fail"), "check")} failed`;
  }
}

// ---------------------------------------------------------------------------
// The cache

/** Results per environment and source state. A key names what the check was
 *  asked (environment, scope, secrets file); the state is a generation the
 *  caller bumps whenever a source (a `.bynk` file, a lock, the manifest) saves.
 *  An entry from an older generation is never returned. */
export class ReadinessCache<T> {
  private generation = 0;
  private readonly entries = new Map<string, { generation: number; value: T }>();

  /** Mark the sources changed: every entry so far is stale. */
  invalidate(): void {
    this.generation++;
  }

  get state(): number {
    return this.generation;
  }

  get(key: string): T | undefined {
    const e = this.entries.get(key);
    return e && e.generation === this.generation ? e.value : undefined;
  }

  /** Store `value` computed at `generation` (read before the work started), so
   *  an answer that a save overtook is not served as current. */
  set(key: string, value: T, generation: number = this.generation): void {
    if (generation === this.generation) this.entries.set(key, { generation, value });
  }

  /** The keys with a current entry. */
  keys(): string[] {
    return [...this.entries.entries()].filter(([, e]) => e.generation === this.generation).map(([k]) => k);
  }
}

/** The cache key for a check: environment and scope. The secrets file is part of
 *  it by path only (never read). */
export function cacheKey(target: DeployTarget): string {
  return JSON.stringify([target.environment, target.worker ?? "", target.context ?? "", target.secretsFile ?? ""]);
}

// ---------------------------------------------------------------------------
// The panel's markup

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: "Passed",
  warn: "Warning",
  fail: "Failed",
  unavailable: "Not checked",
};
const STATUS_ICON: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", unavailable: "–" };

export interface ReadinessViewOptions {
  /** What the primary button continues to, or `undefined` for none (blocked). */
  continueLabel?: string;
}

/** The panel's body. Buttons carry `data-action` (`recheck`, `continue`) and fix
 *  links `data-action="fix"` with `data-target` (a `FixTarget`), which the host's script posts back. Every
 *  string that came from the CLI or the project is escaped. */
export function renderReadinessHtml(report: ReadinessReport, opts: ReadinessViewOptions = {}): string {
  const e = escapeHtml;
  const out: string[] = [];
  out.push(
    `<header class="env"><h1>${e(verdictLine(report))}</h1><p class="scope">` +
      (report.scope.worker
        ? `Worker <code>${e(report.scope.worker)}</code> only`
        : report.scope.context
          ? `Context <code>${e(report.scope.context)}</code> only`
          : "Whole project") +
      `, environment <span class="env-name">${e(report.environment)}</span></p></header>`,
  );
  out.push(`<ul class="checks">`);
  for (const c of report.checks) {
    out.push(
      `<li class="check ${c.status}" data-check="${e(c.id)}"><span class="mark" aria-hidden="true">${STATUS_ICON[c.status]}</span>` +
        `<div class="body"><div class="head"><strong>${e(c.title)}</strong> <span class="status">${STATUS_LABEL[c.status]}</span></div>` +
        `<div class="summary">${e(c.summary)}</div>` +
        (c.details.length > 0 ? `<ul class="details">${c.details.map((d) => `<li>${e(d)}</li>`).join("")}</ul>` : "") +
        (c.fix ? `<div><button class="link" data-action="fix" data-target="${e(c.fix.target)}">${e(c.fix.label)}</button></div>` : "") +
        `</div></li>`,
    );
  }
  out.push(`</ul>`);
  const buttons: string[] = [];
  if (opts.continueLabel) buttons.push(`<button class="primary" data-action="continue">${e(opts.continueLabel)}</button>`);
  buttons.push(`<button data-action="recheck">Check again</button>`);
  out.push(`<footer class="actions">${buttons.join("")}</footer>`);
  out.push(
    `<p class="note">Read-only: nothing is provisioned, deployed or written to check. Secret values are never read, only names. ` +
      `A failed check is something <code>bynk</code> itself would refuse; a warning is yours to accept.</p>`,
  );
  return out.join("\n");
}

export const READINESS_CSS = `
  .env { border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
  .env-name { color: var(--vscode-editorWarning-foreground); }
  ul.checks { list-style: none; padding-left: 0; }
  li.check { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  li.check .mark { font-weight: bold; width: 1.2em; text-align: center; flex: none; }
  li.check.pass .mark { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  li.check.warn .mark { color: var(--vscode-editorWarning-foreground); }
  li.check.fail .mark { color: var(--vscode-errorForeground); }
  li.check.unavailable { opacity: 0.7; }
  .status { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; margin-left: 6px; }
  ul.details { margin: 4px 0; padding-left: 18px; font-size: 0.92em; }
  footer.actions { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; padding: 4px 12px; cursor: pointer; }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; text-decoration: underline; }
  .note { opacity: 0.8; }
`;
