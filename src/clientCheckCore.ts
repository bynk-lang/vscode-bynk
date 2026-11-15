// The dependency-free core of the stale-client warning (#132): whether a
// project asks for a generated TypeScript client, what `bynk client --check`
// said about it, and the text the editor shows for that. No `vscode` import, so
// the unit tests compile against it directly (see tsconfig.test.json);
// `clientCheck.ts` wires it to the editor.
//
// `bynk client --check` writes nothing. It exits 0 when the client at `--out`
// is what the project would generate. When it is not, it prints
// `bynk: client is stale: run ...` on stderr, then one entry per file: either
// `  <path>: missing`, or `  <path> differs at line N (M lines in all):` with
// the first differing line's `- found:` and `+ expected:` below it. Any other
// failure (the project does not check, `[build.client]` is malformed, the
// destination cannot be compared) prints a plain `bynk: <reason>` and is
// "unknown" here: the editor can say nothing about the client.

/** What a check made of the generated client. */
export type ClientOutcome =
  /** The client on disk is what the project would generate. */
  | { kind: "fresh" }
  /** At least one file differs from what the project would generate. */
  | { kind: "stale"; summary: string; detail: string }
  /** Every file the client consists of is absent. */
  | { kind: "missing"; summary: string; detail: string }
  /** The check could not say (the project has errors, `bynk` failed, …). */
  | { kind: "unknown"; reason: string };

/** A finished `bynk client --check` run: structurally `BynkResult`. */
export interface CheckRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

const STALE_HEADER = /^bynk: client is stale\b/;
const MISSING_ENTRY = /^\s+(.+): missing\s*$/;
const DIFF_ENTRY = /^\s+(.+) differs at line (\d+)\b/;

/** Whether a `bynk.toml` has a `[build.client]` table (#132): the only projects
 *  the check runs for. A scan, not a TOML parse: a header on a line of its own
 *  (spaces around the dot and quoted keys allowed, a trailing comment allowed),
 *  never one inside a multi-line string, which the manifest has no use for. */
export function hasBuildClient(manifest: string): boolean {
  return /^[ \t]*\[[ \t]*build[ \t]*\.[ \t]*client[ \t]*\][ \t]*(#.*)?$/m.test(manifest.replace(/"build"|'build'/g, "build").replace(/"client"|'client'/g, "client"));
}

/** Classify a `bynk client --check` run. */
export function classifyCheck(run: CheckRun): ClientOutcome {
  if (run.code === 0) return { kind: "fresh" };
  const lines = run.stderr.split(/\r?\n/);
  const header = lines.findIndex((l) => STALE_HEADER.test(l));
  if (header >= 0) {
    // Everything after the header that is not a note: the entries and, under a
    // differing file, its two lines.
    const body = lines.slice(header + 1).filter((l) => l.trim() !== "" && !l.startsWith("bynk: "));
    const missing = body.filter((l) => MISSING_ENTRY.test(l));
    const differing = body.filter((l) => DIFF_ENTRY.test(l));
    const detail = body.join("\n");
    if (missing.length > 0 && differing.length === 0) {
      const files = missing.map((l) => MISSING_ENTRY.exec(l)![1]);
      return {
        kind: "missing",
        summary: files.length === 1 ? `${files[0]} does not exist` : `${files.length} client files do not exist`,
        detail,
      };
    }
    const first = differing.map((l) => DIFF_ENTRY.exec(l)!)[0];
    return {
      kind: "stale",
      summary: first ? `${first[1]} differs at line ${first[2]}` : "the client differs from what the project generates",
      detail,
    };
  }
  if (run.code === null) return { kind: "unknown", reason: "`bynk client --check` was stopped" };
  return { kind: "unknown", reason: firstProblem(lines) ?? `\`bynk client --check\` exited with ${run.code}` };
}

/** The first line of stderr that states a failure, without the `bynk: ` prefix
 *  and not counting the notes and skipped-route lines the command also prints. */
function firstProblem(lines: readonly string[]): string | undefined {
  for (const raw of lines) {
    const l = raw.trim();
    if (l === "" || /^bynk: (note|skipped)\b/.test(l)) continue;
    return l.replace(/^bynk: /, "");
  }
  return undefined;
}

/** What the editor knows about one project's client. */
export type ClientState = ClientOutcome | { kind: "none" };

/** The state after a new outcome. A fresh client clears the warning; "unknown"
 *  changes nothing, since the check said nothing, and a warning that was
 *  showing stays until the client is known to be current. */
export function nextState(previous: ClientState, outcome: ClientOutcome): ClientState {
  return outcome.kind === "unknown" ? previous : outcome;
}

/** Whether a state is one the user should be told about. */
export function isDrifted(state: ClientState): state is Extract<ClientOutcome, { kind: "stale" | "missing" }> {
  return state.kind === "stale" || state.kind === "missing";
}

/** The status-bar text, tooltip and warning for the projects whose client has
 *  drifted, or `undefined` when none has. `names` are the projects' names. */
export function statusFor(drifted: readonly { name: string; state: ClientOutcome }[]): { text: string; tooltip: string } | undefined {
  const list = drifted.filter((d) => isDrifted(d.state));
  if (list.length === 0) return undefined;
  const missingOnly = list.every((d) => d.state.kind === "missing");
  const text = missingOnly ? "$(warning) Bynk client missing" : "$(warning) Bynk client stale";
  const lines = list.map((d) => {
    const s = d.state as Extract<ClientOutcome, { kind: "stale" | "missing" }>;
    return list.length === 1 ? s.summary : `${d.name}: ${s.summary}`;
  });
  const lead = missingOnly
    ? "The generated TypeScript client has not been written."
    : "The generated TypeScript client no longer matches the project.";
  return { text, tooltip: `${lead}\n${lines.join("\n")}\nClick for actions.` };
}

/** The `bynk` arguments of the check: `[build.client]` supplies the rest. */
export const CHECK_ARGS: readonly string[] = ["client", "--check"];
