// The "Run against…" target quick pick. Split out of `testing.ts`.

import * as vscode from "vscode";

import { DEV_TARGET, scanTargets, targetChoices, targetDetail } from "./testTargets";

/** The key under which a workspace remembers the last target it ran against. */
export const LAST_TARGET_KEY = "bynk.test.lastTarget";

/** The target names the manifest declares. A missing or unreadable manifest has
 *  none, which leaves `dev` and a typed name. */
export async function manifestTargets(root: vscode.Uri): Promise<string[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, "bynk.toml"));
    return scanTargets(Buffer.from(bytes).toString("utf8"));
  } catch {
    return [];
  }
}

/** Ask which target to run against: `dev`, the targets any requested project's
 *  manifest declares (the last choice first), or a name typed by hand. Also
 *  returns the projects that declare the chosen target, which are the ones to run:
 *  all of them for `dev` or a name typed by hand that none declares. Remembers the choice per workspace.
 *  A bare URL is refused here with a message, since the driver would refuse it
 *  and a target name is all the extension ever passes. */
export async function pickTarget(
  context: vscode.ExtensionContext,
  roots: vscode.Uri[],
): Promise<{ target: string; declaring: vscode.Uri[] } | undefined> {
  if (roots.length === 0) {
    void vscode.window.showErrorMessage("Bynk: no bynk.toml found in the workspace.");
    return undefined;
  }
  const last = context.workspaceState.get<string>(LAST_TARGET_KEY);
  const MANUAL = "Enter a target name…";
  const declared = await Promise.all(roots.map(async (root) => ({ root, targets: await manifestTargets(root) })));
  const choices = targetChoices([...new Set(declared.flatMap((d) => d.targets))], last);
  const picked = await vscode.window.showQuickPick(
    [
      ...choices.map((name) => ({
        label: name,
        description: name === last ? "last used" : undefined,
        detail: targetDetail(name),
      })),
      { label: MANUAL, detail: "A target declared in a form the list does not show." },
    ],
    { title: "Run the system tests against…", placeHolder: "Choose a target" },
  );
  if (!picked) return undefined;
  let target = picked.label;
  if (target === MANUAL) {
    const typed = await vscode.window.showInputBox({
      title: "Run the system tests against…",
      prompt: "A target name from [test.targets] in bynk.toml, or dev",
      validateInput: (v) =>
        /:\/\//.test(v)
          ? "Enter a target name, not a URL: the driver runs only against a named target."
          : /^[A-Za-z0-9_-]+$/.test(v.trim())
            ? undefined
            : "Enter a target name: letters, digits, `-` and `_`.",
    });
    if (!typed) return undefined;
    target = typed.trim();
  }
  await context.workspaceState.update(LAST_TARGET_KEY, target);
  const declaring = declared.filter((d) => d.targets.includes(target)).map((d) => d.root);
  return { target, declaring: target === DEV_TARGET || declaring.length === 0 ? roots : declaring };
}
