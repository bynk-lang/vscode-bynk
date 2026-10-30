// The arguments of a `bynk test` run. Split out of `testing.ts`; `vscode`-free so
// it is unit-tested in plain Node.

import { validSeed } from "./testSeeds";

export interface TestRunOptions {
  noRun?: boolean;
  caseName?: string;
  /** A set (#2273): repeated `--suite` and `--case`, combined as "and". */
  suites?: string[];
  cases?: string[];
  coverage?: boolean;
  against?: string;
  skipUnsupported?: boolean;
  seed?: string;
}

/** The `bynk test` arguments for a run, in `--format json` (the one document) or
 *  `--format ndjson` (the stream). */
export function testArgs(rootPath: string, opts: TestRunOptions | undefined, format: "json" | "ndjson"): string[] {
  // #2104: a coverage run names the project by its absolute path, so the
  // coverage block's paths are project-relative even from a driver that
  // collapses them under a relative `.` (fixed alongside this change).
  const input = opts?.coverage ? rootPath : ".";
  const args = opts?.noRun
    ? ["test", input, "--no-run", "--format", format]
    : ["test", input, "--format", format];
  // v0.127: the per-case run filter (no effect alongside `--no-run` discovery).
  if (opts?.caseName) args.push("--case", opts.caseName);
  for (const suite of opts?.suites ?? []) args.push("--suite", suite);
  for (const name of opts?.cases ?? []) args.push("--case", name);
  if (opts?.coverage) args.push("--coverage");
  // Slice C: reproduce a generative case's stream. Only a seed the runner reported
  // is passed.
  if (opts?.seed && validSeed(opts.seed)) args.push("--seed", opts.seed);
  // Slice B: run the `system` suites against a named target. The name is passed
  // through untouched; the driver decides whether it is safe.
  if (opts?.against) args.push("--against", opts.against);
  if (opts?.against && opts.skipUnsupported) args.push("--skip-unsupported");
  return args;
}
