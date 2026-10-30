// #2093 (DECISION D): an opt-in handler CodeLens, behind `bynk.viewsCodeLens`
// (off by default: handlers already carry the server's lenses). The proposal
// asks for `Sequence | Wire contract`; the server already puts a
// `Show Sequence` lens above every handler (#846, `bynk-lsp/src/lib.rs`
// `code_lens`), so this adds the missing half, a `Wire contract` lens beside
// it, rather than a second sequence lens. Client-side, like `testCodeLens.ts`;
// anchors come from the server's document symbols, where a handler is a
// `Method` child of its service/agent `Class`.
//
// #67: the provider is shared by handler lenses: the Send Request lens
// (`sendRequest.ts`) is one more, on HTTP handlers only.

import * as vscode from "vscode";

import { handlerSymbols, type HandlerSymbol } from "./refreshScheduler";
import type { ViewRefresh } from "./viewRefresh";

/** One CodeLens above each handler the filter keeps, behind a setting. */
export interface HandlerLensSpec {
  /** The `bynk.` setting that turns the lens on, and its default. */
  setting: string;
  enabledByDefault: boolean;
  title: string;
  tooltip: string;
  /** Run with `(uri, position)` of the handler's name. */
  command: string;
  filter?(document: vscode.TextDocument, handler: HandlerSymbol): boolean;
}

class HandlerCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly hub: ViewRefresh,
    private readonly spec: HandlerLensSpec,
  ) {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`bynk.${spec.setting}`)) this.emitter.fire();
    });
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const { spec } = this;
    if (!vscode.workspace.getConfiguration("bynk").get<boolean>(spec.setting, spec.enabledByDefault)) return [];
    const uri = document.uri.toString();
    return handlerSymbols(await this.hub.documentSymbols(document))
      .filter((h) => !spec.filter || spec.filter(document, h))
      .map((h) => {
        const start = h.symbol.selectionRange.start;
        const range = new vscode.Range(start.line, start.character, start.line, start.character);
        return new vscode.CodeLens(range, {
          title: spec.title,
          tooltip: spec.tooltip,
          command: spec.command,
          arguments: [uri, { line: start.line, character: start.character }],
        });
      });
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

export function registerHandlerLens(context: vscode.ExtensionContext, hub: ViewRefresh, spec: HandlerLensSpec): void {
  const provider = new HandlerCodeLensProvider(hub, spec);
  context.subscriptions.push(
    provider,
    vscode.languages.registerCodeLensProvider({ language: "bynk" }, provider),
  );
}

export function registerViewsCodeLens(context: vscode.ExtensionContext, hub: ViewRefresh): void {
  registerHandlerLens(context, hub, {
    setting: "viewsCodeLens",
    enabledByDefault: false,
    title: "Wire contract",
    tooltip: "Show this handler's wire contract",
    command: "bynk.showWireContract",
  });
}
