// @webview-entry
// #851: the architecture-map webview's own bundle entry (`out/architecture.js`).
// Runs inside the webview's browser context, never the extension host.
//
// Model-diagrams slice 4: the map is drawn by the diagram engine, not
// Mermaid. `diagram/structure/architecture.ts` turns the `ArchModel` the host
// embeds as `window.__BYNK_ARCH_MODEL__` into a system view: the project's
// contexts and adapters as UML components inside a system boundary, their
// `consumes` dependencies (cycles marked), the actors that call in, the
// platform units capabilities are bound from, and events. ELK lays it out
// (`structure/layout.ts`); `structure/draw.ts` draws it.
//
// - A unit opens in place (its fold toggle, or Space on it) to show its
//   services, agents, capabilities and providers inside it (ADR 0302's
//   context-level default). Which units are open is kept across live updates.
// - Every element links to its source by identity, through the shared
//   interaction layer; pointing at one marks its source in the editor.
// - A unit's ↗ opens its component view (slice 5).
// - The shared viewport and toolbar: zoom, pan, minimap, Copy as Mermaid
//   (`architecture-gen.ts`, now an exporter), Save as SVG or PNG, and a toggle
//   for events.

import { focusedRef, initTabOrder, restoreFocus, wireInteraction } from "../diagram/interact";
import { canvasMeasurer, type TextMeasurer } from "../diagram/measure";
import { toArchitectureDiagram } from "../diagram/structure/architecture";
import { drawStructure } from "../diagram/structure/draw";
import type { StructDiagram, StructNode } from "../diagram/structure/ir";
import { layoutStructure } from "../diagram/structure/layout";
import { ensureDiagramStyles } from "../diagram/style";
import { buildToolbar, toolbarButton } from "../diagram/toolbar";
import type { Drawing } from "../diagram/viewport";
import { DiagramViewport } from "../diagram/viewport";
import { toMermaidArch } from "./architecture-gen";
import type { ArchLoc, ArchPayload, ArchRevealMessage } from "./architectureTypes";
import { type LiveView, startLiveView, type VsCodeApi } from "./live";

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

// -- Page state, kept across live updates (not across a reload). --

let live: LiveView | undefined;
let payload: ArchPayload | null = null;
let drawing: Drawing | undefined;
/** Which units the reader opened (names that no longer exist match nothing). */
const expanded = new Set<string>();
let showEvents = true;
/** Sources by IR id for the current drawing, refilled on each render. */
const locs = new Map<string, ArchLoc>();

const viewport = new DiagramViewport(document);
const eventsToggle = toolbarButton("Events", "Show or hide events and who emits and subscribes to them", "bynk-toggle-events", () => {
  showEvents = !showEvents;
  live?.rerender();
});
const actionsBar = buildToolbar({
  viewport,
  post,
  mermaid: () => (payload ? toMermaidArch(payload.model, expanded).text : null),
  drawing: () => (drawing ? { drawing, name: "architecture" } : null),
  fontFamily,
  extra: [eventsToggle],
});
let wired = false;

function reveal(loc: ArchLoc): void {
  const message: ArchRevealMessage = { type: "reveal", uri: loc.uri, range: loc.range };
  post(message);
}

function toggleFold(id: string): void {
  if (!id.startsWith("u:")) return;
  const name = id.slice(2);
  if (expanded.has(name)) expanded.delete(name);
  else expanded.add(name);
  live?.rerender();
}

/** Every IR id with a source, for the interaction layer. */
function locsOf(diagram: StructDiagram): Map<string, ArchLoc> {
  const out = new Map<string, ArchLoc>();
  const walk = (ns: StructNode[]): void => {
    for (const n of ns) {
      if (n.ref.loc) out.set(n.ref.id, n.ref.loc);
      walk(n.children);
    }
  };
  walk(diagram.nodes);
  for (const e of diagram.edges) if (e.ref.loc) out.set(e.ref.id, e.ref.loc);
  return out;
}

async function render(root: HTMLElement, next: ArchPayload | null): Promise<void> {
  payload = next;
  if (!next || next.model.nodes.length === 0) {
    drawing = undefined;
    root.textContent = "No contexts found in this project.";
    return;
  }
  ensureDiagramStyles(document);
  const hasEvents = (next.model.events ?? []).some((e) => e.emitters.length + e.subscribers.length > 0);
  eventsToggle.hidden = !hasEvents;
  eventsToggle.setAttribute("aria-pressed", String(showEvents));

  const keep = focusedRef(viewport.element);
  const font = fontFamily();
  let diagram: StructDiagram;
  try {
    diagram = toArchitectureDiagram(next.model, { expanded, events: showEvents });
    const scene = await layoutStructure(diagram, measurerFor(font));
    drawing = drawStructure(scene, { title: "Architecture map", fontFamily: font });
  } catch (err) {
    drawing = undefined;
    root.textContent = `Failed to render diagram: ${String(err)}`;
    return;
  }
  locs.clear();
  for (const [id, loc] of locsOf(diagram)) locs.set(id, loc);

  if (actionsBar.parentElement !== root || viewport.element.parentElement !== root) {
    root.replaceChildren(actionsBar, viewport.element);
    document.body.appendChild(viewport.minimapElement);
  }
  if (!wired) {
    wired = true;
    wireInteraction<ArchLoc>(viewport.element, locs, {
      reveal,
      toggleFold,
      // Model-diagrams slice 5: a unit's ↗ opens its component view.
      open: (ref) => {
        const id = ref.replace(/\.open$/, "");
        const unit = id.startsWith("u:") ? payload?.model.nodes.find((n) => n.name === id.slice(2)) : undefined;
        if (unit) post({ type: "openComponent", uri: unit.loc.uri, range: unit.loc.range });
      },
      hover: (loc) => post({ type: "highlight", uri: loc?.uri ?? "", range: loc?.range ?? null }),
    });
  }
  viewport.show(drawing);
  initTabOrder(viewport.element);
  restoreFocus(viewport.element, keep);
}

live = startLiveView<ArchPayload>(vscodeApi, "__BYNK_ARCH_MODEL__", render);
