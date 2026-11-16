// The diagram engine's shared interaction layer (model-diagrams track §4.6).
//
// It works on any drawn diagram whose elements carry `data-bynk-ref` (their IR
// id) and, when they link to source, `data-bynk-focusable`. Elements are found
// by id, never by DOM position or a renderer's internal naming.
//
// - Click or Enter reveals the element's source. Space does too, except on a
//   foldable element (a fragment's tab), where it folds or unfolds; so does a
//   click on the fold toggle (`data-bynk-fold-toggle`).
// - Arrow keys, Home and End move focus between elements, in document order
//   (lifelines first, then events top to bottom). One element at a time is in
//   the tab order (a roving tabindex), so Tab enters and leaves the diagram in
//   one step.
// - Hovering or focusing an element tells the host its source range, so the
//   editor can mark it (and `null` when that ends).
//
// The root is any element: the sequence view's viewport holds two SVGs (the
// pinned lifeline heads and the body), and navigation runs across both.

import type { Range } from "../webview/types";

/** What a diagram's host does with its elements. `T` is an element's source:
 *  a `Range` in the one file a sequence diagram shows, or a `{uri, range}` in
 *  a project-wide diagram (the architecture map). */
export interface DiagramHost<T = Range> {
  reveal(target: T): void;
  /** Fold or unfold the fragment with IR id `id`. */
  toggleFold?(id: string): void;
  /** The source of the element under the pointer or focus; `null` when none. */
  hover?(target: T | null): void;
  /** Open what an element marked `data-bynk-open` (IR id `id`) leads to:
   *  the callee's own diagram, for a `ref` link. */
  open?(id: string): void;
}

/** Put the first element in the tab order (after a redraw replaced them). */
export function initTabOrder(root: Element): void {
  const first = root.querySelector<SVGElement>("[data-bynk-focusable]");
  if (first && !root.querySelector('[data-bynk-focusable][tabindex="0"]')) first.setAttribute("tabindex", "0");
}

/** Wire `root`'s elements to `host`, once: the handlers find elements as
 *  events arrive, so `root`'s drawing can be replaced underneath them (call
 *  `initTabOrder` after each). `ranges` maps each IR id to its source; it is
 *  read at event time, so a caller may refill it on each redraw. */
export function wireInteraction<T = Range>(root: Element, ranges: ReadonlyMap<string, T>, host: DiagramHost<T>): void {
  const focusables = (): SVGElement[] => Array.from(root.querySelectorAll<SVGElement>("[data-bynk-focusable]"));
  initTabOrder(root);

  const target = (event: Event): SVGElement | null =>
    (event.target as Element | null)?.closest?.<SVGElement>("[data-bynk-focusable]") ?? null;

  const reveal = (el: SVGElement): void => {
    const id = el.getAttribute("data-bynk-ref") ?? "";
    if (el.hasAttribute("data-bynk-open")) {
      host.open?.(id);
      return;
    }
    const range = ranges.get(id);
    if (range) host.reveal(range);
  };

  const move = (to: SVGElement): void => {
    for (const el of focusables()) el.setAttribute("tabindex", el === to ? "0" : "-1");
    to.focus();
  };

  root.addEventListener("click", (event) => {
    const fold = (event.target as Element | null)?.closest?.("[data-bynk-fold-toggle]");
    if (fold && host.toggleFold) {
      host.toggleFold(fold.getAttribute("data-bynk-fold-toggle") ?? "");
      return;
    }
    const el = target(event);
    if (!el) return;
    move(el);
    reveal(el);
  });

  let hovered: string | null = null;
  const hover = (el: SVGElement | null): void => {
    const id = el?.getAttribute("data-bynk-ref") ?? null;
    if (id === hovered || !host.hover) return;
    hovered = id;
    host.hover(id ? ranges.get(id) ?? null : null);
  };
  root.addEventListener("mouseover", (event) => hover(target(event)));
  root.addEventListener("mouseleave", () => hover(null));
  root.addEventListener("focusin", (event) => hover(target(event)));
  root.addEventListener("focusout", (event) => {
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (!next || !root.contains(next)) hover(null);
  });

  root.addEventListener("keydown", (e: Event) => {
    const event = e as KeyboardEvent;
    const el = target(event);
    if (!el) return;
    const list = focusables();
    const i = list.indexOf(el);
    let next: SVGElement | undefined;
    switch (event.key) {
      case " ": {
        const foldable = el.getAttribute("data-bynk-foldable");
        if (foldable && host.toggleFold) host.toggleFold(foldable);
        else reveal(el);
        event.preventDefault();
        return;
      }
      case "Enter":
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
export function restoreFocus(root: Element, id: string | null): void {
  // IR ids are letters, digits and dots, so they quote safely in a selector.
  if (!id || !/^[\w.]+$/.test(id)) return;
  const el = root.querySelector<SVGElement>(`[data-bynk-focusable][data-bynk-ref="${id}"]`);
  if (!el) return;
  for (const other of root.querySelectorAll<SVGElement>("[data-bynk-focusable]")) {
    other.setAttribute("tabindex", other === el ? "0" : "-1");
  }
  el.focus();
}
