// Applying a `bynk test` document to a run: per-case outcomes, failure messages
// with click-through locations, handler placement and coverage detail. Split out
// of `testing.ts`.

import * as vscode from "vscode";

import { testFailures } from "./fileDecorationsCore";
import type { ViewRefresh } from "./viewRefresh";
import { handlerSymbols } from "./refreshScheduler";
import {
  caseKey,
  declarationNotes,
  handlerForCall,
  outcomeOf,
  retriesNote,
  skippedLine,
  type JsonCase,
  type JsonLocation,
  type JsonRefusal,
  type JsonSuite,
  type PlacedHandler,
  type RunPlan,
  type TestRun,
} from "./testPlan";
import { sourcePosition, suiteIdOf } from "./testTree";

/** The slice of a `vscode.TestRun` a run document is applied through, so a test
 *  can drive {@link applyDocument} with a recording stand-in. */
export type RunSink = Pick<
  vscode.TestRun,
  "started" | "passed" | "failed" | "skipped" | "appendOutput"
>;

/** Where the handler a refusal called is declared, if the extension could place it. */
export type HandlerLookup = (r: JsonRefusal) => PlacedHandler | undefined;

export const handlerKeyOf = (r: JsonRefusal): string => `${r.location?.path ?? ""}\0${r.agent}\0${r.call}`;

/** Place the handler each refused step of `doc` called (#2359). A refusal carries the
 *  agent, the call and the declaration that refused it; the declaration is in the
 *  agent's file, so that file's document symbols hold the handler. A refusal the driver
 *  could not place, or a file or handler the language server does not answer for,
 *  simply gets no handler line. */
export async function placeHandlers(
  root: vscode.Uri,
  doc: TestRun,
  hub: Pick<ViewRefresh, "documentSymbols"> | null | undefined,
): Promise<HandlerLookup | undefined> {
  if (!hub) return undefined;
  const refusals = (doc.suites ?? []).flatMap((s) => s.cases.flatMap((c) => c.refusals ?? []));
  const placed = new Map<string, PlacedHandler>();
  const byFile = new Map<string, Promise<ReturnType<typeof handlerSymbols>>>();
  await Promise.all(
    refusals.map(async (r) => {
      if (!r.location) return;
      const rel = r.location.path;
      try {
        if (!byFile.has(rel)) {
          byFile.set(
            rel,
            Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, rel)))
              .then((d) => hub.documentSymbols(d))
              .then(handlerSymbols),
          );
        }
        const h = handlerForCall(await byFile.get(rel)!, r.agent, r.call);
        if (!h) return;
        const at = h.symbol.selectionRange.start;
        placed.set(handlerKeyOf(r), {
          name: h.symbol.name.replace(/^call /, ""),
          location: { path: rel, line: at.line + 1, col: at.character + 1 },
        });
      } catch {
        // No symbols for this file: the refusal keeps its declaration line only.
      }
    }),
  );
  return placed.size ? (r) => placed.get(handlerKeyOf(r)) : undefined;
}

/** Apply one `bynk test --format json` document to a run: report each case it
 *  holds that the plan allows, and return the keys it reported.
 *
 *  An unnarrowed run reports every case the document returns, including one the
 *  tree has not seen yet (`createUnseen` makes its item); a narrowed run reports
 *  only what was requested, so a name shared by two suites, or the rest of the
 *  project when a whole-project run stands in for a selection, is not reported.
 *  `scope` is the project's id in the tree (its root URI string): the suites' ids
 *  are namespaced by it, as the tree's are. */
export function applyDocument(
  run: RunSink,
  items: Map<string, vscode.TestItem>,
  plan: Pick<RunPlan, "wanted" | "narrowed">,
  doc: TestRun,
  root: vscode.Uri,
  createUnseen?: (suite: JsonSuite, c: JsonCase) => vscode.TestItem,
  handlerAt?: HandlerLookup,
  scope?: string,
): Set<string> {
  const reported = new Set<string>();
  const wanted = new Set(plan.wanted);
  for (const suite of doc.suites ?? []) {
    const suiteId = suiteIdOf(suite, scope);
    for (const c of suite.cases) {
      const key = caseKey(suiteId, c.name);
      if (plan.narrowed && !wanted.has(key)) continue;
      let item = items.get(key);
      if (!item) {
        if (plan.narrowed || !createUnseen) continue;
        item = createUnseen(suite, c);
        items.set(key, item);
      }
      reported.add(key);
      reportCase(run, item, root, c, handlerAt);
    }
  }
  return reported;
}

/** Report one case's outcome. A skipped case is skipped, not failed; an outcome
 *  this extension does not know is reported as a failure that names it. */
export function reportCase(
  run: RunSink,
  item: vscode.TestItem,
  root: vscode.Uri,
  c: JsonCase,
  handlerAt?: HandlerLookup,
): void {
  run.started(item);
  switch (outcomeOf(c.outcome)) {
    case "passed":
      run.passed(item, c.durationMs);
      break;
    case "skipped":
      run.skipped(item);
      run.appendOutput(`${skippedLine(c)}\r\n`);
      break;
    case "failed":
      run.failed(item, failureMessages(root, c, handlerAt), c.durationMs);
      break;
    default:
      run.failed(
        item,
        new vscode.TestMessage(
          `Unexpected outcome "${c.outcome}" from bynk test` + (c.message ? `: ${c.message}` : "."),
        ),
      );
  }
  const retry = retriesNote(c);
  if (retry) run.appendOutput(`${retry}\r\n`);
  // #2478: the Explorer tints a file whose case failed, until a run passes it.
  const outcome = outcomeOf(c.outcome);
  if (outcome !== "skipped") testFailures.record(item.uri?.toString(), item.id, outcome === "passed" ? "passed" : "failed");
}

/** Per-line statements for each `FileCoverage` a run added, for the coverage
 *  profile's `loadDetailedCoverage` (the editor's gutter marks). */
export const coverageDetail = new WeakMap<vscode.FileCoverage, { line: number; executed: boolean }[]>();

export function detailedCoverage(fc: vscode.FileCoverage): vscode.StatementCoverage[] {
  return (coverageDetail.get(fc) ?? []).map(
    (s) => new vscode.StatementCoverage(s.executed, new vscode.Position(s.line - 1, 0)),
  );
}

/** Build the `TestMessage` for a failed case, with a `Location` for
 *  click-through when the case carries a `path:line:col`. */
export function failureMessages(root: vscode.Uri, c: JsonCase, handlerAt?: HandlerLookup): vscode.TestMessage[] {
  const at = (msg: vscode.TestMessage, where: JsonLocation | undefined = c.location): vscode.TestMessage => {
    if (where) {
      const uri = vscode.Uri.joinPath(root, where.path);
      msg.location = new vscode.Location(uri, sourcePosition(where));
    }
    return msg;
  };
  const messages = [at(new vscode.TestMessage(c.message ?? "test failed"))];
  // #2272: the declaration that refused the case, or a step of it. Each line opens
  // the declaration; one the driver could not place opens the case's own position.
  for (const note of declarationNotes(c, handlerAt)) {
    messages.push(at(new vscode.TestMessage(note.text), note.location ?? c.location));
  }
  // Slice C: a failed generative case also reports how to reproduce it as data,
  // in addition to the unchanged text above.
  if (c.counterexample) messages.push(at(new vscode.TestMessage(`Counterexample: ${c.counterexample}`)));
  if (c.seed) {
    messages.push(
      at(new vscode.TestMessage(`Seed: ${c.seed}. Use "Re-run with this seed" on the test to reproduce this failure.`)),
    );
  }
  return messages;
}
