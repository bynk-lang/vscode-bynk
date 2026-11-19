// #229: Generate Edge Cases…: boundary values for a route's refined inputs, as a
// notebook. The pure part is `edgeCasesCore.ts`; this reads the route and the
// refined types from the language server, runs every candidate through the real
// constructor with `bynk eval` (the same `Type.of(…)` call a refined-type cell
// makes, #198), and writes the notebook for the user to run and promote
// (#212). The outcomes come from the compiler, never from the predicates.

import * as vscode from "vscode";

import { BynkNotFoundError, runBynk } from "./cli";
import { dirtyBuffers } from "./dirtyBuffers";
import { buildNotebook, buildScenario, candidatesFor, notebookFileName, scenarioFileName, refinedFields, successLine, typesOf, validSample, type EdgeCandidate, type RefinedField, type TypeVerdicts, type Verdict } from "./edgeCasesCore";
import { commandTarget } from "./livePanel";
import { decodeEval, decodeRefined, evalArgs, refinedSource, serializeNotebook, type RefinedCell } from "./notebookCore";
import { projectRootFor } from "./projectRoots";
import { projectRoutes } from "./scenario";
import { actorClause, writeCall } from "./scenarioPromoteCore";
import { isHttpHandler } from "./sendRequest";
import type { ViewRefresh } from "./viewRefresh";
import { registerHandlerLens } from "./viewsCodeLens";
import { requestWireContract } from "./wireContract";
import type { RefinedModel } from "./webview/refinedTypes";

const GRACE_MS = 15_000;
/** The explorer's examples tried beside the generated candidates, only to find a value the type accepts. */
const PROBES = 5;

function fail(message: string): undefined {
  void vscode.window.showErrorMessage(`Bynk Edge Cases: ${message}`);
  return undefined;
}

/** What the constructor says of `texts`, in one `bynk eval`: a row for each. */
async function ask(root: vscode.Uri, unit: string, type: string, texts: readonly string[], token: vscode.CancellationToken): Promise<{ rows: { text: string; accepted: boolean; message?: string }[] } | { error: string }> {
  const cell: RefinedCell = { type, candidates: texts.map((text, line) => ({ text, line })) };
  const { text, sent } = refinedSource(texts.join("\n"), cell);
  const buffers = dirtyBuffers(root.fsPath);
  const hasBuffers = Object.keys(buffers).length > 0;
  const seconds = vscode.workspace.getConfiguration("bynk").get<number>("notebook.timeoutSeconds") ?? 60;
  const source = new vscode.CancellationTokenSource();
  const sub = token.onCancellationRequested(() => source.cancel());
  const timer = setTimeout(() => source.cancel(), seconds * 1000 + GRACE_MS);
  try {
    const r = await runBynk(evalArgs({ root: root.fsPath, unit, snippet: text, sourcesStdin: hasBuffers, timeoutSeconds: seconds }), root.fsPath, source.token, hasBuffers ? JSON.stringify(buffers) : undefined);
    const result = decodeEval(r.stdout, r.stderr, r.code);
    if (result.kind === "error") return { error: result.message };
    if (result.kind === "diagnostics") return { error: result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ") || "bynk eval gave no value" };
    const rows = decodeRefined(sent, result.value);
    if (!rows) return { error: `${type}.of did not answer a result for each value` };
    return { rows: rows.map((x) => ({ text: x.candidate.text, accepted: x.outcome === "accepted", message: x.message })) };
  } catch (e) {
    return { error: e instanceof BynkNotFoundError || e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
    sub.dispose();
    source.dispose();
  }
}

export function registerEdgeCases(context: vscode.ExtensionContext, hub: ViewRefresh): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("bynk.generateEdgeCases", (uriArg?: unknown, positionArg?: unknown) => generate(hub, uriArg, positionArg)),
  );
  // Off by default: every HTTP handler already carries `Send request` and the
  // server's own lenses. The command is in the palette and on the handler's menu.
  registerHandlerLens(context, hub, {
    setting: "edgeCases.codeLens",
    enabledByDefault: false,
    title: "Edge cases",
    tooltip: "Generate a notebook of boundary values for this route's refined inputs",
    command: "bynk.generateEdgeCases",
    filter: (document, h) => isHttpHandler(document, h.symbol.range),
  });
}

async function generate(hub: ViewRefresh, uriArg: unknown, positionArg: unknown): Promise<vscode.Uri | undefined> {
  if (!vscode.workspace.isTrusted) return fail("trust this workspace first: the values are run with `bynk eval`, which compiles and runs your project's code.");
  const target = commandTarget(uriArg, positionArg, true);
  if (!target?.position) return fail("place the cursor on an HTTP handler.");
  const client = await hub.whenClient(5_000);
  if (!client) return fail("the language server isn't running yet.");
  const wc = await requestWireContract(client, target);
  if (!wc || wc.model.kind.kind !== "Http") return fail("place the cursor on an HTTP handler (`on GET(\"/x\")`, …): edge cases are generated for a route's inputs.");
  const { unit } = wc.model;
  const { method, path } = wc.model.kind;
  const root = await projectRootFor(vscode.Uri.parse(target.uri));
  if (!root) return fail("this file is not in a Bynk project (no `bynk.toml` above it).");
  const { routes, complete } = await projectRoutes(root);
  const route = routes.find((r) => r.unit === unit && r.method === method && r.path === path && r.service === wc.model.service);
  if (!route) return fail(complete ? `the language server has no route for \`${method} ${path}\`.` : "the language server hasn't described the project's handlers yet. Wait for it to start and try again.");
  const label = `${method} ${path}`;

  const { fields, leftOut } = refinedFields(route.model);
  if (fields.length === 0) {
    void vscode.window.showInformationMessage(`Bynk Edge Cases: \`${label}\` takes no refined value, so there is no boundary to probe.${leftOut.length > 0 ? ` (${leftOut.join("; ")})` : ""}`);
    return undefined;
  }
  const admits = route.actors ?? [];
  let actor: string | undefined;
  if (admits.length > 0) {
    actor = admits.includes("Visitor") ? "Visitor" : admits.length === 1 ? admits[0] : await vscode.window.showQuickPick(admits, { title: "Run the cases as which actor?", ignoreFocusOut: true });
    if (!actor) return undefined;
  }
  const by = actor ? actorClause(actor, route.identities?.[actor]) : undefined;

  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Bynk: edge cases for ${label}`, cancellable: true }, async (_progress, token) => {
    const notes = [...leftOut];
    const byType = new Map<string, TypeVerdicts>();
    const valid = new Map<string, string | number>();
    for (const type of typesOf(fields)) {
      const decl = route.model.types.find((t) => t.name === type);
      const model = decl?.loc ? await refinedModel(client, decl.loc.uri, decl.loc.range.start) : undefined;
      if (!model) {
        notes.push(`${type}: the language server gave no refined-type model for it`);
        continue;
      }
      const { candidates, leftOut: skipped } = candidatesFor(model);
      notes.push(...skipped.map((s) => `${type}: ${s}`));
      const probes: EdgeCandidate[] = model.examples
        .slice(0, PROBES)
        .map((e) => ({ text: model.base === "String" ? JSON.stringify(e) : e, why: "", shown: e }))
        .filter((p) => !candidates.some((c) => c.text === p.text) && !/[\u0000-\u001f]/.test(p.text.replace(/^"|"$/g, "")));
      const sent = [...candidates, ...probes];
      if (sent.length === 0) continue;
      const answered = await ask(root, unit, type, sent.map((c) => c.text), token);
      if (token.isCancellationRequested) return undefined;
      if ("error" in answered) {
        notes.push(`${type}: its values could not be run (${answered.error})`);
        continue;
      }
      const all: Verdict[] = answered.rows.map((r, i) => ({ candidate: sent[i], outcome: r.accepted ? "accepted" : "refused", message: r.message }));
      byType.set(type, { type, verdicts: all.slice(0, candidates.length) });
      const sample = validSample(all);
      if (sample === undefined) notes.push(`${type}: no value it accepts was found, so the other fields of a case carry a placeholder that may not satisfy it`);
      else valid.set(type, sample);
    }
    const success = successLine(route, "response");
    const holes = new Set<string>();
    // The route's own refusal: refused values sent raw, in a scenario beside the notebook.
    const scenario = buildScenario({ unit, route, fields, byType, valid, credentialed: actor !== undefined && actor !== "Visitor" });
    if (scenario) notes.push(...scenario.leftOut.map((l) => `scenario: ${l}`));
    const scenarioName = scenario ? scenarioFileName(method, path) : undefined;
    const built = buildNotebook({
      unit,
      route: label,
      fields,
      byType,
      leftOut: notes,
      scenario: scenarioName ? `edge-cases/${scenarioName}` : undefined,
      success: "why" in success ? success : { line: () => success.line },
      call: (field: RefinedField, text: string) => {
        const value: string | number = text.startsWith('"') ? (JSON.parse(text) as string) : Number(text);
        const written = writeCall(route, by, { valid, set: { param: field.param, path: field.path, value } });
        written?.holes.forEach((h) => holes.add(h));
        return written?.text;
      },
    });
    if (built.cases === 0) {
      void vscode.window.showInformationMessage(`Bynk Edge Cases: no boundary value could be derived for \`${label}\`.${notes.length > 0 ? ` ${notes.join("; ")}` : ""}`);
      return undefined;
    }
    const uri = await write(root, notebookFileName(method, path), serializeNotebook(built.notebook));
    const scenarioUri = scenario && scenarioName ? await write(root, scenarioName, scenario.text) : undefined;
    const doc = await vscode.workspace.openNotebookDocument(uri);
    await vscode.window.showNotebookDocument(doc);
    void vscode.window.showInformationMessage(`Bynk Edge Cases: ${built.cases} cases for \`${label}\` (${built.accepted} accepted, ${built.refused} refused by the compiler). Run the cells, then Promote Notebook to Suite.${scenarioUri ? ` The refused values are also sent raw by ${vscode.workspace.asRelativePath(scenarioUri, false)}, which runs against bynk dev.` : ""}${holes.size > 0 ? ` Fill in: ${[...holes].join("; ")}` : ""}`);
    return uri;
  });
}

async function refinedModel(client: NonNullable<Awaited<ReturnType<ViewRefresh["whenClient"]>>>, uri: string, position: { line: number; character: number }): Promise<RefinedModel | undefined> {
  try {
    return (await client.sendRequest<RefinedModel | null>("bynk/refinedTypeModel", { textDocument: { uri }, position })) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Write `text` to `edge-cases/<name>` in the project, numbering it when the file is there. */
async function write(root: vscode.Uri, name: string, text: string): Promise<vscode.Uri> {
  const dir = vscode.Uri.joinPath(root, "edge-cases");
  await vscode.workspace.fs.createDirectory(dir);
  for (let n = 1; ; n++) {
    const file = vscode.Uri.joinPath(dir, n === 1 ? name : name.replace(/\.bynknb$/, `-${n}.bynknb`));
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
      return file;
    }
  }
}

