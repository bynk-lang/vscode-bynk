// What the Test Explorer remembers about generative-test seeds: pins, the latest
// failing seed per case, and each suite's generative cases. Split out of `testing.ts`.

import type * as vscode from "vscode";

import { caseKey, type TestRun } from "./testPlan";
import { pinDescription, pinState, validSeed, type Pin, type SeedFailure } from "./testSeeds";
import { forEachCase, suiteIdOf } from "./testTree";

/** The key under which a workspace remembers its pinned seeds. */
export const PINS_KEY = "bynk.test.pins";

/** What the controller remembers about seeds: pins (kept in workspace state, never
 *  in `bynk.toml` or source, so a pin never freezes a property for anyone else),
 *  the seed each case's latest failure reported, and each suite's generative
 *  cases as discovery last listed them (a pin's fingerprint). */
export interface SeedState {
  pins: Map<string, Pin>;
  failures: Map<string, SeedFailure>;
  generative: Map<string, string[]>;
  store: vscode.Memento;
}


export function loadPins(store: vscode.Memento): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  const raw = store.get<Record<string, unknown>>(PINS_KEY) ?? {};
  for (const [key, v] of Object.entries(raw)) {
    const pin = v as Partial<Pin> | undefined;
    if (pin && validSeed(pin.seed) && Array.isArray(pin.fingerprint)) {
      pins.set(key, { seed: pin.seed, fingerprint: pin.fingerprint.map(String) });
    }
  }
  return pins;
}

export function savePins(state: SeedState): Thenable<void> {
  return state.store.update(PINS_KEY, Object.fromEntries(state.pins));
}

/** The generative cases of the suite a case key belongs to. */
export function suiteFingerprint(state: SeedState, key: string): string[] {
  return state.generative.get(key.slice(0, key.indexOf("::"))) ?? [];
}

/** Show each pin beside its test: its seed, or that it is stale. */
export function describePins(ctrl: vscode.TestController, state: SeedState): void {
  forEachCase(ctrl, (c) => {
    const pin = state.pins.get(c.id);
    c.description = pin ? pinDescription(pin, pinState(pin, suiteFingerprint(state, c.id))) : undefined;
  });
}

/** Remember the seed each reported case's latest run gave: a failed generative
 *  case's, which "Re-run with this seed" and "Pin this seed" use, replacing an
 *  earlier one; a pass or a case without one clears it. */
export function rememberSeeds(seeds: SeedState, doc: TestRun, reported: ReadonlySet<string>, root: vscode.Uri): void {
  for (const suite of doc.suites ?? []) {
    for (const c of suite.cases) {
      const key = caseKey(suiteIdOf(suite, root.toString()), c.name);
      if (!reported.has(key)) continue;
      if (validSeed(c.seed)) seeds.failures.set(key, { seed: c.seed, counterexample: c.counterexample });
      else seeds.failures.delete(key);
    }
  }
}
