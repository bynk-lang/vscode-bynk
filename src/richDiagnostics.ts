// #2516: read the diagnostics `bynk compile` prints. Only `compile` takes
// `--sources-stdin` (unsaved buffers), so a candidate edit that is not on disk
// can be checked only through it, and `compile` has no `--format short`. Its
// stderr is the compiler's rich rendering:
//
//   [bynk.resolve.unknown_name] Error: unknown name `missing`
//      ╭─[ src/shop.bynk:3:27 ]
//      │ …source excerpt and notes…
//   ───╯
//
// so a diagnostic is the header line plus the location in the box that follows.
// No `vscode` import, so the unit tests read it directly.

export interface CompileDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  /** Project-relative, as the compiler printed it. Absent if no location followed. */
  path?: string;
  line?: number;
  column?: number;
}

const HEADER = /^\[([^\]\s]+)\] (Error|Warning): (.*)$/;
const LOCATION = /╭─\[ (.+?):(\d+):(\d+) \]/;
// Colour codes: the compiler prints none to a pipe, but a forced-colour
// environment would put them around the brackets.
const ANSI = /\u001b\[[0-9;]*m/g;

/** The diagnostics in `bynk compile`'s output, in order. Text that is not one
 *  (a progress line, an excerpt, a note) is ignored. */
export function parseRichDiagnostics(output: string): CompileDiagnostic[] {
  const found: CompileDiagnostic[] = [];
  let current: CompileDiagnostic | undefined;
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const header = HEADER.exec(raw);
    if (header) {
      current = {
        code: header[1],
        severity: header[2] === "Error" ? "error" : "warning",
        message: header[3].trim(),
      };
      found.push(current);
      continue;
    }
    // The first location after a header is that diagnostic's own.
    const where = current && current.path === undefined ? LOCATION.exec(raw) : null;
    if (current && where) {
      current.path = where[1];
      current.line = Number(where[2]);
      current.column = Number(where[3]);
    }
  }
  return found;
}

/** What identifies a diagnostic across two compiles of slightly different text:
 *  not its line (an edit moves it) but where and what it is. */
export function diagnosticKey(d: CompileDiagnostic): string {
  return `${d.path ?? ""}|${d.code}|${d.message}`;
}

/** A diagnostic as one line, for a message to the user or the model. */
export function describeDiagnostic(d: CompileDiagnostic): string {
  const at = d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : "";
  return `${at}${d.severity}[${d.code}]: ${d.message}`;
}
