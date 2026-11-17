// #151: the `.bynknb` file as a VS Code notebook. It has no Node dependency, so
// the web extension registers it too: a notebook opens, reads and edits on
// vscode.dev, but cannot run there (running needs the `bynk` CLI, which only
// the desktop extension has, so no kernel is offered).

import * as vscode from "vscode";

import { NOTEBOOK_TYPE, parseNotebook, serializeNotebook } from "./notebookCore";

export class BynkNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const parsed = parseNotebook(new TextDecoder().decode(content));
    if ("error" in parsed) {
      // Show the reason in the notebook, rather than an editor that won't open.
      const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, `**This file is not a Bynk notebook.** ${parsed.error}`, "markdown")]);
      data.metadata = { invalid: true, raw: new TextDecoder().decode(content) };
      return data;
    }
    const data = new vscode.NotebookData(
      parsed.notebook.cells.map((c) => (c.kind === "markdown" ? new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, c.source, "markdown") : new vscode.NotebookCellData(vscode.NotebookCellKind.Code, c.source, "bynk"))),
    );
    if (parsed.notebook.unit) data.metadata = { unit: parsed.notebook.unit };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    // A file that was not a notebook is written back as it was read, never as
    // the explanation shown in its place.
    if (data.metadata?.invalid && typeof data.metadata.raw === "string") return new TextEncoder().encode(data.metadata.raw);
    const unit = typeof data.metadata?.unit === "string" ? data.metadata.unit : undefined;
    const cells = data.cells.map((c) => ({ kind: c.kind === vscode.NotebookCellKind.Markup ? ("markdown" as const) : ("code" as const), source: c.value }));
    return new TextEncoder().encode(serializeNotebook({ unit, cells }));
  }
}

/** Register the serializer for `bynk-notebook`. Outputs are never saved. */
export function registerNotebookSerializer(): vscode.Disposable {
  return vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new BynkNotebookSerializer(), { transientOutputs: true });
}
