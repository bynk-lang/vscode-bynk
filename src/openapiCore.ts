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
