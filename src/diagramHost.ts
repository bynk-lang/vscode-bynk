// The host side every diagram panel shares (model-diagrams slices 2–4): the
// page's "Copy as Mermaid", the editor mark for the element the reader points
// at, "Save as SVG/PNG", and errors the page could not handle. Each message
// is checked (`sequenceMessages.ts`) before the host acts on it: the page is
// untrusted.

import * as vscode from "vscode";

import {
  fileStem,
  isCopyText,
  isHighlight,
  isPageError,
  isSaveFile,
  type HighlightMessage,
  type SaveFileMessage,
} from "./sequenceMessages";

export interface DiagramMessages {
  /** Handle a shared message; `false` when it is not one (the panel's own). */
  handle(message: unknown): boolean;
  /** The panel closed: clear the editor mark. */
  dispose(): void;
}

/** The shared handlers for a panel showing "the <what>" (`sequence diagram`,
 *  `architecture map`), for its status messages. */
export function diagramMessages(context: vscode.ExtensionContext, what: string): DiagramMessages {
  const highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    borderColor: new vscode.ThemeColor("editor.findMatchHighlightBorder"),
    borderStyle: "solid",
    borderWidth: "1px",
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  context.subscriptions.push(highlight);
  return {
    handle(message) {
      if (isCopyText(message)) {
        void vscode.env.clipboard.writeText(message.text).then(() =>
          vscode.window.setStatusBarMessage(`Bynk: copied the ${what} as Mermaid.`, 3000),
        );
      } else if (isHighlight(message)) {
        showHighlight(highlight, message);
      } else if (isSaveFile(message)) {
        void saveFile(message, what);
      } else if (isPageError(message)) {
        void vscode.window.showErrorMessage(`Bynk: ${message.message}`);
      } else {
        return false;
      }
      return true;
    },
    dispose() {
      for (const e of vscode.window.visibleTextEditors) e.setDecorations(highlight, []);
    },
  };
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
async function saveFile(message: SaveFileMessage, what: string): Promise<void> {
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
    vscode.window.setStatusBarMessage(`Bynk: saved the ${what} to ${vscode.workspace.asRelativePath(target)}.`, 4000);
  } catch (err) {
    void vscode.window.showErrorMessage(`Bynk: could not save the diagram: ${String(err)}`);
  }
}
