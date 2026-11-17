// #146: "Bynk: Show Impact" — for the type, event or service at the cursor,
// everything that depends on it, in an Impact view in the Bynk sidebar. The
// join is `impactCore.ts`'s; this gathers what the language server knows (the
// references, the architecture model, each handler's wire contract and the
// contract diff), the test cases and `[build.client]`, and shows the answer as
// a tree whose rows open their source. It is a snapshot of the symbol it was
// asked about, redrawn on the live views' trigger (it follows no cursor).
//
// It builds on the Query view's models (#148) and the same shared tree nodes.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { requestArchitectureModel } from "./architectureMap";
import { requestContractDiff } from "./contractDiff";
import { type ClientConfig, clientConfig, type ImpactAnswer, type ImpactInput, impactOf, type Ref, relocate, type UnitKind, type WireSite } from "./impactCore";
import { parseUnitHeader } from "./projectModel";
import { projectRootFor } from "./projectRoots";
import { usesUnknown } from "./queryCore";
import type { TestApi } from "./testing";
import { group, note, nodesAsText, type ResultNode, resultItem, rows } from "./treeNodes";
import type { ViewRefresh } from "./viewRefresh";
import type { ArchModel } from "./webview/architectureTypes";
import type { WcModel } from "./webview/wireContractTypes";
import { wireCarries } from "./wireDiffCore";

/** The most references listed; a name used more often is cut and says so. */
const MAX_REFERENCES = 500;

interface Target {
  uri: string;
  position: vscode.Position;
  /** The name asked about, fixed by the first `show`, so a reload after an edit
   *  looks for it again rather than for whatever now sits at the position. */
  name?: string;
}

export class ImpactTreeProvider implements vscode.TreeDataProvider<ResultNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ResultNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private target: Target | undefined;
  private roots: ResultNode[] = [note("Run “Bynk: Show Impact” on a type, event or service.")];
  private generation = 0;
  private title: ((t: string | undefined) => void) | undefined;

  constructor(
    private readonly hub: ViewRefresh,
    private readonly tests: TestApi,
  ) {}

  /** The view's title follows the symbol shown. */
  onTitle(set: (t: string | undefined) => void): void {
    this.title = set;
  }

  async show(target: Target): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri)).then((d) => d, () => undefined);
    const range = doc?.getWordRangeAtPosition(target.position);
    this.target = { ...target, name: range ? doc?.getText(range) : undefined };
    await this.reload();
  }

  async reload(): Promise<void> {
    const target = this.target;
    if (!target) return;
    const generation = ++this.generation;
    this.roots = [note("Working out what depends on it…")];
    this.emitter.fire(undefined);
    let roots: ResultNode[];
    try {
      roots = await this.compute(target);
    } catch (err) {
      roots = [note(`Could not work out the impact: ${String(err)}`)];
    }
    if (generation !== this.generation) return;
    this.roots = roots;
    this.emitter.fire(undefined);
  }

  getTreeItem(node: ResultNode): vscode.TreeItem {
    return resultItem(node);
  }

  getChildren(node?: ResultNode): ResultNode[] {
    if (!node) return this.roots;
    return node.type === "group" ? node.children : [];
  }

  private async compute(target: Target): Promise<ResultNode[]> {
    const client = this.hub.getClient();
    if (!client) return [note("The language server is not running.")];
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
    const wordRange = doc.getWordRangeAtPosition(target.position);
    const name = target.name ?? (wordRange ? doc.getText(wordRange) : undefined);
    if (!name) return [note("There is no name at the cursor.")];
    this.title?.(name);
    if ((wordRange ? doc.getText(wordRange) : undefined) !== name) {
      // Edited since it was asked: find the same name again, nearest where it was.
      const at = relocate(Array.from({ length: doc.lineCount }, (_, i) => doc.lineAt(i).text), name, target.position.line, target.position.character);
      if (!at) return [note(`\`${name}\` is no longer in this file: run “Bynk: Show Impact” on it again.`)];
      target = { ...target, position: new vscode.Position(at.line, at.character) };
      this.target = target;
    }

    const refs = await references(doc.uri, target.position);
    const def = await definitionUri(doc.uri, target.position);
    const model = await requestArchitectureModel(client, this.hub, target.uri).catch(() => null);
    const contract = await requestContractDiff(client, this.hub, target.uri).catch(() => null);
    const unitOf = await unitsOf([target.uri, ...refs.list.map((r) => r.uri), ...(def ? [def] : [])]);
    const root = await projectRootFor(doc.uri);
    const input: ImpactInput = {
      name,
      // Where the name is declared; when the server finds no definition the cursor is
      // taken to be on it, which is the usual place to ask.
      declaringUnit: unitOf[def ?? target.uri]?.name,
      references: refs.list,
      unitOf,
      model,
      wires: model ? await wireSites(client, model, name) : [],
      contract,
      testCases: this.testCasesOf(refs.list, unitOf),
      client: root ? await readClientConfig(root) : { configured: false, services: [] },
    };
    const answer = impactOf(input);
    if (model && usesUnknown(model)) {
      answer.notes.push("This language server does not report each unit's handlers (needs bynk v0.625.3), so the wire contracts and client routes that carry it cannot be listed.");
    }
    if (refs.cut) answer.notes.push(`Only the first ${MAX_REFERENCES} references are used.`);
    return this.nodes(answer);
  }

  private testCasesOf(refs: readonly Ref[], unitOf: ImpactInput["unitOf"]): ImpactInput["testCases"] {
    const out: Record<string, Array<{ name: string; range: Ref["range"] }>> = {};
    for (const r of refs) {
      if (unitOf[r.uri]?.kind !== "test" || out[r.uri]) continue;
      out[r.uri] = this.tests.testCases(vscode.Uri.parse(r.uri)).map((c) => ({
        name: c.name,
        range: { start: { line: c.range.start.line, character: c.range.start.character }, end: { line: c.range.end.line, character: c.range.end.character } },
      }));
    }
    return out;
  }

  private nodes(a: ImpactAnswer): ResultNode[] {
    const out: ResultNode[] = [];
    out.push(
      group(
        "Other units",
        a.units.length > 0
          ? a.units.map((u) => group(u.unit, rows(u.rows), `${u.kind}: ${u.why.join(", ")}`))
          : [note("No other unit uses it.")],
        a.units.length > 0 ? `${a.units.length}` : undefined,
        a.units.length > 0,
      ),
    );
    if (a.event) {
      out.push(
        group(
          "Events",
          [
            group("Emitted by", a.event.emitters.length > 0 ? rows(a.event.emitters) : [note("Nothing emits it.")], undefined, true),
            group("Subscribed to by", a.event.subscribers.length > 0 ? rows(a.event.subscribers) : [note("Nobody subscribes.")], undefined, true),
          ],
          undefined,
          true,
        ),
      );
    }
    const b = a.boundary;
    out.push(
      group(
        "The boundary",
        [
          group("Wire contracts carrying it", b.wire.length > 0 ? rows(b.wire) : [note("No handler's wire contract carries it.")], `${b.wire.length}`, b.wire.length > 0),
          group("Changed against bynk.schema.lock", b.changes.length > 0 ? rows(b.changes) : [note("The contract diff reports no change to it.")], `${b.changes.length}`, b.changes.length > 0),
          group("Deployed service contracts that changed", b.deployed.length > 0 ? rows(b.deployed) : [note("None of the carrying services has a changed deployed contract.")], `${b.deployed.length}`, b.deployed.length > 0),
        ],
        undefined,
        true,
      ),
    );
    out.push(
      group(
        "Generated TypeScript client",
        a.client.configured
          ? a.client.routes.length > 0
            ? rows(a.client.routes)
            : [note("No route of the client carries it.")]
          : [note("The project has no [build.client].")],
        a.client.configured ? `${a.client.routes.length}` : undefined,
        a.client.routes.length > 0,
      ),
    );
    out.push(group("Tests", a.tests.length > 0 ? rows(a.tests) : [note("No test mentions it.")], `${a.tests.length}`, a.tests.length > 0));
    for (const n of a.notes) out.push(note(n));
    return out;
  }

  /** Test seam: the shown tree as text. */
  snapshot(): Promise<string[]> {
    return nodesAsText(this.roots);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

async function references(uri: vscode.Uri, position: vscode.Position): Promise<{ list: Ref[]; cut: boolean }> {
  const found = (await vscode.commands.executeCommand<vscode.Location[] | undefined>("vscode.executeReferenceProvider", uri, position)) ?? [];
  const list = found.slice(0, MAX_REFERENCES).map((l) => ({ uri: l.uri.toString(), range: l.range }));
  return { list: list.map((r) => ({ uri: r.uri, range: toRange(r.range) })), cut: found.length > MAX_REFERENCES };
}

const toRange = (r: vscode.Range): Ref["range"] => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
});

async function definitionUri(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
  const found = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink> | undefined>(
    "vscode.executeDefinitionProvider",
    uri,
    position,
  );
  const first = found?.[0];
  if (!first) return undefined;
  return ("targetUri" in first ? first.targetUri : first.uri).toString();
}

/** Each file's unit, from its header. */
async function unitsOf(uris: readonly string[]): Promise<ImpactInput["unitOf"]> {
  const out: Record<string, { name: string; kind: UnitKind } | undefined> = {};
  for (const uri of new Set(uris)) {
    try {
      const text = await fs.readFile(vscode.Uri.parse(uri).fsPath, "utf8");
      const header = parseUnitHeader(text);
      out[uri] = header ? { name: header.name, kind: header.kind } : undefined;
    } catch {
      out[uri] = undefined;
    }
  }
  return out;
}

/** Where the symbol travels in each service handler's wire contract. */
async function wireSites(client: LanguageClient, model: ArchModel, name: string): Promise<WireSite[]> {
  const members = model.nodes.flatMap((n) => (n.uses ?? []).filter((h) => h.member.kind === "service").map((h) => h.member));
  const sites: WireSite[] = [];
  const read = async (m: (typeof members)[number]): Promise<void> => {
    let wc: WcModel | null;
    try {
      wc = await client.sendRequest<WcModel | null>("bynk/wireContract", {
        textDocument: { uri: m.loc.uri },
        position: m.loc.range.start,
      });
    } catch {
      return;
    }
    if (!wc) return;
    const carries = wireCarries(wc, name);
    if (!carries.request && !carries.response) return;
    sites.push({
      unit: wc.unit,
      service: wc.service,
      label: wc.kind.kind === "Http" ? `${wc.kind.method} ${wc.kind.path}` : m.handler,
      boundary: wc.kind.kind === "Http" ? "Http" : wc.kind.kind === "Call" ? "Call" : "Other",
      loc: m.loc,
      carries,
      inferred: wc.kind.kind === "Call" || (wc.kind.kind === "Http" && wc.success === undefined),
    });
  };
  // A few at a time: each is a round trip to the server.
  for (let i = 0; i < members.length; i += 6) await Promise.all(members.slice(i, i + 6).map(read));
  return sites.sort((a, b) => `${a.unit}.${a.service}${a.label}`.localeCompare(`${b.unit}.${b.service}${b.label}`));
}

async function readClientConfig(root: vscode.Uri): Promise<ClientConfig> {
  try {
    return clientConfig(await fs.readFile(path.join(root.fsPath, "bynk.toml"), "utf8"));
  } catch {
    return { configured: false, services: [] };
  }
}

export function registerImpactView(context: vscode.ExtensionContext, hub: ViewRefresh, tests: TestApi): ImpactTreeProvider {
  const provider = new ImpactTreeProvider(hub, tests);
  const view = vscode.window.createTreeView("bynk.impact", { treeDataProvider: provider, showCollapseAll: true });
  provider.onTitle((t) => {
    view.title = t ? `Impact: ${t}` : "Impact";
  });
  context.subscriptions.push(
    provider,
    view,
    hub.onDidRefresh(() => void provider.reload()),
    vscode.commands.registerCommand("bynk.showImpact", async (uriArg?: unknown, positionArg?: unknown) => {
      const editor = vscode.window.activeTextEditor;
      const uri = typeof uriArg === "string" ? uriArg : editor?.document.languageId === "bynk" ? editor.document.uri.toString() : undefined;
      const pos = isPosition(positionArg) ? new vscode.Position(positionArg.line, positionArg.character) : editor?.selection.active;
      if (!uri || !pos) {
        void vscode.window.showErrorMessage("Bynk: Show Impact needs the cursor on a name in a .bynk file.");
        return;
      }
      await vscode.commands.executeCommand("bynk.impact.focus");
      await provider.show({ uri, position: pos });
    }),
    vscode.commands.registerCommand("bynk._impactAnswer", () => provider.snapshot()),
  );
  return provider;
}

function isPosition(v: unknown): v is { line: number; character: number } {
  return typeof v === "object" && v !== null && Number.isInteger((v as { line?: unknown }).line) && Number.isInteger((v as { character?: unknown }).character);
}
