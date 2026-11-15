// #130: the pure part of "Bynk: Apply Fixes Across Project…". The command runs
// `bynk check --fix=<code>[,<code>…]`, which owns the fixing (which edits, in
// which files, whether the result is safe to write); the extension picks the
// codes, saves the buffers the CLI would otherwise not see, and reports.

/** `bynk check <root> --fix=<codes> --format short`. `--fix` needs the `=`
 *  form; `short` makes what remains easy to count. */
export function applyFixesArgs(root: string, codes: readonly string[]): string[] {
  return ["check", root, `--fix=${codes.join(",")}`, "--format", "short"];
}

/** Codes typed or picked, split on commas and whitespace, trimmed, de-duplicated.
 *  The CLI decides whether a code is real; an unknown one comes back with its
 *  "did you mean" message. */
export function parseCodes(input: string): string[] {
  return [...new Set(input.split(/[\s,]+/).filter((c) => c !== ""))];
}

/** One file the CLI rewrote, and how many fixes of each code it took there. */
export interface FixedFile {
  path: string;
  codes: { code: string; count: number }[];
}

/** The `fixed: <path>: <code> ×<n>, …` lines the CLI prints to stderr, one per
 *  file it wrote. */
export function parseFixedFiles(stderr: string): FixedFile[] {
  const files: FixedFile[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /^fixed: (.+?): (bynk\.\S+ ×\d+(?:, bynk\.\S+ ×\d+)*)$/.exec(line);
    if (!m) continue;
    const codes = m[2].split(", ").map((part) => {
      const [code, count] = part.split(" ×");
      return { code, count: Number(count) };
    });
    files.push({ path: m[1], codes });
  }
  return files;
}

/** Diagnostics left after the fixes, counted from `--format short` lines
 *  (`path:line:col: severity[category]: message`). */
export function remainingProblems(output: string): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const line of output.split(/\r?\n/)) {
    const m = /^.+?:\d+:\d+: (error|warning)\b/.exec(line);
    if (m?.[1] === "error") errors++;
    else if (m?.[1] === "warning") warnings++;
  }
  return { errors, warnings };
}

/** The CLI's own `--fix:` messages (a refusal, an unknown code, a write
 *  failure), shown as they are. */
export function fixMessages(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((l) => /--fix:/.test(l))
    .join("\n");
}

/** What the command does after `bynk check --fix` ran (or failed to run). */
export type ApplyFixesOutcome =
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }
  | { kind: "applied"; files: FixedFile[]; remaining: { errors: number; warnings: number } }
  | { kind: "nothing"; remaining: { errors: number; warnings: number } };

/** Map a finished run to its outcome. `run` is the result, or whatever the
 *  runner rejected with. A non-zero exit is not itself a failure: problems that
 *  remain make `check` exit non-zero too. It is one when the CLI printed a
 *  `--fix:` message (refused, unknown code, could not write) and wrote nothing. */
export function applyFixesOutcome(
  run: { code: number | null; stdout: string; stderr: string } | { error: unknown },
  cancelled: boolean,
): ApplyFixesOutcome {
  if (cancelled) return { kind: "cancelled" };
  if ("error" in run) {
    const e = run.error;
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  const files = parseFixedFiles(run.stderr);
  const messages = fixMessages(run.stderr);
  if (/unrecogni[sz]ed (option|argument)|unexpected argument/i.test(run.stderr) && messages === "") {
    return {
      kind: "failed",
      message: "This Bynk toolchain's `bynk check` has no `--fix=<code>`. Update it, or run Bynk: Doctor.",
    };
  }
  if (messages !== "" && files.length === 0) return { kind: "failed", message: messages };
  if (messages === "" && files.length === 0 && run.code !== 0 && run.code !== 1) {
    const detail = run.stderr.trim();
    return {
      kind: "failed",
      message: detail === "" ? "`bynk check --fix` failed without a message." : `\`bynk check --fix\` failed:\n${detail}`,
    };
  }
  const remaining = remainingProblems(`${run.stdout}\n${run.stderr}`);
  return files.length === 0 ? { kind: "nothing", remaining } : { kind: "applied", files, remaining };
}

/** The sentence a finished run is reported with. */
export function describeOutcome(
  outcome: Extract<ApplyFixesOutcome, { kind: "applied" | "nothing" }>,
): string {
  const { errors, warnings } = outcome.remaining;
  const left =
    errors + warnings === 0
      ? "No problems remain."
      : `Remaining: ${plural(errors, "error")}, ${plural(warnings, "warning")}.`;
  if (outcome.kind === "nothing") return `No files needed those fixes. ${left}`;
  const n = outcome.files.length;
  return `Fixed ${plural(n, "file")}. ${left} The CLI does not format: run Format if you want it.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
