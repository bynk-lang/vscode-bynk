// #16: the pure part of "Bynk: Export OpenAPI". The command runs `bynk openapi`,
// which owns the document (paths, schemas, status codes); the extension only
// picks where it goes and says what happened.

/** `bynk openapi <root> --out <file>`. The format follows the file's extension
 *  (`.yaml` / `.yml` is YAML, anything else JSON), so the dialog's choice of
 *  name is the whole format decision. */
export function openapiArgs(root: string, outFile: string): string[] {
  return ["openapi", root, "--out", outFile];
}

/** What a failed run means to the person who ran it. */
export function openapiFailure(stderr: string): string {
  // A toolchain from before `bynk openapi` rejects the subcommand itself.
  if (/unrecogni[sz]ed subcommand|unknown subcommand/i.test(stderr)) {
    return "This Bynk toolchain has no `bynk openapi` command. Update it, or run Bynk: Doctor.";
  }
  const detail = stderr.trim();
  return detail === ""
    ? "`bynk openapi` failed without a message."
    : `\`bynk openapi\` failed:\n${detail}`;
}

/** What the command does after `bynk openapi` ran (or failed to run). */
export type OpenapiOutcome =
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }
  | { kind: "written" };

/** Map a finished run to its outcome. `run` is the result, or whatever the
 *  runner rejected with; a cancelled run exits without a code, and is not a
 *  failure the person needs told about. */
export function openapiOutcome(
  run: { code: number | null; stderr: string } | { error: unknown },
  cancelled: boolean,
): OpenapiOutcome {
  if (cancelled) return { kind: "cancelled" };
  if ("error" in run) {
    const e = run.error;
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
  if (run.code !== 0) return { kind: "failed", message: openapiFailure(run.stderr) };
  return { kind: "written" };
}
