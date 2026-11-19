// The last whole-project test run per project (#221): what the Test Explorer
// found, kept so "Ready to deploy?" can say whether the tests passed without
// running them. Dependency-free (no `vscode` import). Only a run of the whole
// project counts: a run of one case or suite says nothing about the rest, and a
// run against a remote target is not a run of this source.

export interface TestRunSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** When the run finished (`Date.now()`). */
  at: number;
}

const last = new Map<string, TestRunSummary>();

/** Record the whole-project run of the project at `root` (a URI string). */
export function recordTestRun(root: string, summary: TestRunSummary): void {
  last.set(root, summary);
}

/** The last whole-project run of `root`, if there was one this session. */
export function lastTestRun(root: string): TestRunSummary | undefined {
  return last.get(root);
}

/** Forget every run (a test seam). */
export function clearTestRuns(): void {
  last.clear();
}
