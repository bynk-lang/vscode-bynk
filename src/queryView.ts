// #148: the Bynk Query view — ready-made questions about the open project, in
// the Bynk sidebar, each answer a list that opens its source. The answers are
// `queryCore.ts`'s; this is the tree and the commands.
//
//   - Events: who emits each event and who subscribes (`bynk/architectureModel`).
//   - Capabilities: per context, what it declares, consumes and provides, and
//     which handlers use each and which suites stub it.
//   - Reachability: the handlers from which a capability can be reached,
//     through `given` and the calls between handlers, across contexts. Pick the
//     capability with the view's title button.
//   - Untested: the routes, handlers and agent transitions no line of which ran
//     in the last coverage run (#144). Line-level and whole-run, so it never
//     says which test reached what.
//
// It reads the project of the active `.bynk` file (else the workspace's
// project), through the hub's shared model cache, and refreshes with the live
// views and when a coverage run lands.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { requestArchitectureModel } from "./architectureMap";
import { modelCoverage } from "./modelCoverage";
import type { ModelCoverage } from "./modelCoverageCore";
import { activeProjectRoot } from "./projectRoots";
import {
  type CapabilityChoice,
  capabilitiesQuery,
  capabilityChoices,
  choiceLabel,
  eventsQuery,
  type HandlerSite,
  reachability,
  type Row,
  untestedQuery,
  type UntestedAnswer,
} from "./queryCore";
import { enclosingHandler } from "./refreshScheduler";
import type { ViewRefresh } from "./viewRefresh";
import type { ArchModel } from "./webview/architectureTypes";
import type { AgentStateModel } from "./webview/stateTypes";
import { revealLocation } from "./webviewHost";

type QueryId = "events" | "capabilities" | "reachability" | "untested";

type Node =
  | { type: "query"; id: QueryId }
  | { type: "group"; label: string; description?: string; children: Node[]; open?: boolean }
  | { type: "row"; row: Row }
  | { type: "note"; text: string; command?: vscode.Command };

const QUERIES: Record<QueryId, { label: string; tip: string; icon: string }> = {
  events: { label: "Events", tip: "Who emits each event, and who subscribes", icon: "broadcast" },
  capabilities: { label: "Capabilities", tip: "What each context declares, provides and uses, and what stubs it", icon: "shield" },
  reachability: { label: "Reachability", tip: "The handlers from which a capability can be reached", icon: "type-hierarchy" },
  untested: { label: "Untested", tip: "Routes, handlers and transitions no line of which ran in the last coverage run", icon: "beaker" },
};

const note = (text: string, command?: vscode.Command): Node => ({ type: "note", text, command });
const rows = (list: readonly Row[]): Node[] => list.map((row) => ({ type: "row", row }));
const group = (label: string, children: Node[], description?: string, open = false): Node => ({ type: "group", label, description, children, open });

export class QueryTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private choice: CapabilityChoice | undefined;
  /** Bumped on each refresh so an answer that took long is not shown late. */
  private generation = 0;

  constructor(private readonly hub: ViewRefresh) {}

  refresh(): void {
    this.generation++;
    this.emitter.fire(undefined);
  }

  /** Choose the capability Reachability answers for. */
  async pickCapability(): Promise<void> {
    const model = await this.model();
    if (!model) {
      void vscode.window.showInformationMessage("Bynk: no architecture model for the open project yet.");
      return;
    }
    const choices = capabilityChoices(model);
    if (choices.length === 0) {
      void vscode.window.showInformationMessage(
        "Bynk: no handler's given names a capability, or the language server predates this (v0.625.3).",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      choices.map((c) => ({ label: choiceLabel(c), description: `${c.users} handler${c.users === 1 ? "" : "s"} given it`, choice: c })),
      { title: "Which handlers can reach…", placeHolder: "A capability" },
    );
    if (!picked) return;
    this.choice = picked.choice;
    this.refresh();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case "query": {
        const q = QUERIES[node.id];
        const item = new vscode.TreeItem(q.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.tooltip = q.tip;
        item.iconPath = new vscode.ThemeIcon(q.icon);
        item.id = `query:${node.id}`;
        item.contextValue = `bynkQuery.${node.id}`;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(
          node.label,
          node.children.length === 0
            ? vscode.TreeItemCollapsibleState.None
            : node.open
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = node.description;
        return item;
      }
      case "row": {
        const item = new vscode.TreeItem(node.row.label);
        item.description = node.row.description;
        if (node.row.loc) {
          item.command = { command: "bynk.query.open", title: "Open", arguments: [node.row.loc.uri, node.row.loc.range] };
          item.tooltip = node.row.description ? `${node.row.label} — ${node.row.description}` : node.row.label;
        }
        return item;
      }
      case "note": {
        const item = new vscode.TreeItem(node.text);
        item.command = node.command;
        item.tooltip = node.text;
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return (Object.keys(QUERIES) as QueryId[]).map((id) => ({ type: "query", id }));
    if (node.type === "group") return node.children;
    if (node.type !== "query") return [];
    const generation = this.generation;
    try {
      const answer = await this.answer(node.id);
      return generation === this.generation ? answer : [];
    } catch (err) {
      return [note(`Could not answer: ${String(err)}`)];
    }
  }

  private async answer(id: QueryId): Promise<Node[]> {
    const model = await this.model();
    if (!model) {
      return [note("No architecture model for the open project yet (open a .bynk file, and wait for the language server).")];
    }
    switch (id) {
      case "events":
        return this.events(model);
      case "capabilities":
        return this.capabilities(model);
      case "reachability":
        return this.reachability(model);
      case "untested":
        return this.untested(model);
    }
  }

  // -- Events. --

  private events(model: ArchModel): Node[] {
    const events = eventsQuery(model);
    if (!events) return [note("This language server does not report events (needs bynk v0.625.3).")];
    if (events.length === 0) return [note("The project declares no events.")];
    return events.map((e) => ({
      type: "group" as const,
      label: e.name,
      description: `${e.emitters.length} emit, ${e.subscribers.length} subscribe`,
      children: [
        group("Emitted by", e.emitters.length > 0 ? rows(e.emitters) : [note("Nothing emits it.")], undefined, true),
        group("Subscribed to by", e.subscribers.length > 0 ? rows(e.subscribers) : [note("Nobody subscribes.")], undefined, true),
        { type: "row" as const, row: { label: "Declaration", loc: e.loc } },
      ],
    }));
  }

  // -- Capabilities. --

  private capabilities(model: ArchModel): Node[] {
    const contexts = capabilitiesQuery(model);
    if (contexts.length === 0) return [note("The project has no contexts.")];
    return contexts.map((c) =>
      group(
        c.unit,
        c.rows.length === 0
          ? [note("It declares, consumes and uses no capability.")]
          : c.rows.map((r) =>
              group(
                r.from ? `${r.from}.${r.capability}` : r.capability,
                [
                  ...(r.providedBy ? [note(`Provided by ${r.providedBy.name}${r.providedBy.external ? " (external)" : ""}`)] : []),
                  ...(r.usedBy.length > 0 ? [group("Used by (given)", rows(r.usedBy), undefined, true)] : [note("No handler uses it.")]),
                  ...(r.stubbedIn.length > 0 ? [group("Stubbed in", rows(r.stubbedIn), undefined, true)] : []),
                  ...(r.loc ? [{ type: "row" as const, row: { label: "Declaration", loc: r.loc } }] : []),
                ],
                `${r.usedBy.length} used by`,
              ),
            ),
        c.kind === "Adapter" ? "adapter" : undefined,
      ),
    );
  }

  // -- Reachability. --

  private reachability(model: ArchModel): Node[] {
    const pick: vscode.Command = { command: "bynk.query.pickCapability", title: "Choose a capability" };
    if (!this.choice) return [note("Choose a capability…", pick)];
    const answer = reachability(model, this.choice);
    const out: Node[] = [note(`Reaching ${answer.capability}: choose another…`, pick)];
    if (answer.callsUnknown) {
      out.push(note("This language server sends no calls between handlers (needs bynk v0.634.4): only handlers that name it in their own given are listed."));
    }
    if (answer.reaching.length === 0) out.push(note("No handler can reach it."));
    for (const r of answer.reaching) {
      out.push({ type: "row", row: { ...r.row, description: r.direct ? "given" : `via ${r.path.join(" → ")}` } });
    }
    return out;
  }

  // -- Untested. --

  private async untested(model: ArchModel): Promise<Node[]> {
    if (!modelCoverage.has) {
      return [
        note("No coverage yet: Run with Coverage (Testing view) to see what no test ran.", {
          command: "testing.coverageAll",
          title: "Run with Coverage",
        }),
      ];
    }
    const client = this.hub.getClient();
    const uris = new Set<string>();
    for (const n of model.nodes) for (const h of n.uses ?? []) uris.add(h.member.loc.uri);
    for (const n of model.nodes) for (const a of n.agents) uris.add(a.loc.uri);
    const coverage: Record<string, ModelCoverage | undefined> = {};
    for (const uri of uris) coverage[uri] = await modelCoverage.forUri(uri);

    const sites: HandlerSite[] = [];
    for (const n of model.nodes) {
      for (const h of n.uses ?? []) {
        const range = coverage[h.member.loc.uri] ? await this.declarationRange(h.member.loc.uri, h.member.loc.range.start) : null;
        const protocol = n.services.find((s) => s.name === h.member.container)?.protocol;
        sites.push({ member: h.member, range, protocol });
      }
    }
    const agents: Array<{ unit: string; agent: string; uri: string; model: AgentStateModel }> = [];
    if (client) {
      for (const n of model.nodes) {
        for (const a of n.agents) {
          if (!coverage[a.loc.uri]) continue;
          const m = await agentState(client, a.loc.uri, a.loc.range.start);
          if (m) agents.push({ unit: n.name, agent: a.name, uri: a.loc.uri, model: m });
        }
      }
    }
    const a = untestedQuery(sites, coverage, agents);
    const stale = Object.values(coverage).some((c) => c?.stale);
    return this.untestedNodes(a, stale);
  }

  private untestedNodes(a: UntestedAnswer, stale: boolean): Node[] {
    const out: Node[] = [
      note("Line coverage of the whole run: untested means no line ran, not that no test targeted it."),
    ];
    if (stale) out.push(note("The source has changed since the last coverage run, so this may be out of date."));
    const section = (label: string, list: Row[], measured: number): Node =>
      group(label, list.length > 0 ? rows(list) : [note(measured === 0 ? "Nothing measured." : "All of them ran.")], `${list.length} of ${measured}`, list.length > 0);
    out.push(
      section("Routes (from http)", a.routes, a.measured.routes),
      section("Handlers", a.handlers, a.measured.handlers),
      section("Agent transitions", a.transitions, a.measured.transitions),
    );
    if (a.partial.length > 0) out.push(group("Partly tested", rows(a.partial), `${a.partial.length}`));
    return out;
  }

  /** The whole declaration of the handler whose name is at `pos` (the model's
   *  own location is the name only), from the document's symbols. */
  private async declarationRange(uri: string, pos: { line: number; character: number }): Promise<HandlerSite["range"]> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const found = enclosingHandler(await this.hub.documentSymbols(doc), pos);
      return found ? found.symbol.range : null;
    } catch {
      return null;
    }
  }

  private async model(): Promise<ArchModel | null> {
    const client = this.hub.getClient();
    if (!client) return null;
    const root = await activeProjectRoot();
    const file = root ? await projectFile(root) : undefined;
    if (!file) return null;
    return requestArchitectureModel(client, this.hub, file);
  }

  /** Test seam: one query's answer as indented lines of text. */
  async snapshot(id: QueryId): Promise<string[]> {
    const out: string[] = [];
    const walk = async (nodes: Node[], depth: number): Promise<void> => {
      for (const n of nodes) {
        const item = this.getTreeItem(n);
        out.push(`${"  ".repeat(depth)}${String(item.label)}${item.description ? ` — ${String(item.description)}` : ""}`);
        if (n.type === "group") await walk(n.children, depth + 1);
      }
    };
    await walk(await this.answer(id), 0);
    return out;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** A `.bynk` file of the project, to resolve it by: the active one when it is
 *  in the project, else the first the workspace finds. */
async function projectFile(root: vscode.Uri): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document;
  if (active?.languageId === "bynk" && active.uri.toString().startsWith(root.toString())) return active.uri.toString();
  const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*.bynk"), "**/node_modules/**", 1);
  return found[0]?.toString();
}

async function agentState(
  client: LanguageClient,
  uri: string,
  position: { line: number; character: number },
): Promise<AgentStateModel | null> {
  try {
    return await client.sendRequest<AgentStateModel | null>("bynk/agentStateModel", { textDocument: { uri }, position });
  } catch {
    return null;
  }
}

export function registerQueryView(context: vscode.ExtensionContext, hub: ViewRefresh): QueryTreeProvider {
  const provider = new QueryTreeProvider(hub);
  const view = vscode.window.createTreeView("bynk.query", { treeDataProvider: provider, showCollapseAll: true });
  context.subscriptions.push(
    provider,
    view,
    hub.onDidRefresh(() => provider.refresh()),
    hub.onDidStartClient(() => provider.refresh()),
    modelCoverage.onDidChange(() => provider.refresh()),
    vscode.commands.registerCommand("bynk.query.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("bynk.query.pickCapability", () => provider.pickCapability()),
    // Test seam (not contributed): a query's answer as text.
    vscode.commands.registerCommand("bynk._queryAnswer", (id: QueryId) => provider.snapshot(id)),
    vscode.commands.registerCommand("bynk.showQuery", () => vscode.commands.executeCommand("bynk.query.focus")),
    vscode.commands.registerCommand("bynk.query.open", (uri?: unknown, range?: unknown) => {
      if (typeof uri !== "string" || !isRange(range)) return;
      return revealLocation(uri, range);
    }),
  );
  return provider;
}

function isRange(v: unknown): v is { start: { line: number; character: number }; end: { line: number; character: number } } {
  const pos = (p: unknown): boolean =>
    typeof p === "object" && p !== null && Number.isInteger((p as { line?: unknown }).line) && Number.isInteger((p as { character?: unknown }).character);
  return typeof v === "object" && v !== null && pos((v as { start?: unknown }).start) && pos((v as { end?: unknown }).end);
}
