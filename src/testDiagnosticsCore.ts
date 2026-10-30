// Parsing of the compile-failure lines a `bynk test` run reports. Split out of
// `testing.ts`; `vscode`-free so it is unit-tested in plain Node.

/** One `path:line:col: severity[category]: message` line, with a 0-indexed
 *  `line`/`col` (the document's are 1-indexed). */
export interface CompileDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

/** Parse the lines (the same shape the `$bynkc` problem-matcher parses); a line that
 *  does not match is dropped. */
export function parseCompileDiagnostics(lines: string[]): CompileDiagnostic[] {
  const re = /^(.+?):(\d+):(\d+): (error|warning)\[([^\]]+)\]: (.+)$/;
  const out: CompileDiagnostic[] = [];
  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const [, file, lineStr, colStr, sev, code, message] = m;
    out.push({
      file,
      line: Math.max(0, Number(lineStr) - 1),
      col: Math.max(0, Number(colStr) - 1),
      severity: sev as "error" | "warning",
      code,
      message,
    });
  }
  return out;
}
