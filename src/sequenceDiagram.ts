// #846: "Bynk: Show Sequence Diagram" — the extension's first webview panel.
//
// Issues the `bynk/sequenceModel` custom LSP request (this server's first
// non-standard request — see `bynk-lsp/src/sequence_request.rs`) for the
// handler at the invoking CodeLens/command position, renders the result as
// a UML sequence diagram (the first-party engine in `src/diagram/`,
// model-diagrams slice 1), and handles click-to-code: the webview posts
// plain JSON `{uri, range}` (never real VS Code instances — a webview has
// no access to the `vscode` module), hydrated here into a real
// `vscode.Uri`/`Range` and revealed — the same hydration posture
// `codelens.ts` uses for `editor.action.showReferences`, just travelling
// the opposite direction (webview -> host, not server -> client).

// #2093: the panel is now a `LivePanel`: it refreshes on edits, follows the
// cursor from handler to handler (unless pinned), and survives a reload.

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import { commandTarget, LivePanel, type ViewTarget } from "./livePanel";
import { fileStem, isCopyText, isHighlight, isOpenSequence, isPageError, isSaveFile, type HighlightMessage, type SaveFileMessage } from "./sequenceMessages";
import type { ViewRefresh } from "./viewRefresh";
import { revealLocation } from "./webviewHost";
import type { SequenceModel, SequencePayload } from "./webview/types";

interface SequenceModelParams {
  textDocument: { uri: string };
  position: { line: number; character: number };
}

export function registerSequenceDiagram(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
): LivePanel<SequencePayload> {
  // Slice 2: the source of the element the reader is pointing at in the
  // diagram, marked in the editor.
  const highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    borderColor: new vscode.ThemeColor("editor.findMatchHighlightBorder"),
    borderStyle: "solid",
    borderWidth: "1px",
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  context.subscriptions.push(highlight);
  const clearHighlight = (): void => {
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(highlight, []);
  };

  const view = new LivePanel<SequencePayload>(context, {
    viewType: "bynkSequenceDiagram",
    commandLabel: "Show Sequence Diagram",
    script: "webview.js",
    globalName: "__BYNK_SEQUENCE_MODEL__",
    followsCursor: true,
    reportsCursor: true,
    title: () => "Bynk Sequence Diagram",
    request: requestSequence,
    onMessage: (message) => {
      if (isCopyText(message)) {
        void vscode.env.clipboard.writeText(message.text).then(() =>
          vscode.window.setStatusBarMessage("Bynk: copied the sequence diagram as Mermaid.", 3000),
        );
      } else if (isHighlight(message)) {
        showHighlight(highlight, message);
      } else if (isSaveFile(message)) {
        void saveFile(message);
      } else if (isOpenSequence(message)) {
        // A `ref` link: show the callee's handler in the editor (so a
        // cursor-following view agrees), then its diagram (so a pinned one
        // moves too).
        void revealLocation(message.uri, message.range).then(() =>
          view.show({ uri: message.uri, position: message.range.start }),
        );
      } else if (isPageError(message)) {
        void vscode.window.showErrorMessage(`Bynk: ${message.message}`);
      }
    },
    onDispose: clearHighlight,
    missMessage: "Bynk: no handler found at the cursor.",
  }, hub);
  context.subscriptions.push(
    view,
    vscode.commands.registerCommand(
      "bynk.showSequenceDiagram",
      (uriArg?: unknown, positionArg?: unknown) => {
        const target = commandTarget(uriArg, positionArg, true);
        if (!target) {
          void vscode.window.showErrorMessage(
            "Bynk: Show Sequence Diagram needs a .bynk file open (or a Show Sequence lens).",
          );
          return;
        }
        return view.show(target);
      },
    ),
  );
  return view;
}

/** Mark `message.range` in the visible editors showing its file (and clear
 *  the mark everywhere else, or everywhere when the range is `null`). */
function showHighlight(type: vscode.TextEditorDecorationType, message: HighlightMessage): void {
  for (const editor of vscode.window.visibleTextEditors) {
    const here = message.range && editor.document.uri.toString() === message.uri;
    if (!here || !message.range) {
      editor.setDecorations(type, []);
      continue;
    }
    const r = message.range;
    editor.setDecorations(type, [new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character)]);
  }
}

/** Ask where to save the page's SVG or PNG, then write it. */
async function saveFile(message: SaveFileMessage): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const name = `${fileStem(message.name)}.${message.format}`;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
    filters: message.format === "svg" ? { "SVG image": ["svg"] } : { "PNG image": ["png"] },
    saveLabel: "Save Diagram",
  });
  if (!target) return;
  const bytes =
    message.format === "svg" ? new TextEncoder().encode(message.data) : Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0));
  try {
    await vscode.workspace.fs.writeFile(target, bytes);
    vscode.window.setStatusBarMessage(`Bynk: saved the sequence diagram to ${vscode.workspace.asRelativePath(target)}.`, 4000);
  } catch (err) {
    void vscode.window.showErrorMessage(`Bynk: could not save the diagram: ${String(err)}`);
  }
}

async function requestSequence(
  client: LanguageClient,
  target: ViewTarget,
): Promise<SequencePayload | null> {
  if (!target.position) return null;
  const params: SequenceModelParams = {
    textDocument: { uri: target.uri },
    position: target.position,
  };
  const model = await client.sendRequest<SequenceModel | null>("bynk/sequenceModel", params);
  return model ? { model, uri: target.uri } : null;
}
