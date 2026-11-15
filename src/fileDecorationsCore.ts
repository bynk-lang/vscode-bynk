// #2478: the Explorer file decorations' model — the `vscode`-free half of
// `fileDecorations.ts`, so the unit tests drive the badge rules and the
// failing-test bookkeeping without an extension host.
//
// DECISION A: the badge is a two-letter abbreviation of the owning context's
// name (the full name is the tooltip), shown by default only in a project with
// more than one context, where telling them apart is the point.

import type { UnitKind } from "./projectModel";

/** How `bynk.fileDecorations.contextBadge` is set. */
export type BadgeMode = "auto" | "always" | "never";

/** A scanned `.bynk` file: the project it is in and the unit it declares. */
export interface ScannedFile {
  /** The project root, as a URI string. */
  root: string;
  kind: UnitKind;
  name: string;
}

/**
 * A context's two-letter badge. A multi-word name (`order.billing`,
 * `order_billing`, `OrderBilling`) takes the initials of its first two words;
 * a single word takes its first two letters. Always upper case.
 */
export function abbreviate(name: string): string {
  const words = name
    .split(/[._]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((w) => w.length > 0);
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}

/** The context a file belongs to: a context's own file, or a suite (a test
 *  file) naming the context it tests. `undefined` for commons, adapters, and
 *  a suite whose target is not a context of its project. */
export function owningContext(files: ReadonlyMap<string, ScannedFile>, uri: string): string | undefined {
  const file = files.get(uri);
  if (!file) return undefined;
  if (file.kind === "context") return file.name;
  if (file.kind !== "test") return undefined;
  for (const other of files.values()) {
    if (other.root === file.root && other.kind === "context" && other.name === file.name) return file.name;
  }
  return undefined;
}

/** The number of distinct contexts declared in a project. */
export function contextCount(files: ReadonlyMap<string, ScannedFile>, root: string): number {
  const names = new Set<string>();
  for (const f of files.values()) if (f.root === root && f.kind === "context") names.add(f.name);
  return names.size;
}

/** The context badge for a file, or `undefined` when it has none to show. */
export function contextBadge(
  files: ReadonlyMap<string, ScannedFile>,
  uri: string,
  mode: BadgeMode,
): { badge: string; context: string } | undefined {
  if (mode === "never") return undefined;
  const context = owningContext(files, uri);
  const file = files.get(uri);
  if (!context || !file) return undefined;
  if (mode === "auto" && contextCount(files, file.root) < 2) return undefined;
  return { badge: abbreviate(context), context };
}

/**
 * Which cases failed in the last run, per file. A case enters on a failure and
 * leaves when a later run passes it (or the case no longer exists), so a
 * passing re-run of the failures clears the file while a narrowed re-run of one
 * passing case leaves a still-failing sibling alone.
 */
export class FailureTracker {
  private readonly failed = new Map<string, Set<string>>();
  private readonly listeners = new Set<(uris: string[]) => void>();

  /** Called with the files whose state changed. */
  onDidChange(listener: (uris: string[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Record one case's outcome; `file` is the case's file, when it has one. */
  record(file: string | undefined, caseId: string, outcome: "passed" | "failed"): void {
    if (!file) return;
    const ids = this.failed.get(file);
    if (outcome === "failed") {
      if (ids?.has(caseId)) return;
      if (ids) ids.add(caseId);
      else this.failed.set(file, new Set([caseId]));
      this.emit([file]);
    } else if (ids?.delete(caseId)) {
      if (ids.size === 0) this.failed.delete(file);
      this.emit([file]);
    }
  }

  /** Forget every failed case whose id is not in `live` (a removed test). */
  retain(live: ReadonlySet<string>): void {
    const changed: string[] = [];
    for (const [file, ids] of this.failed) {
      for (const id of [...ids]) if (!live.has(id)) ids.delete(id);
      if (ids.size === 0) {
        this.failed.delete(file);
        changed.push(file);
      }
    }
    if (changed.length > 0) this.emit(changed);
  }

  hasFailures(file: string): boolean {
    return this.failed.has(file);
  }

  private emit(uris: string[]): void {
    for (const l of this.listeners) l(uris);
  }
}

/** The failures `testing.ts` records into and the decoration provider reads. */
export const testFailures = new FailureTracker();

/** The diagnostics that mark a boundary break against `bynk.schema.lock`: an
 *  event's schema changed non-additively, or an agent's state did. They are the
 *  codes the language server publishes (and `bynk check` prints), so a file that
 *  carries one is where the contract diff has something to show. */
export const CONTRACT_BREAK_CODES: readonly string[] = [
  "bynk.event.non_additive_schema_change",
  "bynk.agent.non_additive_state_change",
];

/** The title the tooltip names for the contract diff command (its `package.json`
 *  title, held equal by a test). A decoration cannot run a command, so it names it. */
export const CONTRACT_DIFF_TITLE = "Bynk: Show Contract Diff";

/** A diagnostic's `code` as VS Code hands it over: a bare value, or `{ value, target }`
 *  when the server attaches a documentation link. */
export type DiagnosticCode = string | number | { value: string | number; target?: unknown } | null | undefined;

/** Whether any of a file's diagnostics is a contract break. */
export function hasContractBreak(diagnostics: readonly { code?: DiagnosticCode }[]): boolean {
  return diagnostics.some((d) => {
    // `typeof null` is "object", and a server or another extension can publish a
    // null code despite the type.
    const code = d.code !== null && typeof d.code === "object" ? d.code.value : d.code;
    return typeof code === "string" && CONTRACT_BREAK_CODES.includes(code);
  });
}

// #134: the TypeScript client `bynk client` (and `bynk build` with
// `[build.client]`) writes. Its modules are generated, so a hand edit is lost at
// the next regeneration and `bynk client --check` reports it as drift.

/** The first line of every module the client writer produces (bynk `http_client.rs`). */
export const CLIENT_GENERATED_HEADER = "// @generated by `bynk client`";

/** The modules a `layout = "dir"` client is made of, inside the `out` directory. */
export const CLIENT_DIR_FILES: readonly string[] = ["index.ts", "types.ts", "codecs.ts", "runtime.ts"];

/** The command that regenerates the client (added by the "Generate TypeScript Client" feature). */
export const GENERATE_CLIENT_COMMAND = "bynk.generateClient";

/** A project's `[build.client]` table: `layout` is `"file"` unless the manifest says `"dir"`. */
export interface ClientConfig {
  out: string;
  layout: "file" | "dir";
}

/** The value of a TOML basic or literal string at the start of `text`, if it is one. */
function tomlString(text: string): string | undefined {
  const m = /^(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(text.trim());
  if (!m) return undefined;
  if (m[2] !== undefined) return m[2];
  return m[1].replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    if (c[0] === "u") return String.fromCharCode(parseInt(c.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[c] ?? c;
  });
}

/**
 * `[build.client]` from a `bynk.toml`, or `undefined` when the table is absent or
 * has no usable `out`. A small reader for the one table (the extension carries no
 * TOML parser): it handles `[build.client]` as a header, and the `client = { ... }`
 * and dotted `client.out = ...` spellings under `[build]`.
 */
export function parseClientConfig(toml: string): ClientConfig | undefined {
  let section = "";
  let out: string | undefined;
  let layout: string | undefined;
  const take = (key: string, value: string): void => {
    if (key === "out") out = tomlString(value) ?? out;
    else if (key === "layout") layout = tomlString(value) ?? layout;
  };
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\s*([^\]]*?)\s*\]/.exec(line);
    if (header && !line.startsWith("[[")) {
      section = header[1].replace(/\s*\.\s*/g, ".");
      continue;
    }
    if (line.startsWith("[[")) {
      section = "";
      continue;
    }
    const kv = /^([A-Za-z0-9_.\- "]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/\s*\.\s*/g, ".").replace(/"/g, "");
    if (section === "build.client") take(key, kv[2]);
    else if (section === "build") {
      if (key.startsWith("client.")) take(key.slice("client.".length), kv[2]);
      else if (key === "client") {
        for (const part of kv[2].replace(/^\{|\}.*$/g, "").split(/,(?=\s*[A-Za-z_]+\s*=)/)) {
          const p = /^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/.exec(part);
          if (p) take(p[1], p[2]);
        }
      }
    }
  }
  if (!out) return undefined;
  return { out, layout: layout === "dir" ? "dir" : "file" };
}

/** Resolve `rel` against the absolute POSIX `base`, collapsing `.` and `..`
 *  (the `out` of a client often leaves the project: `../web/src/lib/api.ts`). */
export function resolvePath(base: string, rel: string): string {
  const parts = (rel.startsWith("/") ? rel : `${base}/${rel}`).replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return `/${out.join("/")}`;
}

/** The files `[build.client]` writes, as absolute POSIX paths: one module, or the
 *  four of a directory layout. `root` is the project root's path. */
export function clientFiles(root: string, config: ClientConfig): string[] {
  const out = resolvePath(root, config.out);
  return config.layout === "dir" ? CLIENT_DIR_FILES.map((f) => `${out}/${f}`) : [out];
}

/** Whether `text` starts with the generated-client header. */
export function hasClientHeader(text: string): boolean {
  return text.replace(/^﻿/, "").split(/\r?\n/, 1)[0].trimEnd() === CLIENT_GENERATED_HEADER;
}

/** The decoration's tooltip. `project` is the project's directory name. */
export function clientTooltip(project: string): string {
  return `Generated by \`bynk client\` from ${project}; regenerate rather than edit`;
}

/** The badge a generated client module carries (its tooltip says the rest). */
export const CLIENT_BADGE = "GN";
