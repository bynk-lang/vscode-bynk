// #2478: Explorer file decorations — a short badge naming each `.bynk` file's
// owning context, a red tint on files whose tests failed in the last run, and
// (#2519) a warning tint on files with a contract break. Each is switched by a
// setting (`bynk.fileDecorations.*`).
//
// Desktop only: the tint reads the Test Explorer's results, which the web
// entry does not have, and the web entry does not register this provider.
//
// A contract break is read from the diagnostics the language server already
// publishes (`bynk.event.non_additive_schema_change`,
// `bynk.agent.non_additive_state_change`, see `CONTRACT_BREAK_CODES`), so it
// follows the editor's own state and clears when the lock is updated or the
// change is undone. A decoration has no command, so the tooltip names
// **Bynk: Show Contract Diff** rather than linking to it.
//
// The owning context comes from the same header scan the project sidebar
// (#2097) uses (`parseUnitHeader`), kept per file and updated from a file
// watcher; it needs no language-server round trip, so the badges are there
// before the server is.

import * as vscode from "vscode";

import {
  type BadgeMode,
  type ScannedFile,
  CONTRACT_DIFF_TITLE,
  contextBadge,
  hasContractBreak,
  testFailures,
} from "./fileDecorationsCore";
import { parseUnitHeader } from "./projectModel";
import { clearProjectRoots, projectRootFor } from "./projectRoots";
import { mapLimit } from "./refreshScope";

const SECTION = "bynk.fileDecorations";

/** Files read at once by a scan: bounded, so a large workspace does not open them all together. */
const SCAN_CONCURRENCY = 32;

const decoder = new TextDecoder();

async function readText(uri: vscode.Uri): Promise<string> {
  return decoder.decode(await vscode.workspace.fs.readFile(uri));
}

export class FileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;

  private readonly files = new Map<string, ScannedFile>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  /** Files read on demand because the Explorer asked about them before any scan
   *  or watcher event had reported them; cleared by a full scan. */
  private readonly probed = new Set<string>();
  /** One set per scan running: the files a watcher event updated meanwhile,
   *  whose newer state the scan's older snapshot must not overwrite. */
  private readonly scanning = new Set<Set<string>>();
  /** Bumped by every scan of a project directory, per directory. */
  private readonly dirGens = new Map<string, number>();
  /** The `.bynk` files the server currently reports a contract break in. The
   *  server republishes diagnostics on every edit, so a refresh is requested only
   *  when a file enters or leaves this set. */
  private readonly broken = new Set<string>();
  /** Bumped by every full scan, so a slower earlier scan does not overwrite a newer one. */
  private scanGen = 0;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher("**/{*.bynk,bynk.toml}");
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      watcher,
      watcher.onDidCreate((uri) => void this.fileChanged(uri)),
      watcher.onDidChange((uri) => void this.fileChanged(uri)),
      watcher.onDidDelete((uri) => void this.fileDeleted(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.scan()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) this.changed.fire(undefined);
      }),
      testFailures.onDidChange((uris) => this.changed.fire(uris.map((u) => vscode.Uri.parse(u)))),
      vscode.languages.onDidChangeDiagnostics((e) => this.diagnosticsChanged(e.uris)),
    );
    // Diagnostics published before this provider existed.
    this.diagnosticsChanged(vscode.languages.getDiagnostics().map(([uri]) => uri), false);
    void this.scan();
  }

  /** What a file is decorated with, before it is turned into a decoration. */
  private stateOf(uri: vscode.Uri): {
    badge?: { badge: string; context: string };
    failed: boolean;
    contractBreak: boolean;
  } {
    const config = vscode.workspace.getConfiguration(SECTION);
    const key = uri.toString();
    return {
      badge: contextBadge(this.files, key, config.get<BadgeMode>("contextBadge", "auto")),
      failed: config.get<boolean>("failedTests", true) && testFailures.hasFailures(key),
      contractBreak: config.get<boolean>("contractBreaks", true) && this.broken.has(key),
    };
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const key = uri.toString();
    // A file no scan or watcher event has reported yet (just created, or the
    // watcher is late): read it now, which re-decorates it, and its project.
    if (uri.path.endsWith(".bynk") && !this.files.has(key) && !this.probed.has(key)) {
      this.probed.add(key);
      void this.fileChanged(uri);
    }
    const { badge, failed, contractBreak } = this.stateOf(uri);
    if (!badge && !failed && !contractBreak) return undefined;
    const tooltip = [
      badge && `Bynk context ${badge.context}`,
      failed && "Tests failed in the last run",
      contractBreak && `Contract break (${CONTRACT_DIFF_TITLE})`,
    ]
      .filter(Boolean)
      .join(" · ");
    // A file's context badge wins the badge slot; a break with none gets `!`, so
    // it is not shown by colour alone. A failed test is the louder signal, so its
    // red wins the colour when both apply; the `!` and the tooltip still say so.
    const decoration = new vscode.FileDecoration(
      badge?.badge ?? (contractBreak ? "!" : undefined),
      tooltip,
      failed
        ? new vscode.ThemeColor("bynk.testFailedForeground")
        : contractBreak
          ? new vscode.ThemeColor("bynk.contractBreakForeground")
          : undefined,
    );
    // A tinted folder shows where to look; a badge on a folder would not mean anything.
    decoration.propagate = failed || contractBreak;
    return decoration;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** The decoration state of a file, for the integration test. */
  snapshot(uri: vscode.Uri): {
    badge?: string;
    tooltip?: string;
    failed: boolean;
    contractBreak: boolean;
    tint?: "failed" | "contractBreak";
    propagate: boolean;
  } {
    const { failed, contractBreak } = this.stateOf(uri);
    const d = this.provideFileDecoration(uri);
    return {
      badge: d?.badge,
      tooltip: d?.tooltip,
      failed,
      contractBreak,
      tint: failed ? "failed" : contractBreak ? "contractBreak" : undefined,
      propagate: d?.propagate ?? false,
    };
  }

  /** Re-read which of `uris` carry a contract break, and refresh the files whose
   *  answer changed. Only a `.bynk` file can carry one. */
  private diagnosticsChanged(uris: readonly vscode.Uri[], refresh = true): void {
    const changed: vscode.Uri[] = [];
    for (const uri of uris) {
      if (!uri.path.endsWith(".bynk")) continue;
      const key = uri.toString();
      const now = hasContractBreak(vscode.languages.getDiagnostics(uri));
      if (now === this.broken.has(key)) continue;
      if (now) this.broken.add(key);
      else this.broken.delete(key);
      changed.push(uri);
    }
    if (refresh && changed.length > 0) this.changed.fire(changed);
  }

  /** Read `uris`, a bounded number at a time, into `next`. */
  private async readAll(uris: readonly vscode.Uri[], next: Map<string, ScannedFile>): Promise<void> {
    await mapLimit(uris, SCAN_CONCURRENCY, async (uri) => {
      const entry = await this.read(uri);
      if (entry) next.set(uri.toString(), entry);
    });
  }

  /** Rescan every `.bynk` file in the workspace. */
  private async scan(): Promise<void> {
    const gen = ++this.scanGen;
    const touched = new Set<string>();
    this.scanning.add(touched);
    try {
      const found = await vscode.workspace.findFiles("**/*.bynk", "**/node_modules/**");
      const next = new Map<string, ScannedFile>();
      await this.readAll(found, next);
      if (gen !== this.scanGen) return;
      this.probed.clear();
      const newer = [...touched].map((k) => [k, this.files.get(k)] as const);
      this.files.clear();
      for (const [k, v] of next) this.files.set(k, v);
      for (const [k, v] of newer) {
        if (v) this.files.set(k, v);
        else this.files.delete(k);
      }
      this.changed.fire(undefined);
    } finally {
      this.scanning.delete(touched);
    }
  }

  /** Rescan the `.bynk` files under `dir`: a manifest there was created, changed
   *  or deleted, which can only move the project of files below it. Files
   *  elsewhere (and the ones probed outside any project) are left alone. */
  private async scanUnder(dir: vscode.Uri): Promise<void> {
    const dirKey = dir.toString();
    const gen = this.scanGen;
    const dirGen = (this.dirGens.get(dirKey) ?? 0) + 1;
    this.dirGens.set(dirKey, dirGen);
    const touched = new Set<string>();
    this.scanning.add(touched);
    try {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(dir, "**/*.bynk"),
        "**/node_modules/**",
      );
      const next = new Map<string, ScannedFile>();
      await this.readAll(found, next);
      // A newer scan of this directory, or a full one, supersedes this.
      if (gen !== this.scanGen || dirGen !== this.dirGens.get(dirKey)) return;
      const prefix = dirKey.endsWith("/") ? dirKey : `${dirKey}/`;
      const affected: vscode.Uri[] = [];
      for (const k of [...this.files.keys()]) {
        // A file a watcher event updated while the scan ran keeps that state.
        if (k.startsWith(prefix) && !touched.has(k)) {
          this.files.delete(k);
          affected.push(vscode.Uri.parse(k));
        }
      }
      for (const k of this.probed) if (k.startsWith(prefix)) this.probed.delete(k);
      for (const [k, v] of next) {
        if (!touched.has(k)) this.files.set(k, v);
        affected.push(vscode.Uri.parse(k));
      }
      this.changed.fire(affected);
    } finally {
      this.scanning.delete(touched);
    }
  }

  private touch(key: string): void {
    for (const t of this.scanning) t.add(key);
  }

  private async read(uri: vscode.Uri): Promise<ScannedFile | undefined> {
    try {
      const root = await projectRootFor(uri);
      const header = root && parseUnitHeader(await readText(uri));
      return root && header ? { root: root.toString(), kind: header.kind, name: header.name } : undefined;
    } catch {
      return undefined; // unreadable or gone: no decoration
    }
  }

  private async fileChanged(uri: vscode.Uri): Promise<void> {
    if (uri.path.endsWith("/bynk.toml")) {
      clearProjectRoots();
      return this.scanUnder(vscode.Uri.joinPath(uri, ".."));
    }
    const before = this.files.get(uri.toString());
    const after = await this.read(uri);
    this.touch(uri.toString());
    if (after) this.files.set(uri.toString(), after);
    else this.files.delete(uri.toString());
    this.refreshAround(uri, before, after);
  }

  private async fileDeleted(uri: vscode.Uri): Promise<void> {
    if (uri.path.endsWith("/bynk.toml")) {
      clearProjectRoots();
      return this.scanUnder(vscode.Uri.joinPath(uri, ".."));
    }
    const before = this.files.get(uri.toString());
    this.touch(uri.toString());
    this.files.delete(uri.toString());
    this.refreshAround(uri, before, undefined);
  }

  /** Refresh `uri`, and its whole project when a context appeared, went, or was
   *  renamed (which can move the project across the single-context threshold,
   *  or change a suite's badge). */
  private refreshAround(uri: vscode.Uri, before?: ScannedFile, after?: ScannedFile): void {
    const contextChanged = before?.kind !== after?.kind || before?.name !== after?.name;
    const touchesContext = before?.kind === "context" || after?.kind === "context";
    if (!contextChanged || !touchesContext) {
      this.changed.fire(uri);
      return;
    }
    const roots = new Set([before?.root, after?.root]);
    const affected = [...this.files].filter(([, f]) => roots.has(f.root)).map(([k]) => vscode.Uri.parse(k));
    this.changed.fire([uri, ...affected]);
  }
}

export function registerFileDecorations(context: vscode.ExtensionContext): FileDecorations {
  const provider = new FileDecorations();
  context.subscriptions.push(
    provider,
    // Test seam for the integration suite (not contributed, so never in the palette).
    vscode.commands.registerCommand("bynk._fileDecoration", (uri: string) =>
      provider.snapshot(vscode.Uri.parse(uri)),
    ),
  );
  return provider;
}
