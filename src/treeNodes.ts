// The result nodes the Query (#148) and Impact (#146) tree views share: a
// group with children, a row that opens a source location, and a note (which
// may run a command). `vscode`-dependent, so not a `*Core.ts`; the answers they
// show are `queryCore.ts`'s and `impactCore.ts`'s.

import * as vscode from "vscode";

import type { Row } from "./queryCore";

export type ResultNode =
  | { type: "group"; label: string; description?: string; children: ResultNode[]; open?: boolean }
  | { type: "row"; row: Row }
  | { type: "note"; text: string; command?: vscode.Command };

export const note = (text: string, command?: vscode.Command): ResultNode => ({ type: "note", text, command });
export const rows = (list: readonly Row[]): ResultNode[] => list.map((row) => ({ type: "row", row }));
export const group = (label: string, children: ResultNode[], description?: string, open = false): ResultNode => ({
  type: "group",
  label,
  description,
  children,
  open,
});

/** The tree item for a result node; a row opens its source through `bynk.query.open`. */
export function resultItem(node: ResultNode): vscode.TreeItem {
  switch (node.type) {
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

/** A tree's nodes as indented text, for the integration tests' seam. */
export async function nodesAsText(
  nodes: readonly ResultNode[],
  item: (n: ResultNode) => vscode.TreeItem = resultItem,
  depth = 0,
  out: string[] = [],
): Promise<string[]> {
  for (const n of nodes) {
    const it = item(n);
    out.push(`${"  ".repeat(depth)}${String(it.label)}${it.description ? ` — ${String(it.description)}` : ""}`);
    if (n.type === "group") await nodesAsText(n.children, item, depth + 1, out);
  }
  return out;
}
