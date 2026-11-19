// #149: request scenarios, the editor side. `scenarioCore.ts` parses and runs
// `.bynk-http` files; this wires them to VS Code: diagnostics against the wire
// contract, CodeLenses to run a step or the scenario with the results inline,
// and "Save to scenario…" from the Send Request panel.
//
// Routes are resolved through the language server, not by reading handler
// headers: the handlers come from the server's document symbols, and each
// HTTP handler's route, context and body shape from `bynk/wireContract`, the
// answer Send Request already uses. The only text this module reads itself is
// each handler's header line, to tell an HTTP handler from the rest (as the
// Send request lens does) and to skip the handlers of an agent, which have no
// wire contract: every other handler of a service is asked about (#213).

import * as path from "node:path";

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { devServerState } from "./devServer";
import { checkSuiteInCopy } from "./promoteCheck";
import { describeDiagnostic } from "./richDiagnostics";
import { handlerSymbols } from "./refreshScheduler";
import { pickTarget } from "./testTargetPicker";
import { DEV_TARGET } from "./testTargets";
import {
  confirmationFor,
  literalCredential,
  literalCredentialMessage,
  parseTargets,
  refusedReason,
  targetBase,
  writeSteps,
  type TestTarget,
} from "./scenarioTargetsCore";
import { projectRootFor } from "./projectRoots";
import { stepRoute } from "./edgeCasesCore";
import { RouteCache } from "./routeCache";
import {
  appendStep,
  isSensitiveHeader,
  parseScenario,
  resolveRoute,
  runSteps,
  stepsNeededFor,
  validateStep,
  type EarlierStep,
  type HandlerInfo,
  type Problem,
  type Resolved,
  type RouteInfo,
  type RunHost,
  type SaveSpec,
  type Scenario,
  type Sent,
  type Step,
  type StepResult,
} from "./scenarioCore";
import { promote as promoteScenario, summarise, type PromoteRoute } from "./scenarioPromoteCore";
import { devTarget } from "./sendRequestCore";
import type { WorkerGroup } from "./contextNames";
import { workerGroupsFor } from "./workerGroupsStore";
import { fetchFailure, isHttpHandler, isTextual, readBody, targetProblem, TIMEOUT_MS } from "./sendRequest";
import type { ViewRefresh } from "./viewRefresh";
import { requestWireContract } from "./wireContract";

export const SCENARIO_LANGUAGE = "bynk-http";
const GLOB = "**/*.bynk-http";
const EXCLUDE = "**/{node_modules,.bynk,.git}/**";

/** Every HTTP route a project's handlers serve, as the language server
 *  describes them; `complete` is false when the server could not answer (not
 *  started, a request failed), so "no such route" would be a guess. */
export interface RouteSet {
  routes: RouteInfo[];
  /** The handlers that are not HTTP routes (#213): on call, cron, queue, event, websocket. */
  handlers: HandlerInfo[];
  complete: boolean;
}

class RouteIndex implements vscode.Disposable {
  /** Never keeps an incomplete set; see `routeCache.ts`. */
  private readonly cache = new RouteCache<RouteSet>();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when a `.bynk` file changes, so the contract the scenarios are
   *  checked against may have. */
  readonly onDidChange = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly hub: ViewRefresh) {
    const bump = (): void => {
      this.cache.invalidate();
      this.emitter.fire();
    };
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.bynk");
    this.subs.push(
      watcher,
      watcher.onDidCreate(bump),
      watcher.onDidDelete(bump),
      watcher.onDidChange(bump),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === "bynk" && e.contentChanges.length > 0) bump();
      }),
      // A set built before the server had analysed the project was "can't say
      // yet"; once a round commits, it may say, so the scenarios look again.
      hub.onDidCommitRound(() => {
        if (this.cache.roundCommitted()) this.emitter.fire();
      }),
    );
  }

  routes(root: vscode.Uri): Promise<RouteSet> {
    return this.cache.get(root.toString(), () => this.build(root));
  }

  private async build(root: vscode.Uri): Promise<RouteSet> {
    const client = await this.hub.whenClient(5_000);
    if (!client) return { routes: [], handlers: [], complete: false };
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), EXCLUDE);
    let complete = true;
    const routes: RouteInfo[] = [];
    const handlers: HandlerInfo[] = [];
    for (const file of files) {
      try {
        const got = await this.fileRoutes(client, file);
        routes.push(...got.routes);
        handlers.push(...got.handlers);
        if (!got.complete) complete = false;
      } catch {
        complete = false;
      }
    }
    return { routes, handlers, complete };
  }

  /** A file's routes, and whether the server could answer for all of it. */
  private async fileRoutes(client: LanguageClient, file: vscode.Uri): Promise<{ routes: RouteInfo[]; handlers: HandlerInfo[]; complete: boolean }> {
    const doc = await vscode.workspace.openTextDocument(file);
    const symbols = await this.hub.documentSymbols(doc);
    // A Bynk file always declares something: no symbols means the server
    // could not answer yet, not that the file serves nothing.
    if (symbols.length === 0 && doc.getText().trim() !== "") return { routes: [], handlers: [], complete: false };
    const text = doc.getText();
    const out: RouteInfo[] = [];
    const others: HandlerInfo[] = [];
    let complete = true;
    const identities: Record<string, string> = {};
    for (const a of text.matchAll(/\bactor\s+([A-Z]\w*)\s*\{[^}]*?\bidentity\s*=\s*([A-Z]\w*)/g)) identities[a[1]] = a[2];
    for (const h of handlerSymbols(symbols)) {
      const http = isHttpHandler(doc, h.symbol.range);
      // An agent's `on call` never has a wire contract, and no cell can call it: not worth the round trip.
      const inService = new RegExp(`\\bservice\\s+${h.owner}\\b`).test(text);
      if (!http && !inService) continue;
      const position = h.symbol.selectionRange.start;
      const wc = await requestWireContract(client, { uri: doc.uri.toString(), position: { line: position.line, character: position.character } });
      const kind = wc?.model.kind;
      if (!wc) {
        // A handler with no wire contract yet: the server has not analysed the
        // project. Say so rather than drop it (a set built too early is kept
        // as complete until a file changes, #213). An agent's `on call` has
        // none, ever, but those were skipped above.
        complete = false;
        continue;
      }
      const r = h.symbol.range;
      const header = doc.getText(new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character)).split("{", 1)[0];
      // `by u: User`, `by Visitor`: the actors the handler admits.
      const actors = [...header.matchAll(/\bby\s+(?:[a-z_]\w*\s*:\s*)?([A-Z]\w*)/g)].map((m) => m[1]);
      if (kind?.kind === "Http") {
        out.push({ unit: wc.model.unit, method: kind.method, path: kind.path, model: wc.model, service: wc.model.service, responses: wc.model.responses, actors, identities });
        continue;
      }
      if (!kind || !wc.model.service) continue;
      // A `from websocket` service's `message` is a `Message` to the server, but is driven by `svc.message(tc, frame)`.
      const websocket = kind.kind === "Open" || kind.kind === "Close" || new RegExp(`\\bservice\\s+${h.owner}\\s+from\\s+websocket\\b`).test(text);
      const kinds = { Call: "call", Cron: "cron", Message: "queue", Event: "event" } as const;
      const mapped = websocket ? "websocket" : kind.kind in kinds ? kinds[kind.kind as keyof typeof kinds] : undefined;
      if (!mapped) continue;
      others.push({ unit: wc.model.unit, service: wc.model.service, kind: mapped, expr: kind.kind === "Cron" ? kind.expr : undefined, model: wc.model, actors, identities });
    }
    return { routes: out, handlers: others, complete };
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
  }
}

/** What the last run of a document showed. */
interface RunView {
  version: number;
  /** The `[test.targets]` name the run went to; undefined for the dev server. */
  target?: string;
  results: Map<string, StepResult>;
}

/** The manifest's target named `name`, or why there is none. */
async function manifestTargetTables(root: vscode.Uri): Promise<TestTarget[] | undefined> {
  try {
    return parseTargets(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "bynk.toml"))));
  } catch {
    return undefined;
  }
}

/** The manifest's target named `name`, or why there is none (or why it is refused). */
async function readTarget(root: vscode.Uri, name: string): Promise<TestTarget | { error: string }> {
  const tables = await manifestTargetTables(root);
  if (!tables) return { error: "no bynk.toml was found in the scenario's project." };
  const found = tables.find((t) => t.name === name);
  if (!found) return { error: `\`${name}\` isn't a [test.targets.${name}] table in bynk.toml, so there is no URL to send to.` };
  return refusedReason(found) ? { error: refusedReason(found)! } : found;
}

/** The routes of a project, once `registerScenario` has run (a notebook's
 *  handler cell picks its call from them, #191). */
let routeProvider: ((root: vscode.Uri) => Promise<RouteSet>) | undefined;
export function projectRoutes(root: vscode.Uri): Promise<RouteSet> {
  return routeProvider ? routeProvider(root) : Promise.resolve({ routes: [], handlers: [], complete: false });
}

export function registerScenario(context: vscode.ExtensionContext, hub: ViewRefresh): void {
  const index = new RouteIndex(hub);
  routeProvider = (root) => index.routes(root);
  context.subscriptions.push({ dispose: () => { routeProvider = undefined; } });
  const diagnostics = vscode.languages.createDiagnosticCollection("bynk-http");
  const runDiagnostics = vscode.languages.createDiagnosticCollection("bynk-http-run");
  const output = vscode.window.createOutputChannel("Bynk Scenario");
  const lensChanged = new vscode.EventEmitter<void>();
  const runs = new Map<string, RunView>();
  const running = new Set<string>();
  const passed = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 1.5em", color: new vscode.ThemeColor("testing.iconPassed") },
  });
  const failedDeco = vscode.window.createTextEditorDecorationType({
    after: { margin: "0 0 0 1.5em", color: new vscode.ThemeColor("testing.iconFailed") },
  });

  /** The project a scenario belongs to: where its `bynk.toml` is. */
  const rootOf = (doc: vscode.TextDocument): Promise<vscode.Uri | undefined> => projectRootFor(doc.uri);

  /** The route for each step, or why it has none; `undefined` where the server
   *  could not say, so the contract is not checked rather than wrongly failed. */
  async function resolveAll(doc: vscode.TextDocument, scenario: Scenario): Promise<(Resolved | undefined)[]> {
    const root = await rootOf(doc);
    if (!root) return scenario.steps.map(() => undefined);
    const set = await index.routes(root);
    if (!set.complete) return scenario.steps.map(() => undefined);
    return scenario.steps.map((s) => (s.requestLine < 0 ? undefined : resolveRoute(set.routes, s)));
  }

  function toDiagnostic(doc: vscode.TextDocument, p: Problem): vscode.Diagnostic {
    const line = Math.min(p.line, doc.lineCount - 1);
    const text = doc.lineAt(line).text;
    const start = text.length - text.trimStart().length;
    const range = new vscode.Range(line, Math.min(p.start || start, text.length), line, Math.min(p.end, text.length));
    const d = new vscode.Diagnostic(range, p.message, p.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    d.source = "bynk scenario";
    return d;
  }

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  async function validate(doc: vscode.TextDocument): Promise<void> {
    if (doc.languageId !== SCENARIO_LANGUAGE) return;
    const version = doc.version;
    const scenario = parseScenario(doc.getText());
    const problems = [...scenario.problems];
    const resolved = await resolveAll(doc, scenario);
    if (doc.isClosed || doc.version !== version) return;
    const names = new Set(scenario.steps.map((s) => s.name));
    const before = new Set<string>();
    const earlier = new Map<string, EarlierStep>();
    scenario.steps.forEach((step, i) => {
      if (step.requestLine >= 0) problems.push(...validateStep(step, resolved[i], before, names, earlier));
      before.add(step.name);
      const r = resolved[i];
      earlier.set(step.name, { step, route: r && "route" in r ? r.route : undefined });
    });
    diagnostics.set(doc.uri, problems.map((p) => toDiagnostic(doc, p)));
  }
  const schedule = (doc: vscode.TextDocument, delay = 300): void => {
    if (doc.languageId !== SCENARIO_LANGUAGE) return;
    const key = doc.uri.toString();
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        void validate(doc);
      }, delay),
    );
  };
  const revalidateOpen = (): void => {
    for (const doc of vscode.workspace.textDocuments) schedule(doc, 1000);
  };

  // --- Running -------------------------------------------------------------

  function decorate(editor: vscode.TextEditor): void {
    const view = runs.get(editor.document.uri.toString());
    const ok: vscode.DecorationOptions[] = [];
    const bad: vscode.DecorationOptions[] = [];
    if (view && view.version === editor.document.version) {
      for (const result of view.results.values()) {
        for (const c of result.checks) {
          if (c.line >= editor.document.lineCount) continue;
          const range = editor.document.lineAt(c.line).range;
          (c.ok ? ok : bad).push({ range, renderOptions: { after: { contentText: c.ok ? "✔" : `✖ ${c.message.replace(/^.*?, but /, "")}` } } });
        }
      }
    }
    editor.setDecorations(passed, ok);
    editor.setDecorations(failedDeco, bad);
  }
  const decorateAll = (): void => vscode.window.visibleTextEditors.forEach(decorate);

  function show(doc: vscode.TextDocument, scenario: Scenario, results: StepResult[], target?: string): void {
    const key = doc.uri.toString();
    runs.set(key, { version: doc.version, target, results: new Map(results.map((r) => [r.step, r])) });
    const byName = new Map(scenario.steps.map((s) => [s.name, s]));
    const ds: vscode.Diagnostic[] = [];
    for (const r of results) {
      const step = byName.get(r.step);
      if (!step) continue;
      const add = (line: number, message: string, severity: vscode.DiagnosticSeverity): void => {
        const range = doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
        const d = new vscode.Diagnostic(range, message, severity);
        d.source = "bynk scenario run";
        ds.push(d);
      };
      if (r.state === "failed") {
        for (const c of r.checks) if (!c.ok) add(c.line, `Expected ${c.message}`, vscode.DiagnosticSeverity.Error);
      } else if (r.state === "error") {
        add(step.requestLine, r.message ?? "The request failed.", vscode.DiagnosticSeverity.Error);
      } else if (r.state === "skipped") {
        add(step.requestLine, r.message ?? "Skipped.", vscode.DiagnosticSeverity.Warning);
      }
    }
    runDiagnostics.set(doc.uri, ds);
    lensChanged.fire();
    decorateAll();
  }

  function report(results: StepResult[], target?: string): void {
    output.appendLine(`── ${new Date().toLocaleTimeString("en-GB")}${target ? ` · target ${target}` : ""} ──`);
    for (const r of results) {
      const mark = r.state === "passed" ? "✔" : r.state === "skipped" ? "–" : "✖";
      output.appendLine(`${mark} ${r.step}${r.request ? `  ${r.request}` : ""}${r.status !== undefined ? `  → ${r.status}` : ""}${r.ms !== undefined ? ` (${r.ms} ms)` : ""}`);
      if (r.message) for (const l of r.message.split("\n")) output.appendLine(`    ${l}`);
      if (r.state !== "passed" && r.body) output.appendLine(`    ${r.body.split("\n").join("\n    ")}`);
    }
    const count = (s: StepResult["state"]): number => results.filter((r) => r.state === s).length;
    output.appendLine(`${count("passed")} passed, ${count("failed") + count("error")} failed, ${count("skipped")} skipped.`);
  }

  const uriOf = (uriArg: unknown): vscode.Uri | undefined =>
    uriArg instanceof vscode.Uri ? uriArg : typeof uriArg === "string" ? vscode.Uri.parse(uriArg) : vscode.window.activeTextEditor?.document.uri;

  /** Ask before a run against a deployed target: a confirmation, or the
   *  target's name typed when it reads as production and the run writes. */
  async function confirmRun(target: TestTarget, steps: Step[], only: ReadonlySet<string> | undefined, resolvedBy: Map<string, Resolved | undefined>, groups: readonly WorkerGroup[]): Promise<boolean> {
    const toRun = steps.filter((s) => !only || only.has(s.name));
    const hosts = new Set<string>();
    for (const s of toRun) {
      const r = resolvedBy.get(s.name);
      if (r && !("error" in r)) {
        const base = targetBase(target, r.route.unit, groups);
        if ("base" in base) hosts.add(base.base);
      }
    }
    const ask = confirmationFor(target, toRun, writeSteps(steps, only), [...hosts]);
    if (!ask) return true;
    if (ask.kind === "typed") {
      const typed = await vscode.window.showInputBox({
        title: `Run against ${target.name}`,
        prompt: ask.message,
        ignoreFocusOut: true,
        validateInput: (v) => (v === ask.phrase ? undefined : `Type ${ask.phrase} to continue.`),
      });
      return typed === ask.phrase;
    }
    return (await vscode.window.showWarningMessage(ask.message, { modal: true }, ask.action ?? "Run")) === (ask.action ?? "Run");
  }

  async function run(uriArg?: unknown, stepArg?: unknown, against?: TestTarget): Promise<StepResult[] | undefined> {
    const uri = uriOf(uriArg);
    if (!uri) {
      void vscode.window.showErrorMessage("Bynk: Run Scenario needs a .bynk-http file open.");
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const key = doc.uri.toString();
    if (running.has(key)) {
      void vscode.window.showInformationMessage("Bynk: this scenario is already running.");
      return undefined;
    }
    const scenario = parseScenario(doc.getText());
    const syntax = scenario.problems.filter((p) => p.severity === "error");
    if (syntax.length > 0) {
      void vscode.window.showErrorMessage(`Bynk: fix the scenario first (line ${syntax[0].line + 1}: ${syntax[0].message})`);
      return undefined;
    }
    const only = typeof stepArg === "string" ? stepsNeededFor(scenario.steps, stepArg) : undefined;
    const resolved = await resolveAll(doc, scenario);
    const resolvedBy = new Map(scenario.steps.map((s, i) => [s.name, resolved[i]]));
    // Which Worker serves a context is the project's `[deploy.workers.<key>]`
    // groups', so both the dev server and a target's URL are looked up by it.
    const groups = await workerGroupsFor(uri);
    if (against && !(await confirmRun(against, scenario.steps, only, resolvedBy, groups))) return undefined;
    const abort = new AbortController();
    running.add(key);
    lensChanged.fire();
    try {
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${only ? `Running ${stepArg}` : "Running scenario"}${against ? ` against ${against.name}` : ""}…`, cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => abort.abort());
          const host = makeHost(resolvedBy, abort, groups, against);
          return runSteps(scenario.steps, host, only);
        },
      );
      show(doc, scenario, results, against?.name);
      report(results, against?.name);
      output.show(true);
      const failed = results.filter((r) => r.state === "failed" || r.state === "error").length;
      const skipped = results.filter((r) => r.state === "skipped").length;
      const summary = `${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`;
      if (!against && results.some((r) => r.state === "error" && /dev server isn't running/.test(r.message ?? ""))) {
        void vscode.window.showWarningMessage("Bynk: the dev server isn't running.", "Start Dev Server").then((pick) => {
          if (pick) void vscode.commands.executeCommand("bynk.startDevServer");
        });
      } else if (failed > 0) void vscode.window.showWarningMessage(`Bynk scenario: ${summary}.`);
      else void vscode.window.setStatusBarMessage(`Bynk scenario: ${summary}${against ? ` on ${against.name}` : ""}.`, 5000);
      return results;
    } finally {
      running.delete(key);
      lensChanged.fire();
    }
  }

  /** **Run Scenario Against…**: pick a `[test.targets]` target (or `dev`, the
   *  local server) with the picker Run System Tests Against… uses, and run on it. */
  async function runAgainst(uriArg?: unknown, stepArg?: unknown): Promise<StepResult[] | undefined> {
    const uri = uriOf(uriArg);
    if (!uri) {
      void vscode.window.showErrorMessage("Bynk: Run Scenario Against… needs a .bynk-http file open.");
      return undefined;
    }
    const root = await projectRootFor(uri);
    if (!root) {
      void vscode.window.showErrorMessage("Bynk: this scenario isn't inside a project (no bynk.toml found).");
      return undefined;
    }
    // A target marked `production = true` is not offered: the driver refuses it too.
    const refuse = new Map<string, string>();
    for (const t of (await manifestTargetTables(root)) ?? []) {
      const why = refusedReason(t);
      if (why) refuse.set(t.name, why);
    }
    const picked = await pickTarget(context, [root], "the scenario", refuse);
    if (!picked) return undefined;
    if (picked.target === DEV_TARGET) return run(uri, stepArg);
    const target = await readTarget(root, picked.target);
    if ("error" in target) {
      void vscode.window.showErrorMessage(`Bynk: ${target.error}`);
      return undefined;
    }
    return run(uri, stepArg, target);
  }

  function makeHost(resolvedBy: Map<string, Resolved | undefined>, abort: AbortController, groups: readonly WorkerGroup[], against?: TestTarget): RunHost {
    return {
      env: process.env,
      redactEnv: against?.secrets,
      cancelled: () => abort.signal.aborted,
      prepare(step: Step) {
        const r = resolvedBy.get(step.name);
        if (!r) return { error: "The language server couldn't say which handler serves this route. Wait for it to start and run again." };
        if ("error" in r) return { error: r.error };
        const env = r.route.model.envelope;
        const contentType = env.kind === "Raw" ? (env.contentType === "*/*" ? "application/octet-stream" : env.contentType) : "application/json";
        if (against) {
          const header = literalCredential(step);
          if (header) return { error: literalCredentialMessage(header, against.name) };
          const base = targetBase(against, r.route.unit, groups);
          return "error" in base ? { error: base.error } : { base: base.base, contentType };
        }
        const target = devTarget(r.route.unit, devServerState(), groups);
        if (target.kind !== "ready") return { error: targetProblem(r.route.unit, target.kind, groups) };
        return { base: target.url, contentType };
      },
      send: (req) => sendOne(req, abort),
    };
  }

  const startupDecorations = vscode.window.onDidChangeVisibleTextEditors(decorateAll);

  // --- CodeLens ------------------------------------------------------------

  const lenses: vscode.CodeLensProvider = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      if (!vscode.workspace.getConfiguration("bynk").get<boolean>("scenario.codeLens", true)) return [];
      const scenario = parseScenario(doc.getText());
      if (scenario.steps.length === 0) return [];
      const key = doc.uri.toString();
      const uri = doc.uri.toString();
      const busy = running.has(key);
      const view = runs.get(key);
      const fresh = view && view.version === doc.version ? view : undefined;
      const out: vscode.CodeLens[] = [];
      const at = (line: number): vscode.Range => new vscode.Range(line, 0, line, 0);
      const first = scenario.steps[0].line;
      out.push(new vscode.CodeLens(at(first), { title: busy ? "$(sync~spin) Running…" : "$(run-all) Run scenario", command: "bynk.scenario.run", arguments: [uri] }));
      if (!busy) {
        out.push(new vscode.CodeLens(at(first), { title: "$(cloud) Run against…", tooltip: "Run the scenario against a [test.targets] target", command: "bynk.scenario.runAgainst", arguments: [uri] }));
      }
      out.push(new vscode.CodeLens(at(first), { title: "$(beaker) Promote to test suite", tooltip: "Write the scenario as a system-tier test suite", command: "bynk.scenario.promote", arguments: [uri] }));
      if (fresh) {
        const rs = [...fresh.results.values()];
        const bad = rs.filter((r) => r.state === "failed" || r.state === "error").length;
        out.push(
          new vscode.CodeLens(at(first), {
            title: `${bad === 0 ? "$(pass)" : "$(error)"} ${rs.filter((r) => r.state === "passed").length}/${rs.length} passed${fresh.target ? ` on ${fresh.target}` : ""}`,
            command: "bynk.scenario.showOutput",
          }),
        );
      }
      for (const step of scenario.steps) {
        out.push(new vscode.CodeLens(at(step.line), { title: "$(play) Run step", tooltip: "Run this step, and the steps whose responses it reads", command: "bynk.scenario.run", arguments: [uri, step.name] }));
        const r = fresh?.results.get(step.name);
        if (r) {
          const icon = r.state === "passed" ? "$(pass)" : r.state === "skipped" ? "$(circle-slash)" : "$(error)";
          const text = r.state === "skipped" ? "skipped" : r.status !== undefined ? `${r.status}${r.ms !== undefined ? ` · ${r.ms} ms` : ""}` : "not sent";
          out.push(new vscode.CodeLens(at(step.line), { title: `${icon} ${text}`, tooltip: r.message, command: "bynk.scenario.showOutput" }));
        }
      }
      return out;
    },
  };

  // --- Edge cases (#233) ---------------------------------------------------

  // A step that resolves to a route offers the command for it; one that does
  // not (no such handler, several contexts, the server not answering) offers
  // nothing. It is a code action, not a lens, so a scenario gains no line.
  const edgeCases: vscode.CodeActionProvider = {
    async provideCodeActions(doc, range) {
      const root = await rootOf(doc);
      if (!root) return [];
      const scenario = parseScenario(doc.getText());
      const step = scenario.steps.find((s) => s.requestLine >= 0 && range.start.line >= s.line && range.start.line <= s.endLine);
      if (!step) return [];
      const set = await index.routes(root);
      if (!set.complete) return [];
      const ref = stepRoute(set.routes, step, doc.uri.toString());
      if (!ref) return [];
      const action = new vscode.CodeAction(`Generate edge cases for ${ref.method} ${ref.path}`, vscode.CodeActionKind.Empty.append("bynk").append("edgeCases"));
      action.command = { title: "Generate edge cases", command: "bynk.generateEdgeCases", arguments: [ref] };
      return [action];
    },
  };

  // --- Save ----------------------------------------------------------------

  interface SaveArgs extends SaveSpec {
    handlerUri: string;
  }

  async function save(args: SaveArgs): Promise<vscode.Uri | undefined> {
    const handler = vscode.Uri.parse(args.handlerUri);
    const root = (await projectRootFor(handler)) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      void vscode.window.showErrorMessage("Bynk: open the project's folder to save a scenario into it.");
      return undefined;
    }
    const existing = await vscode.workspace.findFiles(new vscode.RelativePattern(root, GLOB), EXCLUDE);
    const rel = (u: vscode.Uri): string => vscode.workspace.asRelativePath(u, false);
    const NEW = "$(add) New scenario…";
    const pick = await vscode.window.showQuickPick(
      [NEW, ...existing.map(rel).sort()],
      { title: `Save ${args.method} ${args.path} to a scenario`, placeHolder: "Append to a scenario file, or start a new one" },
    );
    if (!pick) return undefined;
    let target: vscode.Uri;
    if (pick === NEW) {
      const name = await vscode.window.showInputBox({
        title: "New scenario",
        prompt: `Saved as ${vscode.workspace.asRelativePath(vscode.Uri.joinPath(root, "scenarios"), false)}/<name>.bynk-http`,
        value: "items",
        validateInput: (v) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) ? undefined : "Letters, digits, `.`, `_` and `-`."),
      });
      if (!name) return undefined;
      target = vscode.Uri.joinPath(root, "scenarios", `${name.replace(/\.bynk-http$/, "")}.bynk-http`);
    } else {
      target = existing.find((u) => rel(u) === pick)!;
    }
    let before = "";
    let exists = true;
    try {
      before = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
    } catch {
      exists = false;
    }
    // Through the open buffer if there is one, so unsaved edits aren't lost.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
    if (open) before = open.getText();
    const added = appendStep(before, args);
    if (open || exists) {
      const doc = open ?? (await vscode.workspace.openTextDocument(target));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(target, new vscode.Range(0, 0, doc.lineCount, 0), added.text);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(added.text));
    }
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    const pos = new vscode.Position(added.line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
    if (added.env.length > 0) {
      void vscode.window.showInformationMessage(
        `Bynk: saved \`${added.name}\`. Credentials were not saved: ${added.env.map((e) => `{{env.${e}}}`).join(", ")} reads them from the environment, so set ${added.env.length === 1 ? "that variable" : "those variables"} before running.`,
      );
    } else {
      void vscode.window.setStatusBarMessage(`Bynk: saved ${added.name} to ${rel(target)}.`, 5000);
    }
    return target;
  }

  // --- Promote -------------------------------------------------------------

  /** **Bynk: Promote Scenario to Test Suite** (#158): the scenario as a
   *  `system`-tier suite under `tests/`, checked with the compiler before it is
   *  offered and listing anything a suite cannot express. A one-way copy. */
  async function promote(uriArg?: unknown): Promise<vscode.Uri | undefined> {
    const uri = uriArg instanceof vscode.Uri ? uriArg : typeof uriArg === "string" ? vscode.Uri.parse(uriArg) : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showErrorMessage("Bynk: Promote Scenario needs a .bynk-http file open.");
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const scenario = parseScenario(doc.getText());
    const syntax = scenario.problems.filter((p) => p.severity === "error");
    if (syntax.length > 0) {
      void vscode.window.showErrorMessage(`Bynk: fix the scenario first (line ${syntax[0].line + 1}: ${syntax[0].message})`);
      return undefined;
    }
    const root = await rootOf(doc);
    if (!root) {
      void vscode.window.showErrorMessage("Bynk: this scenario isn't inside a project (no bynk.toml found).");
      return undefined;
    }
    const resolved = await resolveAll(doc, scenario);
    if (scenario.steps.some((s, i) => s.requestLine >= 0 && !resolved[i])) {
      void vscode.window.showErrorMessage("Bynk: the language server couldn't say which handlers serve this scenario. Wait for it to start and try again.");
      return undefined;
    }

    // Credentials are the case's `by <Actor>`, never a header: ask which actor.
    const routes = resolved.flatMap((r) => (r && !("error" in r) ? [r.route as PromoteRoute] : []));
    const credentialed = scenario.steps.some((s) => s.headers.some((h) => isSensitiveHeader(h.name)));
    const admits = (r: PromoteRoute): string[] => r.actors ?? [];
    const guarded = routes.some((r) => admits(r).length > 0 && !admits(r).includes("Visitor"));
    let chosen: string | undefined;
    let rule: string;
    if (credentialed || guarded) {
      const names = [...new Set(routes.flatMap(admits))].filter((a) => a !== "Visitor");
      let actor: string | undefined = names.length === 1 ? names[0] : undefined;
      if (names.length !== 1) {
        actor = await vscode.window.showQuickPick(names.length > 0 ? names : ["Visitor"], {
          title: "Promote to a test suite: run the case as which actor?",
          placeHolder: credentialed ? "The scenario sends credentials; a suite carries them as the case's actor" : "These routes admit an actor",
        });
        if (!actor) return undefined;
      }
      if (actor === "Visitor") {
        chosen = "Visitor";
      } else {
        const identityType = routes.map((r) => r.identities?.[actor!]).find((t) => t !== undefined);
        const identity = await vscode.window.showInputBox({
          title: `Promote: the identity ${actor} runs as`,
          prompt: `A Bynk expression for ${actor}'s identity. It is written into the suite as by ${actor}(…).`,
          // An identity is a sealed type, built with `.of` (which fails the case if it is refused).
          value: identityType && identityType !== "String" ? `${identityType}.of("ada")?` : '"ada"',
          ignoreFocusOut: true,
        });
        if (identity === undefined || identity.trim() === "") return undefined;
        chosen = `${actor}(${identity.trim()})`;
      }
      rule = `Runs as ${chosen}${credentialed ? ", because the scenario sends credentials (a suite carries them as the case's actor, never a header)" : ", because its routes are guarded by an actor"}; a step on a route that admits Visitor runs as Visitor.`;
    } else {
      rule = "Runs as Visitor on routes that admit it, and with no actor on routes that name none.";
    }
    const result = promoteScenario(scenario, resolved, {
      name: vscode.workspace.asRelativePath(uri, false),
      actorRule: rule,
      actorFor: (step, route) => {
        const a = admits(route);
        if (step.headers.some((h) => isSensitiveHeader(h.name))) return chosen;
        if (a.includes("Visitor")) return "Visitor";
        return a.length > 0 ? chosen : undefined;
      },
    });
    if (!result.ok) {
      void vscode.window.showErrorMessage(`Bynk: can't promote this scenario. ${result.reason}`);
      return undefined;
    }

    const base = vscode.workspace
      .asRelativePath(uri, false)
      .replace(/^.*[\\/]/, "")
      .replace(/\.bynk-http$/, "")
      .replace(/[^A-Za-z0-9._-]/g, "_");
    const target = vscode.Uri.joinPath(root, "tests", `${base}.bynk`);
    // The compiler checks the suite before it is offered; nothing is written otherwise.
    const verdict = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Checking the generated suite…", cancellable: true },
      (_p, token) => checkSuiteInCopy(root.fsPath, path.join("tests", `${base}.bynk`), result.text, token),
    );
    if (verdict.kind !== "ok") {
      output.appendLine(`── promote ${vscode.workspace.asRelativePath(uri, false)} ──`);
      output.appendLine(result.text);
      if (verdict.kind === "errors") for (const d of verdict.errors) output.appendLine(describeDiagnostic(d));
      output.show(true);
      void vscode.window.showErrorMessage(
        verdict.kind === "errors"
          ? `Bynk: the generated suite doesn't check, so nothing was written (${verdict.errors[0] ? describeDiagnostic(verdict.errors[0]) : "see the Bynk Scenario output"}).`
          : `Bynk: the generated suite couldn't be checked (${verdict.reason}), so nothing was written.`,
      );
      return undefined;
    }

    const WRITE = "Write suite";
    const SHOW = "Show suite";
    const pick = await vscode.window.showInformationMessage(
      `Promote to ${vscode.workspace.asRelativePath(target, false)}?`,
      { modal: true, detail: `${summarise(result)}\n\nA one-way copy: the scenario is not kept in sync with it.` },
      WRITE,
      SHOW,
    );
    if (pick === SHOW) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: "bynk", content: result.text }));
      return undefined;
    }
    if (pick !== WRITE) return undefined;
    let exists = true;
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      exists = false;
    }
    if (exists) {
      const over = await vscode.window.showWarningMessage(`${vscode.workspace.asRelativePath(target, false)} already exists. Replace it?`, { modal: true }, "Replace");
      if (over !== "Replace") return undefined;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(result.text));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
    return target;
  }

  context.subscriptions.push(
    index,
    diagnostics,
    runDiagnostics,
    output,
    lensChanged,
    passed,
    failedDeco,
    startupDecorations,
    { dispose: () => pending.forEach((t) => clearTimeout(t)) },
    vscode.languages.registerCodeLensProvider({ language: SCENARIO_LANGUAGE }, lenses),
    vscode.languages.registerCodeActionsProvider({ language: SCENARIO_LANGUAGE }, edgeCases),
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== SCENARIO_LANGUAGE) return;
      // What a run showed is about the text it ran.
      if (runs.delete(e.document.uri.toString())) {
        runDiagnostics.delete(e.document.uri);
        decorateAll();
      }
      schedule(e.document);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      diagnostics.delete(d.uri);
      runDiagnostics.delete(d.uri);
      runs.delete(d.uri.toString());
    }),
    index.onDidChange(revalidateOpen),
    // Only the file and step reach `run`: its third argument is the target.
    vscode.commands.registerCommand("bynk.scenario.run", (uri?: unknown, step?: unknown) => run(uri, step)),
    vscode.commands.registerCommand("bynk.scenario.runAgainst", runAgainst),
    vscode.commands.registerCommand("bynk.scenario.promote", promote),
    vscode.commands.registerCommand("bynk.scenario.showOutput", () => output.show(true)),
    // The Send Request panel's "Save to scenario…" (and the tests' seam).
    vscode.commands.registerCommand("bynk._scenarioSave", save),
  );
  for (const doc of vscode.workspace.textDocuments) schedule(doc, 0);
}

/** Send one request, as Send Request does: not following redirects, with a
 *  time limit, and the body read to a size limit. */
async function sendOne(
  req: { method: string; url: string; headers: [string, string][]; body?: string },
  outer: AbortController,
): Promise<Sent | { error: string }> {
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  outer.signal.addEventListener("abort", stop);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, TIMEOUT_MS);
  const started = Date.now();
  try {
    let res: Response;
    try {
      res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: "manual", signal: abort.signal });
    } catch (e) {
      if (abort.signal.aborted) return { error: timedOut ? `No response after ${TIMEOUT_MS / 1000} s.` : "Cancelled." };
      return { error: fetchFailure(req.url, e) };
    }
    const read = await readBody(res, () => abort.signal.aborted);
    if (abort.signal.aborted && !timedOut) return { error: "Cancelled." };
    const contentType = res.headers.get("content-type");
    const body = isTextual(contentType)
      ? new TextDecoder().decode(read.bytes)
      : `(${read.bytes.length} bytes of ${contentType}, not shown)`;
    return { method: req.method, url: req.url, status: res.status, statusText: res.statusText, ms: Date.now() - started, headers: [...res.headers.entries()], body };
  } catch (e) {
    return { error: `The response broke off: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
    outer.signal.removeEventListener("abort", stop);
  }
}
