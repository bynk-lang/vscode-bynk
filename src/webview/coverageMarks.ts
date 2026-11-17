// #144: the coverage overlay's DOM, shared by the agent state view and the
// sequence diagram (browser context; no `vscode`). The projection is
// `../modelCoverageCore.ts`; this puts its marks on the engine's drawn
// elements (found by `data-bynk-ref`, as diff marks and the cursor mark are)
// and builds the toggle and legend above the diagram.
//
// A mark is a CSS class (`bynk-cov-*`, styled in `diagram/style.ts`) plus a
// word on the element's accessible name and tooltip, so it never depends on
// colour alone.

import { type CoverageMark, coverageNote, MARK_WORD, type ModelCoverage } from "../modelCoverageCore";

/** Put `marks` (by `data-bynk-ref` id) on the matching elements of `container`. */
export function applyCoverageMarks(container: Element, marks: Readonly<Record<string, CoverageMark>>): void {
  const byRef = new Map<string, Element>();
  for (const el of container.querySelectorAll("[data-bynk-ref]")) {
    const id = el.getAttribute("data-bynk-ref");
    if (id !== null && !byRef.has(id)) byRef.set(id, el);
  }
  for (const [id, mark] of Object.entries(marks)) {
    if (mark === "unmeasured") continue;
    const el = byRef.get(id);
    if (!el) continue;
    el.classList.add(`bynk-cov-${mark}`);
    const word = MARK_WORD[mark];
    const name = el.getAttribute("aria-label");
    if (name !== null) el.setAttribute("aria-label", `${name}, ${word}`);
    const title = el.querySelector(":scope > title");
    if (title) title.textContent = `${title.textContent ?? ""}\n(${word})`;
  }
}

/** The toggle, the counts and the legend. `counts` are lines like "3 of 5
 *  transitions tested"; `onToggle` redraws. */
export function coverageBar(
  cov: ModelCoverage,
  counts: readonly string[],
  shown: boolean,
  onToggle: (shown: boolean) => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "bynk-cov-bar";
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = shown;
  box.id = "bynk-coverage-toggle";
  box.addEventListener("change", () => onToggle(box.checked));
  label.append(box, document.createTextNode(" Show test coverage"));
  bar.append(label);
  for (const c of counts) {
    const span = document.createElement("span");
    span.className = "bynk-cov-count";
    span.textContent = ` · ${c}`;
    bar.append(span);
  }
  const notes = document.createElement("div");
  notes.className = "bynk-cov-note";
  for (const line of coverageNote(cov, Date.now())) {
    const p = document.createElement("p");
    p.textContent = line;
    if (line.startsWith("The source has changed")) p.classList.add("bynk-cov-stale");
    notes.append(p);
  }
  bar.append(notes);
  return bar;
}
