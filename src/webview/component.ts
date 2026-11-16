// @webview-entry
// Model-diagrams slice 5: the component view's bundle entry
// (`out/component.js`). Runs inside the webview's browser context.
//
// Reads the `ComponentPayload` the host embeds as
// `window.__BYNK_COMPONENT_MODEL__` (the project's architecture model and the
// unit to open up) and draws that unit as a UML component diagram with the
// diagram engine: `diagram/structure/component.ts` builds the structure IR,
// ELK lays it out (ports included), `structure/draw.ts` draws it.
//
// - Every element links to its source; pointing at one marks its source in
//   the editor.
// - An operation's ↗ opens its sequence diagram; a neighbouring context's ↗
//   opens that context's component view (track §9).
// - The service or agent under the editor's cursor is marked (the host
//   reports it as the view's focus).

import { focusedRef, initTabOrder, restoreFocus, wireInteraction } from "../diagram/interact";
import { canvasMeasurer, type TextMeasurer } from "../diagram/measure";
import { ids } from "../diagram/structure/architecture";
import { type ComponentLinks, toComponentDiagram } from "../diagram/structure/component";
import { drawStructure } from "../diagram/structure/draw";
import type { StructDiagram, StructNode } from "../diagram/structure/ir";
import { layoutStructure } from "../diagram/structure/layout";
import { ensureDiagramStyles } from "../diagram/style";
import { buildToolbar } from "../diagram/toolbar";
import type { Drawing } from "../diagram/viewport";
import { DiagramViewport } from "../diagram/viewport";
import type { ArchLoc, ArchRevealMessage, ComponentPayload } from "./architectureTypes";
import { startLiveView, type ViewState, type VsCodeApi } from "./live";

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();

function post(message: unknown): void {
  vscodeApi.postMessage(message);
}

function fontFamily(): string {
  const value = getComputedStyle(document.body).getPropertyValue("--vscode-font-family").trim();
  return value || "sans-serif";
}

let measurer: { font: string; measure: TextMeasurer } | undefined;
function measurerFor(font: string): TextMeasurer {
  if (measurer?.font !== font) measurer = { font, measure: canvasMeasurer(font) };
  return measurer.measure;
}

let payload: ComponentPayload | null = null;
let drawing: Drawing | undefined;
/** The service or agent under the editor's cursor. */
let focus: string | undefined;
/** Sources by IR id for the current drawing, refilled on each render. */
const locs = new Map<string, ArchLoc>();
let links: ComponentLinks = { sequences: new Map(), components: new Map() };

const viewport = new DiagramViewport(document);
const actionsBar = buildToolbar({
  viewport,
  post,
  drawing: () => (drawing && payload ? { drawing, name: `${payload.unit}-components` } : null),
  fontFamily,
});
let wired = false;

function reveal(loc: ArchLoc): void {
  const message: ArchRevealMessage = { type: "reveal", uri: loc.uri, range: loc.range };
  post(message);
}

/** A ↗: its ref is the element's id plus `.open`. */
function open(ref: string): void {
  const id = ref.replace(/\.open$/, "");
  const handler = links.sequences.get(id);
  if (handler) {
    post({ type: "openSequence", uri: handler.uri, range: handler.range });
    return;
  }
  const unit = links.components.get(id);
  const loc = unit ? payload?.model.nodes.find((n) => n.name === unit)?.loc : undefined;
  if (loc) post({ type: "openComponent", uri: loc.uri, range: loc.range });
}

function locsOf(diagram: StructDiagram): Map<string, ArchLoc> {
  const out = new Map<string, ArchLoc>();
  const walk = (ns: StructNode[]): void => {
    for (const n of ns) {
      if (n.ref.loc) out.set(n.ref.id, n.ref.loc);
      for (const i of n.items ?? []) if (i.ref.loc) out.set(i.ref.id, i.ref.loc);
      for (const p of n.ports ?? []) if (p.ref.loc) out.set(p.ref.id, p.ref.loc);
      walk(n.children);
    }
  };
  walk(diagram.nodes);
  for (const e of diagram.edges) if (e.ref.loc) out.set(e.ref.id, e.ref.loc);
  return out;
}

/** Mark the part the editor's cursor is in. */
function markFocus(): void {
  for (const el of viewport.element.querySelectorAll(".bynk-current")) el.classList.remove("bynk-current");
  if (!focus || !payload) return;
  const parts = new Set([ids.service(payload.unit, focus), ids.agent(payload.unit, focus)]);
  for (const el of viewport.element.querySelectorAll("[data-bynk-ref]")) {
    if (parts.has(el.getAttribute("data-bynk-ref") ?? "")) el.classList.add("bynk-current");
  }
}

async function render(root: HTMLElement, next: ComponentPayload | null): Promise<void> {
  payload = next;
  const view = next ? toComponentDiagram(next.model, next.unit) : null;
  if (!next || !view) {
    drawing = undefined;
    root.textContent = "No context or adapter to show.";
    return;
  }
  ensureDiagramStyles(document);
  const keep = focusedRef(viewport.element);
  const font = fontFamily();
  try {
    const scene = await layoutStructure(view.diagram, measurerFor(font));
    drawing = drawStructure(scene, { title: `Components of ${next.unit}`, fontFamily: font });
  } catch (err) {
    drawing = undefined;
    root.textContent = `Failed to render diagram: ${String(err)}`;
    return;
  }
  links = view.links;
  locs.clear();
  for (const [id, loc] of locsOf(view.diagram)) locs.set(id, loc);

  if (actionsBar.parentElement !== root || viewport.element.parentElement !== root) {
    root.replaceChildren(actionsBar, viewport.element);
    document.body.appendChild(viewport.minimapElement);
  }
  if (!wired) {
    wired = true;
    wireInteraction<ArchLoc>(viewport.element, locs, {
      reveal,
      open,
      hover: (loc) => post({ type: "highlight", uri: loc?.uri ?? "", range: loc?.range ?? null }),
    });
  }
  viewport.show(drawing);
  initTabOrder(viewport.element);
  restoreFocus(viewport.element, keep);
  markFocus();
}

startLiveView<ComponentPayload>(vscodeApi, "__BYNK_COMPONENT_MODEL__", render, (view: ViewState) => {
  focus = view.focus;
  markFocus();
});
