// #2471: "Bynk: Show Compiled Output" — the TypeScript the compiler emits for
// the current file, read-only, beside it.
//
// The output comes from the CLI (DECISION A, as the maintainer settled it): the
// project is compiled to a scratch directory with `bynk compile --sources-stdin`,
// fed the project's unsaved buffers, so what is shown is what is on screen and
// the language server (which keeps no typed program and links no emitter) is not
// involved. The view is a `bynk-emitted:` virtual document served by a
// `TextDocumentContentProvider`. It is rebuilt when opened, on edits (debounced),
// on save and on external changes, only while the view is open, and dropped when
// its document closes. Each rebuild is a full compile of the project in a fresh
// process. Moving the cursor in either editor highlights the matching lines in the
// other, through the emitter's line-level source map (DECISION B: a highlight,
// not locked scrolling); the lookups are in `emittedMap.ts`.

import * as vscode from "vscode";

import { dirtyBuffers } from "./dirtyBuffers";
import { buildModules, buildProjectModules } from "./emittedBuild";
import {
  generatedRangeForSource,
  sourceRangeForGenerated,
  type EmittedFile,
  type LineRange,
} from "./emittedMap";
import { projectRootFor } from "./projectRoots";
import { groupByRoot } from "./refreshScope";
import type { ViewRefresh } from "./viewRefresh";

export const EMITTED_SCHEME = "bynk-emitted";
export const SHOW_COMPILED_OUTPUT = "bynk.showCompiledOutput";

/** How long to wait after the last edit before rebuilding. */
export const EDIT_DEBOUNCE_MS = 500;

interface View {
  /** The `.bynk` document the output is for. */
  source: vscode.Uri;
  file: EmittedFile;
  /** The source has been edited since `file` was built, so its lines no longer
   *  line up with the map: no highlighting until the rebuild lands. */
  stale: boolean;
}

/** The project directory of `file` (see `projectRootFor`), as a path. */
export async function projectRootOf(file: vscode.Uri): Promise<string | undefined> {
  return (await projectRootFor(file))?.fsPath;
}

/** The virtual document for `file` of `source`. The query carries the source,
 *  so two files that emit the same output path don't share a document. */
export function emittedUri(source: vscode.Uri, outputPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: EMITTED_SCHEME,
    path: `/${outputPath}`,
    query: encodeURIComponent(source.toString()),
  });
}

export function registerEmittedOutput(
  context: vscode.ExtensionContext,
  hub: ViewRefresh,
): void {
  const views = new Map<string, View>();
  const changed = new vscode.EventEmitter<vscode.Uri>();
  const highlight = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  /** Builds in flight, each with its own token: `view:<source>` for a view
   *  opening, `root:<project>` for a refresh, so one view's build never cancels
   *  another's (only a newer build of the same thing does). */
  const building = new Map<string, vscode.CancellationTokenSource>();
  async function withToken<T>(
    key: string,
    run: (token: vscode.CancellationToken) => Promise<T>,
  ): Promise<T> {
    building.get(key)?.cancel();
    const mine = new vscode.CancellationTokenSource();
    building.set(key, mine);
    try {
      return await run(mine.token);
    } finally {
      if (building.get(key) === mine) building.delete(key);
      mine.dispose();
    }
  }

  /** Build the modules for `source` from the project on disk plus its
   *  unsaved buffers, or say why not. */
  async function build(source: vscode.Uri): Promise<EmittedFile[] | string> {
    const root = await projectRootOf(source);
    if (!root) return "the file is not in a Bynk project (no bynk.toml above it)";
    const result = await withToken(`view:${source.toString()}`, (token) =>
      buildModules(root, source.fsPath, dirtyBuffers(root), token),
    );
    return result.ok ? result.files : result.message;
  }

  const provider: vscode.TextDocumentContentProvider = {
    onDidChange: changed.event,
    provideTextDocumentContent: (uri) => views.get(uri.toString())?.file.text ?? "",
  };

  function toRange(r: LineRange, doc: vscode.TextDocument): vscode.Range {
    const end = Math.min(r.end, doc.lineCount - 1);
    return new vscode.Range(r.start, 0, end, doc.lineAt(end).text.length);
  }

  function editorsFor(uri: vscode.Uri): vscode.TextEditor[] {
    const key = uri.toString();
    return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key);
  }

  function clearHighlights(generated: vscode.Uri, view: View): void {
    for (const e of [...editorsFor(generated), ...editorsFor(view.source)]) {
      e.setDecorations(highlight, []);
    }
  }

  /** Highlight what `editor`'s cursor is on in the other side of each view. */
  function syncFrom(editor: vscode.TextEditor): void {
    const line = editor.selection.active.line;
    const key = editor.document.uri.toString();
    for (const [generatedKey, view] of views) {
      if (view.stale) continue;
      const generated = vscode.Uri.parse(generatedKey);
      if (key === generatedKey) {
        for (const target of editorsFor(view.source)) {
          const range = sourceRangeForGenerated(
            view.file,
            line,
            (l) => l < target.document.lineCount && target.document.lineAt(l).isEmptyOrWhitespace,
          );
          if (!range) {
            target.setDecorations(highlight, []);
            continue;
          }
          const r = toRange(range, target.document);
          target.setDecorations(highlight, [r]);
          target.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      } else if (key === view.source.toString()) {
        const range = generatedRangeForSource(view.file, line);
        for (const target of editorsFor(generated)) {
          if (!range) {
            target.setDecorations(highlight, []);
            continue;
          }
          const r = toRange(range, target.document);
          target.setDecorations(highlight, [r]);
          target.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      }
    }
  }

  /** Resolves to the virtual document it opened (what the integration suite
   *  reads), or `undefined` when there was nothing to show. */
  async function show(arg?: unknown): Promise<string | undefined> {
    const source =
      arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!source || !source.path.endsWith(".bynk")) {
      void vscode.window.showErrorMessage("Bynk: Show Compiled Output needs a .bynk file open.");
      return undefined;
    }
    const built = await build(source);
    if (typeof built === "string") {
      void vscode.window.showWarningMessage(`Bynk: no compiled output — ${built}`);
      return undefined;
    }
    const files = built;
    if (files.length === 0) {
      void vscode.window.showInformationMessage("Bynk: this file emits no TypeScript module.");
      return undefined;
    }
    let file = files[0];
    if (files.length > 1) {
      const pick = await vscode.window.showQuickPick(
        files.map((f) => ({ label: f.path, file: f })),
        { placeHolder: "This file compiles to several modules — which one?" },
      );
      if (!pick) return undefined;
      file = pick.file;
    }
    const uri = emittedUri(source, file.path);
    views.set(uri.toString(), { source, file, stale: false });
    changed.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
    const active = vscode.window.activeTextEditor;
    if (active) syncFrom(active);
    return uri.toString();
  }

  /** Rebuild the open views of `roots` (every view when `undefined`), one
   *  compile per project however many views it has. A project that stops
   *  compiling keeps the last good output on screen (and stays stale: its lines
   *  no longer line up). */
  async function refresh(roots: ReadonlySet<string> | undefined): Promise<void> {
    const located = await Promise.all(
      [...views].map(async ([key, v]) => ({ key, source: v.source.fsPath, root: await projectRootOf(v.source) })),
    );
    const byRoot = groupByRoot(located);
    await Promise.all(
      [...byRoot].map(async ([root, members]) => {
        if (roots && !roots.has(root)) return;
        const sources = [...new Set(members.map((m) => m.source))];
        const results = await withToken(`root:${root}`, (token) =>
          buildProjectModules(root, sources, dirtyBuffers(root), token),
        );
        for (const { key, source } of members) {
          const view = views.get(key);
          const built = results.get(source);
          if (!view || !built?.ok) continue;
          const file = built.files.find((f) => f.path === view.file.path);
          if (!file) continue;
          views.set(key, { source: view.source, file, stale: false });
          changed.fire(vscode.Uri.parse(key));
        }
      }),
    );
    const active = vscode.window.activeTextEditor;
    if (active) syncFrom(active);
  }

  /** The projects touched since the last rebuild; `undefined` once something
   *  of unknown project changed (then every view rebuilds). */
  let dirty: Set<string> | undefined = new Set();
  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = async (uris: Iterable<string>): Promise<void> => {
    if (views.size === 0) return;
    for (const u of uris) {
      const parsed = vscode.Uri.parse(u);
      const root = parsed.scheme === "file" ? await projectRootOf(parsed) : undefined;
      if (root) dirty?.add(root);
      else dirty = undefined;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const roots = dirty;
      dirty = new Set();
      void refresh(roots);
    }, EDIT_DEBOUNCE_MS);
  };

  context.subscriptions.push(
    highlight,
    changed,
    vscode.workspace.registerTextDocumentContentProvider(EMITTED_SCHEME, provider),
    vscode.commands.registerCommand(SHOW_COMPILED_OUTPUT, show),
    vscode.window.onDidChangeTextEditorSelection((e) => syncFrom(e.textEditor)),
    // An edit to a source file moves the lines its view maps from, so the
    // view stops highlighting until the debounced rebuild lands.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== "bynk" || e.contentChanges.length === 0) return;
      const key = e.document.uri.toString();
      for (const [generatedKey, view] of views) {
        if (view.source.toString() === key) {
          views.set(generatedKey, { ...view, stale: true });
          clearHighlights(vscode.Uri.parse(generatedKey), view);
        }
      }
      void scheduleRefresh([key]);
    }),
    // Saves and changes made outside the editor (a git checkout, codegen).
    hub.onDidRefresh((keys) => void scheduleRefresh(keys)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme !== EMITTED_SCHEME) return;
      const key = doc.uri.toString();
      const view = views.get(key);
      if (view) clearHighlights(doc.uri, view);
      views.delete(key);
    }),
    { dispose: () => { clearTimeout(timer); for (const b of building.values()) b.cancel(); } },
  );
}
