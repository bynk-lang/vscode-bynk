// #2480: "Copy Playground Link" and "Open in Playground". Both use only the VS
// Code API, so the desktop and web entries register them alike (the encoding is
// in `playgroundLink.ts`).
//
// What is shared (DECISION B): the selection, when there is one; otherwise the
// whole file, but only for a single-file program. A file inside a `bynk.toml`
// project depends on its sibling units, so sharing it whole would not open in
// the playground; there the command asks for a selection instead, and warns
// when the selection leaves out `uses` clauses the file has.

import * as vscode from "vscode";

import { missingUses, playgroundLink } from "./playgroundLink";
import { projectRootFor } from "./projectRoots";

/** The link for the active editor, or `undefined` after telling the user why not. */
async function linkForActiveEditor(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "bynk") {
    void vscode.window.showInformationMessage("Open a Bynk file to share it in the playground.");
    return undefined;
  }
  const { document, selection } = editor;
  const selected = document.getText(selection);
  let source: string;
  if (selected.trim() !== "") {
    source = selected;
    const missing = missingUses(document.getText(), selected);
    if (missing.length > 0) {
      void vscode.window.showWarningMessage(
        `This file uses ${missing.join(", ")}, which the selection does not include. Names from ` +
          "other files will not resolve in the playground.",
      );
    }
  } else if ((await projectRootFor(document.uri)) !== undefined) {
    void vscode.window.showInformationMessage(
      "This file is part of a project, so it depends on other files. Select the code to share.",
    );
    return undefined;
  } else {
    source = document.getText();
  }
  const link = await playgroundLink(source);
  if (!link.ok) {
    void vscode.window.showWarningMessage(
      `That snippet is too large for a playground link (${link.length} of ${link.max} characters ` +
        "once compressed). Select less code.",
    );
    return undefined;
  }
  return link.url;
}

export function registerPlaygroundCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("bynk.copyPlaygroundLink", async () => {
      const url = await linkForActiveEditor();
      if (!url) return;
      await vscode.env.clipboard.writeText(url);
      void vscode.window.showInformationMessage("Playground link copied.");
    }),
    vscode.commands.registerCommand("bynk.openInPlayground", async () => {
      const url = await linkForActiveEditor();
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url, true));
    }),
  );
}
