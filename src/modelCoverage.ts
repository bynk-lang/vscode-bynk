// #144: the last coverage run, kept for the model views (the agent state view
// and the sequence diagram). `testRun.ts` records each run's per-file line
// coverage; a view asks for the coverage of the file its model is in and embeds
// it in its payload. The projection onto transitions and branches is
// `modelCoverageCore.ts`.
//
// Whole-run and line-level (ADR 0514): see the core's header. The overlay is
// cleared by **Bynk: Clear Model Coverage**, and replaced by the next run.

import * as fs from "node:fs/promises";
import * as vscode from "vscode";

import { type CoverageRun, type ModelCoverage, mergeRun, modelCoverageFor } from "./modelCoverageCore";

export class ModelCoverageStore implements vscode.Disposable {
  private run: CoverageRun | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  /** The test run whose projects are being merged into `run`. */
  private owner: object | undefined;

  /** Record one project's part of a coverage run. A Run All with Coverage
   *  reports each project in turn under the same `owner` (the `TestRun`), and
   *  their files are merged, so no project's coverage is dropped; the next run
   *  replaces the last. `runAt` is when the earliest part started, so a file
   *  saved while any part was running reads as changed since. */
  record(owner: object, part: CoverageRun): void {
    this.run = mergeRun(this.run, this.owner === owner, part);
    this.owner = owner;
    this.emitter.fire();
  }

  clear(): void {
    if (!this.run) return;
    this.run = undefined;
    this.owner = undefined;
    this.emitter.fire();
  }

  get has(): boolean {
    return this.run !== undefined;
  }

  /** Test seam: the run's files and what it measured. */
  snapshot(): { files: string[]; scope: string } | undefined {
    return this.run ? { files: this.run.files.map((f) => f.file), scope: this.run.scope } : undefined;
  }

  /** The run's coverage of the file at `uri`, or `undefined` when there is no
   *  run or its report does not list the file. `stale` when the document has
   *  unsaved edits or the file changed after the run. */
  async forUri(uri: string): Promise<ModelCoverage | undefined> {
    const run = this.run;
    if (!run) return undefined;
    let target: vscode.Uri;
    try {
      target = vscode.Uri.parse(uri);
    } catch {
      return undefined;
    }
    if (target.scheme !== "file") return undefined;
    let stale = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri && d.isDirty);
    if (!stale) {
      try {
        stale = (await fs.stat(target.fsPath)).mtimeMs > run.runAt;
      } catch {
        stale = true;
      }
    }
    return modelCoverageFor(run.files, target.fsPath, { runAt: run.runAt, scope: run.scope, stale });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** The extension's one store: the test run writes it, the views read it. */
export const modelCoverage = new ModelCoverageStore();

/** **Bynk: Clear Model Coverage**: hide the overlay on the model views. */
export function registerModelCoverage(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    modelCoverage,
    // Test seam (not contributed): what the views would overlay.
    vscode.commands.registerCommand("bynk._modelCoverage", () => modelCoverage.snapshot()),
    vscode.commands.registerCommand("bynk.clearModelCoverage", () => {
      if (!modelCoverage.has) {
        void vscode.window.showInformationMessage("Bynk: there is no coverage on the model views.");
        return;
      }
      modelCoverage.clear();
    }),
  );
}
