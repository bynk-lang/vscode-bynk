// The diagram engine's shared interaction layer (model-diagrams track §4.6).
//
// It works on any drawn diagram whose elements carry `data-bynk-ref` (their IR
// id) and, when they link to source, `data-bynk-focusable`. Elements are found
// by id, never by DOM position or a renderer's internal naming.
//
// - Click, Enter or Space reveals the element's source.
// - Arrow keys, Home and End move focus between elements, in document order
//   (lifelines first, then events top to bottom). One element at a time is in
//   the tab order (a roving tabindex), so Tab enters and leaves the diagram in
//   one step.

import type { Range } from "../webview/types";

export interface DiagramHost {
  reveal(range: Range): void;
}

/** Wire `root`'s elements to `host`. `ranges` maps each IR id to its source. */
export function wireInteraction(root: SVGSVGElement, ranges: ReadonlyMap<string, Range>, host: DiagramHost): void {
  const focusables = (): SVGElement[] => Array.from(root.querySelectorAll<SVGElement>("[data-bynk-focusable]"));
  const all = focusables();
  if (all.length > 0) all[0].setAttribute("tabindex", "0");

  const target = (event: Event): SVGElement | null =>
    (event.target as Element | null)?.closest?.<SVGElement>("[data-bynk-focusable]") ?? null;

  const reveal = (el: SVGElement): void => {
    const range = ranges.get(el.getAttribute("data-bynk-ref") ?? "");
    if (range) host.reveal(range);
  };

  const move = (to: SVGElement): void => {
    for (const el of focusables()) el.setAttribute("tabindex", el === to ? "0" : "-1");
    to.focus();
  };

  root.addEventListener("click", (event) => {
    const el = target(event);
    if (!el) return;
    move(el);
    reveal(el);
  });

  root.addEventListener("keydown", (event: KeyboardEvent) => {
    const el = target(event);
    if (!el) return;
    const list = focusables();
    const i = list.indexOf(el);
    let next: SVGElement | undefined;
    switch (event.key) {
      case "Enter":
      case " ":
        reveal(el);
        event.preventDefault();
        return;
      case "ArrowDown":
      case "ArrowRight":
        next = list[Math.min(i + 1, list.length - 1)];
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = list[Math.max(i - 1, 0)];
        break;
      case "Home":
        next = list[0];
        break;
      case "End":
        next = list[list.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next && next !== el) move(next);
  });
}

/** The IR id of the diagram element that has focus inside `root`, if any. */
export function focusedRef(root: ParentNode): string | null {
  const active = (root as Node).ownerDocument?.activeElement ?? null;
  if (!active || !(root as Node).contains(active)) return null;
  return active.getAttribute("data-bynk-ref");
}

/** Give focus back to the element for `id` after a redraw, if it still exists. */
export function restoreFocus(root: SVGSVGElement, id: string | null): void {
  // IR ids are letters, digits and dots, so they quote safely in a selector.
  if (!id || !/^[\w.]+$/.test(id)) return;
  const el = root.querySelector<SVGElement>(`[data-bynk-focusable][data-bynk-ref="${id}"]`);
  if (!el) return;
  for (const other of root.querySelectorAll<SVGElement>("[data-bynk-focusable]")) {
    other.setAttribute("tabindex", other === el ? "0" : "-1");
  }
  el.focus();
}
