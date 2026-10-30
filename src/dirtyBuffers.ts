import * as vscode from "vscode";

import { isInside } from "./pathInside";

/** The unsaved `.bynk` buffers under `root`, except `skip`: absolute path -> text. */
export function dirtyBuffers(root: string, skip?: string): Record<string, string> {
  const buffers: Record<string, string> = {};
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId !== "bynk" || !doc.isDirty || doc.uri.scheme !== "file") continue;
    if (doc.uri.fsPath === skip || !isInside(root, doc.uri.fsPath)) continue;
    buffers[doc.uri.fsPath] = doc.getText();
  }
  return buffers;
}
